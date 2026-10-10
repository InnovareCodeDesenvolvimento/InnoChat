import { test, expect } from "@playwright/test";
import { prisma } from "./fixtures/db";
import { E2E_RUN_PREFIX, SEED_OWNER_EMAIL } from "./fixtures/test-data";
import { startFakeSmtpServer, extractFirstUrl } from "./fixtures/fake-smtp-server";
import { enableFakeGoogle, readGoogleRow, restoreGoogleRow } from "./fixtures/google-config";
import { cleanupSignup, expectLeftCadastro, fillCadastro, tenantOfEmail } from "./fixtures/cadastro";

/**
 * `/cadastro` ponta a ponta (docs/plano-cadastro-sem-friccao.md): formulário curto (empresa, nome,
 * WhatsApp, e-mail, senha e aceite), endereço gerado pelo servidor, sessão aberta na hora, honeypot,
 * sugestão de e-mail, Google escondido no navegador do Instagram e a medida do formulário no celular.
 * Sem SMTP configurado o cadastro não pode quebrar (`sendMail` nunca lança); com um SMTP fake local,
 * valida o link de verificação e o "esqueci a senha" de ponta a ponta (o token só existe em texto
 * puro dentro do link — o banco guarda só o hash).
 *
 * Todo escopo de tela usa `getByRole("main")`: a rota tem `loading.tsx` e o streaming deixa uma
 * cópia oculta do conteúdo no DOM, então o rótulo apareceria duas vezes.
 */

type SmtpSnapshot = {
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean | null;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpFrom: string | null;
};

async function readSmtpSnapshot(): Promise<SmtpSnapshot> {
  return prisma.platformSettings.findUniqueOrThrow({
    where: { id: 1 },
    select: { smtpHost: true, smtpPort: true, smtpSecure: true, smtpUser: true, smtpPassword: true, smtpFrom: true },
  });
}

async function writeSmtpSnapshot(snapshot: SmtpSnapshot): Promise<void> {
  await prisma.platformSettings.update({ where: { id: 1 }, data: snapshot });
}

// O servidor normaliza o e-mail para minúsculas; `E2E_RUN_PREFIX` tem o marcador em MAIÚSCULAS, então
// o local-part do e-mail usa a versão minúscula (senão o nosso lookup nunca bate com o gravado).
const RUN_PREFIX_LC = E2E_RUN_PREFIX.toLowerCase();
const mail = (tag: string) => `${RUN_PREFIX_LC}-${tag}@e2e.innochat.local`;
const CREATED_EMAILS: string[] = [];
const track = (email: string) => {
  CREATED_EMAILS.push(email);
  return email;
};

const localPath = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

const INSTAGRAM_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-A546E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Mobile Safari/537.36 Instagram 310.0.0.37.109 Android (33/13; 420dpi; 1080x2340; samsung; SM-A546E; a54x; s5e8835; pt_BR; 543798905)";

const FACEBOOK_IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21B74 [FBAN/FBIOS;FBAV/440.0.0.30.113;FBBV/512345;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.1;FBLC/pt_BR;FBOP/5]";

