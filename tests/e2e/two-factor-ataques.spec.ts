import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma, hashPassword } from "./fixtures/db";
import { login } from "./fixtures/auth";
import { ensureAuthSecret, submitTwoFactorCode } from "./fixtures/two-factor";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { loadRunFixtures } from "./fixtures/test-data";
import { encryptSecret } from "../../src/lib/crypto";
import { generateTotpSecret, totpCode } from "../../src/modules/two-factor/totp";

/**
 * Ataques à verificação em 2 etapas, pela porta que um invasor usaria (HTTP cru, sem a tela):
 * - `/api/auth/callback/credentials` direto com a senha certa de uma conta com 2FA: nunca abre sessão;
 * - replay do código TOTP (mesmo passo de 30 s) e replay do DESAFIO (uso único);
 * - desafio forjado, esgotado por tentativas e disputado em paralelo;
 * - o admin que redefine a 2FA derruba a sessão aberta da pessoa.
 * Cada teste usa o próprio usuário (o teto de tentativas por usuário é de 10 em 15 min).
 */
const run = randomUUID().slice(0, 8);
const PASSWORD = "e2e-2fa-ataque-2026";
const emails: string[] = [];
let tenantId = "";
let slug = "";

function baseURL() {
  return process.env.E2E_BASE_URL ?? "http://localhost:3000";
}

async function createUser(label: string, opts: { twoFactor: boolean }) {
  ensureAuthSecret();
  const email = `e2e-2fa-atk-${label}-${run}@e2e.innochat.local`;
  emails.push(email);
  const secret = generateTotpSecret();
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(PASSWORD),
      emailVerifiedAt: new Date(),
      termsAcceptedAt: new Date(),
      termsVersion: "e2e",
      onboardingTourCompletedAt: new Date(),
      ...(opts.twoFactor ? { totpSecretEnc: encryptSecret(secret), totpEnabledAt: new Date() } : {}),
    },
  });
  await prisma.membership.create({ data: { userId: user.id, tenantId, role: "OWNER" } });
  return { email, secret, userId: user.id };
}

async function csrf(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.get("/api/auth/csrf");
  return ((await res.json()) as { csrfToken: string }).csrfToken;
}

async function postProvider(ctx: APIRequestContext, provider: string, fields: Record<string, string>) {
  const csrfToken = await csrf(ctx);
  return ctx.post(`/api/auth/callback/${provider}`, { form: { csrfToken, json: "true", ...fields }, maxRedirects: 0 });
}

async function hasSession(ctx: APIRequestContext): Promise<boolean> {
  const cookies = (await ctx.storageState()).cookies;
  if (!cookies.some((c) => c.name.includes("session-token"))) return false;
  const body = await (await ctx.get("/api/auth/session")).text();
  return body.trim() !== "null" && body.includes('"user"');
}

/** Faz a etapa da senha pela tela e devolve o desafio (campo escondido) sem digitar o código. */
async function challengeFromUi(page: Page, email: string): Promise<string> {
  await login(page, email, PASSWORD);
  await expect(page.getByLabel("Código de verificação")).toBeVisible();
  return page.locator('input[name="challenge"]').inputValue();
}

