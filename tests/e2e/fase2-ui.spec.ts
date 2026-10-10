import { test, expect } from "@playwright/test";
import { SEED_TENANT_SLUG, SEED_OWNER_EMAIL, E2E_RUN_PREFIX } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE, STAFF_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma, setPublishedFlowVersion } from "./fixtures/db";

/**
 * Fase 2 (UI): Minha conta + nome, lembrete de véspera, aba Conversa na ficha do cliente e sino do
 * admin da plataforma. O dono de seed também é admin da plataforma (mesma conta usada em
 * `admin-saude.spec.ts`).
 */

test.describe("Minha conta", () => {
  test.use({ storageState: OWNER_STORAGE_STATE });
  let originalName: string | null = null;

  test.beforeAll(async () => {
    originalName = (await prisma.user.findUniqueOrThrow({ where: { email: SEED_OWNER_EMAIL }, select: { name: true } })).name;
  });
  test.afterAll(async () => {
    await prisma.user.update({ where: { email: SEED_OWNER_EMAIL }, data: { name: originalName } });
  });

  test("edita o nome; e-mail é só leitura; menu e saudação do Início passam a usar o nome", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/minha-conta`);
    await expect(page.getByRole("heading", { name: "Minha conta", level: 1 })).toBeVisible();

    const email = page.getByLabel("E-mail");
    await expect(email).toHaveValue(SEED_OWNER_EMAIL);
    await expect(email).toHaveAttribute("readonly", "");

    const save = page.getByRole("button", { name: "Salvar", exact: true });
    await expect(save).toBeDisabled(); // nada mudou ainda

    const name = page.getByLabel("Seu nome");
    await name.fill("A");
    await save.click();
    await expect(page.getByText("Informe seu nome (pelo menos 2 letras).")).toBeVisible();

    await name.fill("Zelda Teste E2E");
    await save.click();
    await expect(page.getByText("Nome atualizado.", { exact: true })).toBeVisible();

    // Bloco do usuário na sidebar (desktop) mostra o nome e leva para a mesma página.
    await expect(page.getByRole("link", { name: "Minha conta de Zelda Teste E2E" }).first()).toBeVisible();

    await page.goto(`/${SEED_TENANT_SLUG}/inicio`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Zelda");
  });

  test("celular: o bloco do usuário na gaveta leva a Minha conta e fecha a gaveta", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${SEED_TENANT_SLUG}/inicio`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Abrir menu" }).click();
    const drawer = page.getByRole("dialog");
    const link = drawer.getByRole("link", { name: /^Minha conta/ });
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/${SEED_TENANT_SLUG}/minha-conta$`));
    await expect(page.getByRole("heading", { name: "Minha conta", level: 1 })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("admin da plataforma também tem Minha conta", async ({ page }) => {
    await page.goto("/admin/minha-conta");
    await expect(page.getByRole("heading", { name: "Minha conta", level: 1 })).toBeVisible();
    await expect(page.getByLabel("E-mail")).toHaveValue(SEED_OWNER_EMAIL);
  });
});

test.describe("Lembrete automático (Configurações)", () => {
  let original: { reminderEnabled: boolean; reminderHoursBefore: number } | null = null;

  test.beforeAll(async () => {
    original = await prisma.tenant.findUniqueOrThrow({
      where: { slug: SEED_TENANT_SLUG },
      select: { reminderEnabled: true, reminderHoursBefore: true },
    });
  });
  test.afterAll(async () => {
    if (original) await prisma.tenant.update({ where: { slug: SEED_TENANT_SLUG }, data: original });
  });

  test.describe("dono", () => {
    test.use({ storageState: OWNER_STORAGE_STATE });

    test("liga/desliga e muda as horas de antecedência (2 a 48)", async ({ page }) => {
      await page.goto(`/${SEED_TENANT_SLUG}/configuracoes`);
      const card = page.getByTestId("lembrete-card");
      await expect(card.getByRole("heading", { name: "Lembrete automático para clientes" })).toBeVisible();
      await expect(card.getByText("entre 8h e 21h", { exact: false })).toBeVisible();
      await expect(card.getByRole("link", { name: "Editar o texto do lembrete" })).toHaveAttribute("href", /mensagens-bot#lembretes$/);

      const toggle = card.getByRole("switch", { name: "Enviar lembrete automático" });
      const hours = card.getByLabel("Enviar com quantas horas de antecedência", { exact: false });
      if ((await toggle.getAttribute("aria-checked")) !== "true") await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");

      await hours.fill("1");
      await card.getByRole("button", { name: "Salvar" }).click();
      await expect(card.getByText("entre 2 e 48", { exact: false })).toBeVisible();

      await hours.fill("30");
      await card.getByRole("button", { name: "Salvar" }).click();
      await expect(page.getByText("Lembrete automático ligado.", { exact: true })).toBeVisible();

      await page.reload();
      await expect(page.getByTestId("lembrete-card").getByLabel("Enviar com quantas horas de antecedência", { exact: false })).toHaveValue("30");

      // Desligado, as horas continuam editáveis (dá para ajustar antes de ligar) e o Salvar aparece ao mudar.
      await page.getByTestId("lembrete-card").getByRole("switch").click();
      await expect(page.getByTestId("lembrete-card").getByLabel("Enviar com quantas horas de antecedência", { exact: false })).toBeEnabled();
      await expect(page.getByTestId("lembrete-card").getByRole("button", { name: "Salvar" })).toBeEnabled();
    });

    test("Mensagens do bot: o lembrete é um item da aba \"Meus agendamentos\" e as variáveis ficam no editor", async ({ page }) => {
      // Catálogo v1 (fluxo ainda não publicado): a lista tem o item #lembretes; as variáveis só aparecem
      // dentro do diálogo de edição (não mais numa seção própria da página).
      const previous = await setPublishedFlowVersion(null);
      try {
        await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot#lembretes`);
        const item = page.locator("#lembretes");
        await expect(item).toBeVisible();
        await expect(page.getByRole("tab", { name: /^Meus agendamentos/ })).toHaveAttribute("aria-selected", "true");
        await expect(item.getByRole("heading", { name: /Lembrete/ })).toBeVisible();
        // Fora do diálogo, a página não lista as variáveis.
        await expect(item.getByText("{quando}", { exact: true })).toHaveCount(0);

        await item.getByRole("button", { name: /^Editar / }).click();
        const chips = page.getByRole("dialog").getByRole("group", { name: "Variáveis desta mensagem" });
        for (const v of ["{nome}", "{servico}", "{profissional}", "{data}", "{hora}", "{quando}"]) {
          await expect(chips.getByRole("button", { name: v, exact: true })).toBeVisible();
        }
      } finally {
        await setPublishedFlowVersion(previous);
      }
    });
  });

  test.describe("equipe (STAFF)", () => {
    test.use({ storageState: STAFF_STORAGE_STATE });

    test("só vê: controles desabilitados e sem botão Salvar", async ({ page }) => {
      await page.goto(`/${SEED_TENANT_SLUG}/configuracoes`);
      const card = page.getByTestId("lembrete-card");
      await expect(card.getByRole("switch")).toBeDisabled();
      await expect(card.getByText("Só o dono da empresa pode alterar o lembrete.")).toBeVisible();
      await expect(card.getByRole("button", { name: "Salvar" })).toHaveCount(0);
    });
  });
});