test.describe("Cadastro público (/cadastro) ponta a ponta", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  let originalSmtp: SmtpSnapshot;

  test.beforeAll(async () => {
    originalSmtp = await readSmtpSnapshot();
  });

  test.afterAll(async () => {
    await writeSmtpSnapshot(originalSmtp);
    await cleanupSignup(CREATED_EMAILS);
  });

  test("o formulário só tem os 5 campos, sem endereço, segmento, CPF/CNPJ, confirmar senha, ciclo nem cupom digitável", async ({ page }) => {
    await page.goto("/cadastro");
    const main = page.getByRole("main");
    for (const label of ["Nome da empresa", "Seu nome", "Seu WhatsApp", "E-mail *", "Senha *"]) {
      await expect(main.getByLabel(label, { exact: label.endsWith("*") })).toBeVisible();
    }
    for (const gone of ["Endereço da empresa", "Segmento", "CPF ou CNPJ", "Confirmar senha", "Cupom de desconto"]) {
      await expect(main.getByLabel(gone)).toHaveCount(0);
    }
    await expect(main.getByTestId("signup-cobranca")).toHaveCount(0);
    await expect(main.getByRole("heading", { name: "Crie sua conta grátis" })).toBeVisible();
  });

  test("WhatsApp é obrigatório e a máscara formata enquanto digita; número inválido tem mensagem no campo", async ({ page }) => {
    const email = mail("zap-vazio");
    await fillCadastro(page, { email, phone: "" });
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "Criar conta grátis" }).click();
    await expect(main.getByText("Informe seu WhatsApp.").first()).toBeVisible();
    expect(await prisma.user.count({ where: { email } })).toBe(0);

    const phone = main.getByLabel("Seu WhatsApp");
    await phone.fill("84999998888");
    await expect(phone).toHaveValue("(84) 99999-8888");
    await phone.fill("1234");
    await main.getByRole("button", { name: "Criar conta grátis" }).click();
    await expect(main.getByText("Confira o WhatsApp: DDD e número, como (84) 99999-8888.").first()).toBeVisible();
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  test("sem aceitar os termos, a mensagem aparece e nada é criado; nome é obrigatório e limitado a 80 caracteres", async ({ page }) => {
    const email = mail("sem-aceite");
    await fillCadastro(page, { email, accept: false, name: "" });
    const main = page.getByRole("main");
    await expect(main.getByLabel("Seu nome")).toHaveAttribute("maxlength", "80");
    await main.getByRole("button", { name: "Criar conta grátis" }).click();
    await expect(main.getByText("Informe seu nome (pelo menos 2 letras).")).toBeVisible();
    await expect(main.getByText("É preciso aceitar os termos e a privacidade.")).toBeVisible();
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  test("e-mail com domínio digitado errado sugere a correção com um toque, e só sugere", async ({ page }) => {
    await page.goto("/cadastro");
    const main = page.getByRole("main");
    const emailField = main.getByLabel("E-mail *", { exact: true });
    await emailField.fill("ana@gmial.com");
    await emailField.blur();
    const hint = main.getByTestId("cadastro-sugestao-email");
    await expect(hint).toContainText("Você quis dizer");
    await hint.getByRole("button", { name: "ana@gmail.com" }).click();
    await expect(emailField).toHaveValue("ana@gmail.com");
    await expect(hint).toHaveCount(0);

    // Domínio próprio nunca recebe sugestão.
    await emailField.fill("contato@salaobela.com.br");
    await emailField.blur();
    await expect(hint).toHaveCount(0);
  });

  test("senha única com mostrar/ocultar (aria-pressed), sem segundo campo de senha", async ({ page }) => {
    await page.goto("/cadastro");
    const main = page.getByRole("main");
    const password = main.getByLabel("Senha *", { exact: true });
    await password.fill("segredo-123");
    await expect(password).toHaveAttribute("type", "password");
    const toggle = main.getByRole("button", { name: "Mostrar o texto digitado" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(password).toHaveAttribute("type", "text");
    await expect(main.getByRole("button", { name: "Ocultar o texto digitado" })).toHaveAttribute("aria-pressed", "true");
  });

  test("honeypot: campo escondido, fora do teclado e do leitor de tela, sem autopreenchimento", async ({ page }) => {
    await page.goto("/cadastro");
    const trap = page.getByRole("main").locator('input[name="hp_confirm_field"]');
    await expect(trap).toHaveCount(1);
    await expect(trap).toHaveAttribute("autocomplete", "off");
    const info = await trap.evaluate((el) => ({
      ariaHiddenAncestor: !!el.closest('[aria-hidden="true"]'),
      inertAncestor: !!el.closest("[inert]"),
      tabindex: el.getAttribute("tabindex"),
      left: el.getBoundingClientRect().right,
    }));
    expect(info.ariaHiddenAncestor).toBe(true);
    expect(info.inertAncestor).toBe(true);
    expect(info.tabindex).toBeNull();
    expect(info.left).toBeLessThan(0); // fora da tela
  });

  test("honeypot preenchido (robô): nenhuma conta é criada", async ({ page }) => {
    const email = mail("robo");
    await fillCadastro(page, { email });
    await page.getByRole("main").locator('input[name="hp_confirm_field"]').evaluate((el: HTMLInputElement) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(el, "http://spam.example");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.getByRole("main").getByRole("button", { name: "Criar conta grátis" }).click();
    // O robô recebe uma resposta de sucesso, mas nada foi gravado.
    await page.waitForTimeout(2_500);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  test("cadastro válido: endereço automático, WhatsApp gravado, sem CPF/CNPJ e a sessão abre direto no painel", async ({ page }) => {
    const email = track(mail("valido"));
    await fillCadastro(page, { email, companyName: `${E2E_RUN_PREFIX} Salão Aurora` });
    await page.getByRole("main").getByRole("button", { name: "Criar conta grátis" }).click();
    await expectLeftCadastro(page);

    const tenant = await tenantOfEmail(email);
    expect(tenant.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(tenant.slug).toContain("salao-aurora");
    expect(tenant.document).toBeNull();
    expect(tenant.billingWhatsappE164).toBe("5584999998888");
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.termsAcceptedAt).not.toBeNull();
    expect(user.name).toBe("Dona da Empresa E2E");
    // Sessão aberta: uma rota do painel responde sem mandar para o login.
    await page.goto(`/${tenant.slug}/inicio`);
    await expect(page).toHaveURL(new RegExp(`/${tenant.slug}/`));
  });

  test("duas empresas com o mesmo nome ganham endereços diferentes (o segundo ganha sufixo)", async ({ context, browser }) => {
    const name = `${E2E_RUN_PREFIX} Barbearia Gêmea`;
    const first = track(mail("gemea-1"));
    const second = track(mail("gemea-2"));

    const page1 = await context.newPage();
    await fillCadastro(page1, { email: first, companyName: name });
    await page1.getByRole("main").getByRole("button", { name: "Criar conta grátis" }).click();
    await expectLeftCadastro(page1);

    const otherContext = await browser.newContext();
    const page2 = await otherContext.newPage();
    await fillCadastro(page2, { email: second, companyName: name });
    await page2.getByRole("main").getByRole("button", { name: "Criar conta grátis" }).click();
    await expectLeftCadastro(page2);
    await otherContext.close();

    const a = await tenantOfEmail(first);
    const b = await tenantOfEmail(second);
    expect(a.slug).not.toBe(b.slug);
    expect(b.slug.startsWith(a.slug)).toBe(true);
  });

  test("e-mail que já tem conta: mensagem no campo com os atalhos Entrar e Esqueci a senha", async ({ page }) => {
    await fillCadastro(page, { email: SEED_OWNER_EMAIL });
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "Criar conta grátis" }).click();
    await expect(main.getByText("Já existe uma conta com este e-mail.").first()).toBeVisible();
    const shortcuts = main.getByTestId("cadastro-email-existente");
    await expect(shortcuts.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/login");
    await expect(shortcuts.getByRole("link", { name: "Esqueci a senha" })).toHaveAttribute("href", "/recuperar-senha");
  });

  test("e-mail descartável: pede um e-mail de verdade e não cria a conta", async ({ page }) => {
    const email = `${RUN_PREFIX_LC}-descartavel@mailinator.com`;
    await fillCadastro(page, { email });
    const main = page.getByRole("main");
    await main.getByRole("button", { name: "Criar conta grátis" }).click();
    await expect(main.getByText("Use um e-mail que você acessa sempre", { exact: false }).first()).toBeVisible();
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  test("navegador do Instagram: o Google vira 'Continuar com Google' (abre fora do Instagram), o formulário segue e o link leva cupom e campanha", async ({ browser }) => {
    test.setTimeout(100_000); // o servidor guarda a configuração do Google por 30 s
    const original = await readGoogleRow();
    await enableFakeGoogle();
    try {
      for (const [label, ua, expected] of [
        ["Android", INSTAGRAM_UA, /^intent:\/\/[^/]+\/cadastro\?cupom=ABC&utm_source=ig&fbclid=xyz&via=google#Intent;scheme=https;package=com\.android\.chrome;S\.browser_fallback_url=https%3A%2F%2F[^;]+;end$/],
        ["iPhone", FACEBOOK_IOS_UA, /^x-safari-https:\/\/[^/]+\/cadastro\?cupom=ABC&utm_source=ig&fbclid=xyz&via=google$/],
      ] as const) {
        const context = await browser.newContext({ userAgent: ua, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const page = await context.newPage();
        await expect
          .poll(
            async () => {
              await page.goto("/cadastro?cupom=ABC&utm_source=ig&fbclid=xyz&error=x&token=segredo");
              return page.getByRole("main").getByTestId("cadastro-google-externo-link").count();
            },
            { timeout: 60_000, intervals: [2_000] },
          )
          .toBe(1);
        const main = page.getByRole("main");
        // Nenhum botão do Google que levaria ao erro 403; o caminho principal (formulário) continua à vista.
        await expect(main.getByRole("button", { name: /Google/ })).toHaveCount(0);
        await expect(main.getByLabel("Nome da empresa"), label).toBeVisible();
        const link = main.getByTestId("cadastro-google-externo-link");
        await expect(link).toHaveText("Continuar com Google");
        const href = await link.getAttribute("href");
        expect(href, label).toMatch(expected);
        expect(href, "dados que não são de campanha não viajam").not.toContain("segredo");
        // O botão não passa por baixo do formulário nem deixa a página rolar para o lado.
        const form = await main.getByRole("button", { name: "Criar conta grátis" }).boundingBox();
        const external = await link.boundingBox();
        expect(external!.y).toBeGreaterThan(form!.y + form!.height);
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

        // Se o sistema não abrir o outro navegador em ~1,5 s, aparece o passo manual.
        await page.evaluate(() => document.addEventListener("click", (e) => e.preventDefault(), { capture: true }));
        await link.click();
        await expect(main.getByTestId("cadastro-google-externo-dica")).toContainText("Toque em ⋯", { timeout: 4_000 });
        await expect(main.getByTestId("cadastro-google-externo-copiar")).toHaveText("Copiar link");
        await context.close();
      }
    } finally {
      await restoreGoogleRow(original);
    }
  });

  test("navegador do Instagram sem Google ligado: só o formulário, sem botão nem dica", async ({ browser }) => {
    test.setTimeout(100_000); // o teste anterior acabou de desligar o Google e o servidor guarda a configuração por 30 s
    const context = await browser.newContext({ userAgent: INSTAGRAM_UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const main = page.getByRole("main");
    await expect
      .poll(
        async () => {
          await page.goto("/cadastro");
          await expect(main.getByLabel("Nome da empresa")).toBeVisible();
          return main.getByTestId("cadastro-google-externo").count();
        },
        { timeout: 60_000, intervals: [3_000] },
      )
      .toBe(0);
    await expect(main.getByRole("button", { name: /Google/ })).toHaveCount(0);
    await context.close();
  });

  test("com ?via=google no navegador do sistema, o Google inicia sozinho uma vez; voltando com erro, não repete", async ({ page }) => {
    test.setTimeout(100_000);
    const original = await readGoogleRow();
    await enableFakeGoogle();
    try {
      await expect
        .poll(
          async () => {
            await page.goto("/cadastro");
            return page.getByRole("main").getByRole("button", { name: "Cadastrar com Google" }).count();
          },
          { timeout: 60_000, intervals: [2_000] },
        )
        .toBe(1);
      // O envio vai ao Auth.js (que tentaria o Google de verdade): intercepta e conta.
      let starts = 0;
      await page.route("**/*", async (route) => {
        const req = route.request();
        if (req.method() === "POST" && req.headers()["next-action"]) starts += 1;
        if (req.url().includes("accounts.google.com")) return route.abort();
        return route.continue();
      });
      await page.goto("/cadastro?via=google");
      await expect.poll(() => starts, { timeout: 8_000 }).toBeGreaterThanOrEqual(1);
      const first = starts;
      await page.goto("/cadastro?via=google");
      await page.waitForTimeout(2_000);
      expect(starts, "segunda abertura na mesma aba não repete").toBe(first);
    } finally {
      await restoreGoogleRow(original);
    }
  });

  test("celular 390x844: primeiro campo na primeira tela, botão a no máximo uma rolagem e sem rolagem lateral", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    // Escolha de cookies já feita: aqui mede só o formulário (o banner tem teste próprio no spec do Pixel).
    await page.addInitScript(() => window.localStorage.setItem("innochat-consent-meta", JSON.stringify({ v: 1, choice: "denied", at: new Date().toISOString() })));
    await page.goto("/cadastro");
    const main = page.getByRole("main");
    await expect(main.getByLabel("Nome da empresa")).toBeVisible();
    const first = await main.getByLabel("Nome da empresa").boundingBox();
    const button = await main.getByRole("button", { name: "Criar conta grátis" }).boundingBox();
    expect(first, "campo da empresa").not.toBeNull();
    expect(button, "botão").not.toBeNull();
    // Primeiro campo inteiro dentro da primeira tela (sem rolar).
    expect(first!.y + first!.height).toBeLessThanOrEqual(844);
    // Botão a no máximo uma tela de distância (uma rolagem).
    expect(button!.y + button!.height).toBeLessThanOrEqual(844 * 2);
    // Campos de 16 px: abaixo disso o iPhone dá zoom ao focar.
    const fontSize = await main.getByLabel("Seu nome").evaluate((el) => getComputedStyle(el).fontSize);
    expect(parseFloat(fontSize)).toBeGreaterThanOrEqual(16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await context.close();
  });

  test("sem SMTP configurado, o cadastro conclui normalmente (e-mail de verificação só falha em silêncio)", async ({ page }) => {
    await writeSmtpSnapshot({ smtpHost: null, smtpPort: null, smtpSecure: null, smtpUser: null, smtpPassword: null, smtpFrom: null });
    const email = track(mail("sem-smtp"));
    await fillCadastro(page, { email });
    await page.getByRole("main").getByRole("button", { name: "Criar conta grátis" }).click();
    await expectLeftCadastro(page);

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user?.emailVerifiedAt).toBeNull(); // ninguém confirmou nada: sem SMTP não saiu e-mail, e o cadastro segue de pé.
    expect(await tenantOfEmail(email)).toBeTruthy();
  });

  test("com SMTP fake: captura o e-mail de verificação, confirma pelo link; o link de redefinição abre a página certa", async ({ page, context }) => {
    const fakeSmtp = await startFakeSmtpServer();
    const email = track(mail("com-smtp"));

    try {
      await writeSmtpSnapshot({
        smtpHost: "127.0.0.1",
        smtpPort: fakeSmtp.port,
        smtpSecure: false,
        smtpUser: null,
        smtpPassword: null,
        smtpFrom: "nao-responda@e2e.innochat.local",
      });

      await fillCadastro(page, { email });
      await page.getByRole("main").getByRole("button", { name: "Criar conta grátis" }).click();
      await expectLeftCadastro(page);

      // O cadastro também pode disparar outros e-mails no mesmo SMTP fake: procura o que tem o link de verificação.
      await expect
        .poll(() => fakeSmtp.mails.some((m) => extractFirstUrl(m.data)?.includes("/verificar-email")), { timeout: 10_000 })
        .toBe(true);
      const verifyMail = fakeSmtp.mails.find((m) => extractFirstUrl(m.data)?.includes("/verificar-email"))!;
      expect(verifyMail.to[0]).toContain(email);
      const verifyUrl = extractFirstUrl(verifyMail.data);
      expect(verifyUrl).toContain("/verificar-email?token=");

      await page.goto(localPath(verifyUrl!)); // o host do link vem da configuração da plataforma; o teste fica no servidor que está rodando
      await expect(page.getByText("E-mail confirmado!").first()).toBeVisible();
      const verifiedUser = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(verifiedUser.emailVerifiedAt).not.toBeNull();

      // --- "Esqueci a senha" (sem sessão aberta, como quem esqueceu de verdade) ---
      await context.clearCookies();
      fakeSmtp.mails.length = 0;
      await page.goto("/recuperar-senha");
      await page.getByLabel("E-mail").fill(email);
      await page.getByRole("button", { name: "Enviar link" }).click();
      await expect(page.getByText("Verifique seu e-mail").first()).toBeVisible();

      await expect.poll(() => fakeSmtp.mails.length, { timeout: 10_000 }).toBeGreaterThan(0);
      const resetUrl = extractFirstUrl(fakeSmtp.mails[0].data);
      expect(resetUrl).toContain("/redefinir-senha?token=");
      const linkResponse = await page.goto(localPath(resetUrl!));
      expect(linkResponse?.status()).toBe(200);
      await page.getByLabel("Nova senha *", { exact: true }).fill("senha-e2e-nova-2026");
      await page.getByLabel("Confirmar nova senha").fill("senha-e2e-nova-2026");
      await page.getByRole("button", { name: "Salvar nova senha" }).click();
      await expect(page).toHaveURL(/\/login\?redefinida=1/);

      // A senha nova de fato passa a valer.
      const tenant = await tenantOfEmail(email);
      await page.getByLabel("E-mail").fill(email);
      await page.getByLabel("Senha").fill("senha-e2e-nova-2026");
      await page.getByRole("button", { name: "Entrar", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/${tenant.slug}(/|$)`), { timeout: 10_000 });
    } finally {
      await fakeSmtp.close();
    }
  });
});