test.describe.serial("2FA: ataques", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    const fx = loadRunFixtures();
    tenantId = fx.tenantBId;
    slug = fx.tenantBSlug;
  });

  test.afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
  });

  test("POST direto em /api/auth/callback/credentials com a senha certa de conta com 2FA não abre sessão (e numa conta sem 2FA abre: o ataque não é vácuo)", async () => {
    const withTwoFactor = await createUser("direto", { twoFactor: true });
    const plain = await createUser("semfa", { twoFactor: false });

    const ctxAttack = await pwRequest.newContext({ baseURL: baseURL() });
    const res = await postProvider(ctxAttack, "credentials", { email: withTwoFactor.email, password: PASSWORD });
    expect(res.status()).toBeLessThan(500);
    expect(await hasSession(ctxAttack), "sessão aberta só com a senha de conta com 2FA").toBe(false);
    // Nem com o e-mail em outra caixa/espaços (normalização não pode abrir brecha).
    await postProvider(ctxAttack, "credentials", { email: `  ${withTwoFactor.email.toUpperCase()} `, password: PASSWORD });
    expect(await hasSession(ctxAttack)).toBe(false);
    await ctxAttack.dispose();

    const ctxControl = await pwRequest.newContext({ baseURL: baseURL() });
    await postProvider(ctxControl, "credentials", { email: plain.email, password: PASSWORD });
    expect(await hasSession(ctxControl), "controle: conta sem 2FA deveria abrir sessão por esta rota").toBe(true);
    await ctxControl.dispose();
  });

  test("os provedores internos recusam prova/desafio forjados ou vazios", async () => {
    const u = await createUser("forjado", { twoFactor: true });
    const ctx = await pwRequest.newContext({ baseURL: baseURL() });
    const attempts: [string, Record<string, string>][] = [
      ["verified-login", { proof: "" }],
      ["verified-login", { proof: "eyJ1c2VySWQiOiJ4In0.assinatura-falsa" }],
      ["google-signup", { proof: "eyJ1c2VySWQiOiJ4In0.assinatura-falsa" }],
      ["two-factor", { challenge: "", code: totpCode(u.secret) }],
      ["two-factor", { challenge: "eyJ1c2VySWQiOiJ4In0.assinatura-falsa", code: totpCode(u.secret) }],
      ["two-factor", { challenge: "x".repeat(5000), code: totpCode(u.secret) }],
    ];
    for (const [provider, fields] of attempts) {
      const res = await postProvider(ctx, provider, fields);
      expect(res.status(), `${provider} ${JSON.stringify(fields).slice(0, 40)}`).toBeLessThan(500);
      expect(await hasSession(ctx), `${provider} abriu sessão`).toBe(false);
    }
    await ctx.dispose();
  });

  test("replay do código: o mesmo código de 30 s não entra duas vezes", async ({ page, browser }) => {
    const u = await createUser("replay", { twoFactor: true });
    const code = totpCode(u.secret);

    await login(page, u.email, PASSWORD);
    await submitTwoFactorCode(page, code, true);
    await expect(page).toHaveURL(new RegExp(`/${slug}/inicio`));

    // Outro navegador, nova senha, o MESMO código: recusado.
    const other = await browser.newContext({ baseURL: baseURL() });
    const page2 = await other.newPage();
    await login(page2, u.email, PASSWORD);
    await submitTwoFactorCode(page2, code, true);
    await expect(page2.getByRole("alert").filter({ hasText: "Código errado" })).toBeVisible();
    await expect(page2).toHaveURL(/\/login$/);
    await page2.goto(`/${slug}/inicio`);
    await expect(page2).toHaveURL(/\/login/);
    await other.close();
  });

  test("replay do desafio entre a tela (Server Action) e a rota /api/auth: o desafio gasto não vale de novo", async ({ page }) => {
    // BUG CONHECIDO (Íris, 2026-10-02): o estado do desafio (usado / nº de erros) e os limites de tentativa vivem em Map de
    // módulo; a Server Action do login e a rota /api/auth/callback/two-factor rodam em instâncias de módulo diferentes no
    // build de produção, então cada porta tem o seu "caderninho". Quando corrigirem (estado em globalThis ou no banco),
    // este teste passa e o Playwright avisa que o 'fail' esperado não aconteceu: aí é só remover a linha abaixo.
    test.fail(true, "desafio de uso único não vale entre a Server Action e a rota do Auth.js");
    const u = await createUser("desafio", { twoFactor: true });
    const challenge = await challengeFromUi(page, u.email);
    await page.getByLabel("Código de verificação").fill(totpCode(u.secret));
    await page.getByRole("button", { name: "Verificar e entrar" }).click();
    await expect(page).toHaveURL(new RegExp(`/${slug}/inicio`));

    const ctx = await pwRequest.newContext({ baseURL: baseURL() });
    // Código do passo seguinte (ainda dentro da janela e ainda não usado): só o desafio já gasto segura a porta.
    const res = await postProvider(ctx, "two-factor", { challenge, code: totpCode(u.secret, Date.now() + 30_000) });
    expect(res.status()).toBeLessThan(500);
    expect(await hasSession(ctx), "desafio reaproveitado abriu sessão").toBe(false);
    await ctx.dispose();
  });

  test("desafio esgotado: depois de 5 códigos errados nem o código certo salva aquele desafio, mas um login novo funciona", async ({ page, browser }) => {
    const u = await createUser("esgota", { twoFactor: true });
    const challenge = await challengeFromUi(page, u.email);
    const ctx = await pwRequest.newContext({ baseURL: baseURL() });
    for (const wrong of ["000000", "111111", "222222", "333333", "444444"]) {
      await postProvider(ctx, "two-factor", { challenge, code: wrong });
      expect(await hasSession(ctx)).toBe(false);
    }
    await postProvider(ctx, "two-factor", { challenge, code: totpCode(u.secret) });
    expect(await hasSession(ctx), "código certo abriu sessão em desafio esgotado").toBe(false);
    await ctx.dispose();

    // Quem tem a senha e o app continua entrando por um login novo (o desafio queimou, a conta não).
    const fresh = await browser.newContext({ baseURL: baseURL() });
    const page2 = await fresh.newPage();
    await login(page2, u.email, PASSWORD);
    await page2.getByLabel("Código de verificação").fill(totpCode(u.secret));
    await page2.getByRole("button", { name: "Verificar e entrar" }).click();
    await expect(page2).toHaveURL(new RegExp(`/${slug}/inicio`));
    await fresh.close();
  });

  test("duas requisições simultâneas com o mesmo desafio e o mesmo código: no máximo uma sessão", async ({ page }) => {
    const u = await createUser("paralelo", { twoFactor: true });
    const challenge = await challengeFromUi(page, u.email);
    const code = totpCode(u.secret);
    const contexts = await Promise.all(Array.from({ length: 4 }, () => pwRequest.newContext({ baseURL: baseURL() })));
    await Promise.all(contexts.map((c) => postProvider(c, "two-factor", { challenge, code })));
    const sessions = (await Promise.all(contexts.map((c) => hasSession(c)))).filter(Boolean).length;
    expect(sessions, "sessões abertas com o mesmo desafio e código").toBeLessThanOrEqual(1);
    await Promise.all(contexts.map((c) => c.dispose()));
  });

  test("senha errada e usuário que não existe devolvem a MESMA mensagem (sem enumerar contas)", async ({ page }) => {
    const u = await createUser("enumera", { twoFactor: true });
    await page.goto("/login");
    await page.getByLabel("E-mail").fill(u.email);
    await page.getByLabel("Senha").fill("senha-errada-qualquer-1");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    const wrong = await page.getByRole("alert").first().innerText();
    await page.goto("/login");
    await page.getByLabel("E-mail").fill(`naoexiste-${run}@e2e.innochat.local`);
    await page.getByLabel("Senha").fill("senha-errada-qualquer-1");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    const ghost = await page.getByRole("alert").first().innerText();
    expect(ghost).toBe(wrong);
    // E nem a tela do código aparece para quem errou a senha (não revela que a conta tem 2FA).
    await expect(page.getByLabel("Código de verificação")).toHaveCount(0);
  });

  test("admin redefine a 2FA de uma pessoa: a sessão aberta dela cai e ela entra só com a senha", async ({ browser }) => {
    const u = await createUser("reset", { twoFactor: true });
    const victim = await browser.newContext({ baseURL: baseURL() });
    const victimPage = await victim.newPage();
    await login(victimPage, u.email, PASSWORD);
    await submitTwoFactorCode(victimPage, u.secret);
    await expect(victimPage).toHaveURL(new RegExp(`/${slug}/inicio`));

    const admin = await browser.newContext({ storageState: OWNER_STORAGE_STATE, baseURL: baseURL() });
    const adminPage = await admin.newPage();
    await adminPage.goto(`/admin/empresas/${tenantId}`);
    const row = adminPage.getByRole("listitem").filter({ hasText: u.email });
    await expect(row.getByText("2 etapas ativa")).toBeVisible();
    await row.getByRole("button", { name: "Redefinir" }).click();
    await adminPage.getByRole("dialog").getByRole("button", { name: "Redefinir" }).click();
    await expect(row.getByText("Sem 2 etapas")).toBeVisible();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(after.totpEnabledAt).toBeNull();
    expect(after.totpSecretEnc).toBeNull();
    await admin.close();

    // A sessão que já estava aberta é derrubada (o contador de sessão mudou; o servidor guarda 5 s em cache).
    await expect
      .poll(
        async () => {
          await victimPage.goto(`/${slug}/inicio`);
          return new URL(victimPage.url()).pathname;
        },
        { timeout: 20_000, intervals: [1_500] },
      )
      .toBe("/login");
    await victim.close();

    // E o código antigo do app já não vale para nada: login só com a senha.
    const again = await browser.newContext({ baseURL: baseURL() });
    const againPage = await again.newPage();
    await login(againPage, u.email, PASSWORD);
    await expect(againPage.getByLabel("Código de verificação")).toHaveCount(0);
    await expect(againPage).toHaveURL(new RegExp(`/${slug}/inicio`));
    await again.close();
  });
});
