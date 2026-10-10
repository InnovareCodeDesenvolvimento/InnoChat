import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { prisma } from "./db";
import { E2E_RUN_PREFIX } from "./test-data";

/**
 * Cadastro público enxuto (docs/plano-cadastro-sem-friccao.md): empresa, nome, WhatsApp, e-mail,
 * senha e o aceite. Escopo em `main` porque a rota tem `loading.tsx` e o streaming deixa uma cópia
 * oculta do conteúdo no DOM (o rótulo apareceria duas vezes e o modo estrito do Playwright reclama).
 */
export const CADASTRO_PASSWORD = "senha-e2e-cadastro-2026";
export const CADASTRO_PHONE = "84999998888";

export type CadastroFill = {
  email: string;
  companyName?: string;
  name?: string;
  phone?: string;
  password?: string;
  /** Marca o aceite (padrão: sim). */
  accept?: boolean;
  /** Caminho aberto antes de preencher (padrão `/cadastro`). */
  path?: string;
};

/**
 * O cadastro tem limite de 5 por hora por IP, em memória do servidor. Cada teste vira "um visitante diferente":
 * o último valor de `X-Forwarded-For` é o IP que o servidor usa (`TRUSTED_PROXY_HOPS = 1`), então um IP sorteado
 * por teste evita esgotar o limite da suíte inteira (e do rerun) sem mexer no código de produção.
 */
export async function setOwnIp(page: Page): Promise<void> {
  const ip = `10.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`;
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": ip });
}

export async function fillCadastro(page: Page, opts: CadastroFill): Promise<void> {
  await setOwnIp(page);
  await page.goto(opts.path ?? "/cadastro");
  const main = page.getByRole("main");
  await main.getByLabel("Nome da empresa").fill(opts.companyName ?? `${E2E_RUN_PREFIX} Empresa Cadastro`);
  await main.getByLabel("Seu nome").fill(opts.name ?? "Dona da Empresa E2E");
  await main.getByLabel("Seu WhatsApp").fill(opts.phone ?? CADASTRO_PHONE);
  await main.getByLabel("E-mail *", { exact: true }).fill(opts.email);
  await main.getByLabel("Senha *", { exact: true }).fill(opts.password ?? CADASTRO_PASSWORD);
  if (opts.accept !== false) await main.locator('input[type="checkbox"]').check();
}

/** Depois do envio com sessão aberta a página sai de /cadastro (vai para /pos-login e daí para o painel). */
export async function expectLeftCadastro(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/\/cadastro/, { timeout: 20_000 });
}

/** A empresa criada para um e-mail (o endereço agora é gerado pelo servidor). */
export async function tenantOfEmail(email: string) {
  const membership = await prisma.membership.findFirstOrThrow({ where: { user: { email } }, include: { tenant: true } });
  return membership.tenant;
}

/** Limpa o que um cadastro de teste criou (empresa e usuário), pelo e-mail. */
export async function cleanupSignup(emails: string[]): Promise<void> {
  if (!emails.length) return;
  const memberships = await prisma.membership.findMany({ where: { user: { email: { in: emails } } }, select: { tenantId: true } });
  const tenantIds = [...new Set(memberships.map((m) => m.tenantId))];
  if (tenantIds.length) {
    await prisma.couponRedemption.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.subscription.updateMany({ where: { tenantId: { in: tenantIds } }, data: { couponId: null, couponCyclesRemaining: null } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  }
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
}
