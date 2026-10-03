import { test, expect, type Page } from "@playwright/test";
import { SEED_TENANT_SLUG } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";

/**
 * Smoke de TODAS as rotas do produto (painel, admin, públicas) — rede de segurança permanente
 * contra o bug "ícone como prop de Server para Client" (passar um componente lucide-react de um
 * Server Component para um Client Component quebra em runtime com "Only plain objects can be
 * passed..."/"Functions cannot be passed...", mas passa limpo por lint, typecheck e build). Esse
 * bug já escapou 3 VEZES antes de aparecer no navegador — ver `sidebar-nav.tsx` e
 * `command-palette.tsx`, que documentam a mesma armadilha. Este smoke visita cada rota
 * autenticada como o papel certo e falha se aparecer erro de runtime, 500, ou error boundary.
 *
 * `dev@innochat.local` (seed) é OWNER do tenant de seed E platform admin ao mesmo tempo — um
 * único `storageState` cobre painel do tenant E admin da plataforma.
 */
test.use({ storageState: OWNER_STORAGE_STATE });

const RUNTIME_ERROR_PATTERNS = [
  /Only plain objects/i,
  /Functions cannot be passed/i,
  /Application error/i,
  /Cannot read propert/i,
  /is not a function/i,
  /Unhandled Runtime Error/i,
  /Internal Server Error/i,
];

async function visitAndCheck(page: Page, path: string) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const onConsole = (msg: import("@playwright/test").ConsoleMessage) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  };
  const onPageError = (err: Error) => pageErrors.push(err.message);
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  let status: number | null = null;
  try {
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    status = response?.status() ?? null;
    // Dá um instante para erros assíncronos de hidratação/efeitos aparecerem no console.
    await page.waitForTimeout(300);

    expect(status, `${path} devolveu status ${status}`).toBeLessThan(500);

    const bodyText = await page.locator("body").innerText().catch(() => "");
    for (const pattern of RUNTIME_ERROR_PATTERNS) {
      expect(bodyText, `${path}: encontrou "${pattern}" no corpo da página`).not.toMatch(pattern);
    }
    for (const err of [...consoleErrors, ...pageErrors]) {
      for (const pattern of RUNTIME_ERROR_PATTERNS) {
        expect(err, `${path}: erro de runtime no console/página — "${err}"`).not.toMatch(pattern);
      }
    }
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}

test.describe("Smoke — todas as rotas (painel, admin, públicas)", () => {
  let professionalId: string;

  test.beforeAll(async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG } });
    const ana = await prisma.professional.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Ana" } });
    professionalId = ana.id;
  });

  const tenantRoutes = [
    "/inicio",
    "/agenda",
    "/agendamentos",
    "/clientes",
    "/servicos",
    "/profissionais",
    "/whatsapp",
    "/mensagens-bot",
    "/configuracoes",
    "/configuracoes/aparencia",
    "/configuracoes/bloqueios",
    "/configuracoes/equipe",
    "/assinatura",
    "/onboarding",
  ];

  for (const route of tenantRoutes) {
    test(`painel: /${SEED_TENANT_SLUG}${route}`, async ({ page }) => {
      await visitAndCheck(page, `/${SEED_TENANT_SLUG}${route}`);
    });
  }

  test("painel: /{slug}/profissionais/{id} (detalhe)", async ({ page }) => {
    await visitAndCheck(page, `/${SEED_TENANT_SLUG}/profissionais/${professionalId}`);
  });

  const adminRoutes = ["/admin", "/admin/empresas", "/admin/planos", "/admin/configuracoes/geral", "/admin/configuracoes/whatsapp", "/admin/configuracoes/automacao", "/admin/configuracoes/pagamentos", "/admin/configuracoes/email", "/admin/configuracoes/login", "/admin/configuracoes/marketing", "/admin/cobranca", "/admin/saude"];

  for (const route of adminRoutes) {
    test(`admin: ${route}`, async ({ page }) => {
      await visitAndCheck(page, route);
    });
  }

  const publicRoutes = ["/", "/login", "/cadastro", "/recuperar-senha", "/termos", "/privacidade", "/convite", "/redefinir-senha", "/verificar-email"];

  for (const route of publicRoutes) {
    test(`pública: ${route}`, async ({ page, context }) => {
      // Rotas públicas testadas SEM sessão — um contexto novo, isolado do `storageState` do
      // arquivo (`test.use` no topo é para as rotas autenticadas; aqui a sessão atrapalharia
      // páginas como `/login` que redirecionam se já autenticado).
      await context.clearCookies();
      await visitAndCheck(page, route);
    });
  }
});