test.describe("Ficha do cliente: aba Conversa", () => {
  test.use({ storageState: OWNER_STORAGE_STATE });
  const contactName = `${E2E_RUN_PREFIX} Conversa`;
  const emptyName = `${E2E_RUN_PREFIX} Sem Conversa`;
  let tenantId = "";

  test.beforeAll(async () => {
    tenantId = (await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG }, select: { id: true } })).id;
    const digits = E2E_RUN_PREFIX.replace(/\D/g, "").slice(-8);
    const contact = await prisma.contact.create({
      data: { tenantId, waJid: `5511${digits}1@s.whatsapp.net`, phoneE164: `+5511${digits}1`, name: contactName },
    });
    await prisma.contact.create({
      data: { tenantId, waJid: `5511${digits}2@s.whatsapp.net`, phoneE164: `+5511${digits}2`, name: emptyName },
    });
    // 60 mensagens (30 pares), a mais recente há ~2 min — força a 2ª página (50 por página).
    const base = Date.now() - 2 * 60_000;
    await prisma.chatMessage.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        tenantId,
        contactId: contact.id,
        direction: i % 2 === 0 ? ("INBOUND" as const) : ("OUTBOUND" as const),
        body: i % 2 === 0 ? `Mensagem do cliente ${i}` : `Resposta do bot ${i}`,
        createdAt: new Date(base - (59 - i) * 60_000),
      })),
    });
  });
  test.afterAll(async () => {
    await prisma.contact.deleteMany({ where: { name: { contains: E2E_RUN_PREFIX } } }); // cascata leva as mensagens
  });

  async function openContact(page: import("@playwright/test").Page, name: string) {
    await page.goto(`/${SEED_TENANT_SLUG}/clientes`);
    await page.getByLabel("Buscar cliente por nome ou telefone").fill(name);
    await page.getByText(name, { exact: false }).filter({ visible: true }).first().click();
    await expect(page.getByRole("dialog").filter({ hasText: "Dados, histórico de agendamentos" })).toBeVisible();
  }

  test("mostra balões, aviso de 90 dias e carrega mensagens anteriores", async ({ page }) => {
    await openContact(page, contactName);
    await page.getByRole("tab", { name: "Conversa" }).click();

    const log = page.getByRole("log", { name: `Conversa com ${contactName}` });
    await expect(log).toBeVisible();
    // Mais recente (índice 59, bot) visível embaixo; rótulos acessíveis dizem quem falou.
    await expect(log.getByText("Resposta do bot 59")).toBeVisible();
    await expect(log.getByRole("article", { name: /^Cliente, \d{2}:\d{2}$/ }).first()).toBeVisible();
    await expect(log.getByRole("article", { name: /^Bot, \d{2}:\d{2}$/ }).first()).toBeVisible();
    await expect(page.getByText("Histórico guardado por 90 dias (LGPD)", { exact: false })).toBeVisible();
    await expect(log.getByRole("heading", { name: "Hoje" }).first()).toBeVisible();

    // Abre já rolado até o fim (mensagem mais recente), não no meio da lista.
    const atBottom = () => log.evaluate((el) => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) <= 2);
    await expect.poll(atBottom).toBe(true);

    // 50 na 1ª página: as 10 mais antigas ainda não estão.
    await expect(log.getByText("Mensagem do cliente 0", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Carregar mensagens anteriores" }).click();
    await expect(log.getByText("Mensagem do cliente 0", { exact: true })).toBeAttached();
    await expect(page.getByRole("button", { name: "Carregar mensagens anteriores" })).toHaveCount(0);
    // Carregar página antiga não puxa a leitura para o topo nem para o fim: o que o usuário via continua no lugar.
    await expect(log.getByText("Resposta do bot 59")).toBeAttached();
  });

  test("cliente sem mensagens mostra o estado vazio", async ({ page }) => {
    await openContact(page, emptyName);
    await page.getByRole("tab", { name: "Conversa" }).click();
    await expect(page.getByText("Nenhuma mensagem nos últimos 90 dias")).toBeVisible();
    await expect(page.getByText("Histórico guardado por 90 dias (LGPD)", { exact: false })).toBeVisible();
  });
});

test.describe("Sino do admin da plataforma", () => {
  test.use({ storageState: OWNER_STORAGE_STATE });

  test("abre o painel, tem as ações do sino e fecha com Esc devolvendo o foco", async ({ page }) => {
    await page.goto("/admin/empresas");
    const bell = page.getByRole("button", { name: /Notificações/ });
    await expect(bell).toBeVisible();
    await bell.click();

    const panel = page.getByRole("dialog", { name: "Notificações" });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: "Marcar todas como lidas" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Todas", exact: true })).toBeVisible();
    // Ou há avisos, ou o estado vazio do admin.
    await expect(panel.getByRole("listitem").first().or(panel.getByText("Tudo em dia por aqui"))).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(bell).toBeFocused();
  });
});

test.describe("Nome do usuário nos formulários públicos", () => {
  test("aceitar convite pede o nome (2 a 80) antes de qualquer chamada ao servidor", async ({ page }) => {
    await page.goto("/convite?token=token-de-teste");
    await page.waitForLoadState("networkidle"); // hidratou: preencher antes disso perde o valor
    await page.getByLabel("Senha", { exact: false }).first().fill("uma-senha-boa-123");
    await page.getByLabel("Confirmar senha").fill("uma-senha-boa-123");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.getByText("Informe seu nome (pelo menos 2 letras).")).toBeVisible();

    // Com nome preenchido, o pedido segue e o servidor recusa o token de teste.
    await page.getByLabel("Seu nome").fill("Fulana de Tal");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.getByText("Este convite é inválido, já foi usado ou expirou. Peça um novo.")).toBeVisible();
  });

  test("cadastro: 'Seu nome' é obrigatório e limitado a 80 caracteres", async ({ page }) => {
    await page.goto("/cadastro");
    const name = page.getByRole("main").getByLabel("Seu nome");
    await expect(name).toBeVisible();
    await expect(name).toHaveAttribute("maxlength", "80");
    await page.getByRole("main").getByRole("button", { name: "Criar conta grátis" }).click();
    await expect(page.getByText("Informe seu nome (pelo menos 2 letras).")).toBeVisible();
  });
});
