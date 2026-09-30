import fs from "node:fs";
import { chromium } from "@playwright/test";
import { prisma, hashPassword, ensureBotPlan } from "./fixtures/db";
import { loginAndWaitForPanel } from "./fixtures/auth";
import {
  SEED_TENANT_SLUG,
  SEED_OWNER_EMAIL,
  SEED_OWNER_PASSWORD,
  TENANT_B_OWNER_PASSWORD,
  STAFF_PASSWORD,
  generateRunFixtures,
  saveRunFixtures,
} from "./fixtures/test-data";
import { AUTH_DIR, OWNER_STORAGE_STATE, STAFF_STORAGE_STATE, TENANT_B_OWNER_STORAGE_STATE } from "./fixtures/storage-state";

/**
 * Roda UMA vez antes da suíte inteira (`playwright.config.ts`), no processo PRINCIPAL do
 * Playwright. Cria as duas fixtures que a UI não expõe: uma segunda empresa completa (isolamento
 * entre tenants) e um membro STAFF na empresa de seed (restrição "só OWNER troca o tema").
 *
 * Os identificadores gerados aqui (slugs/e-mails com timestamp) são salvos em disco — os specs
 * rodam em processos de WORKER separados, que reavaliariam `Date.now()` com outro valor se
 * tentassem gerar o prefixo de novo (ver comentário em `fixtures/test-data.ts`).
 */
export default async function globalSetup() {
  const generated = generateRunFixtures();
  const plan = await ensureBotPlan();

  // Banco recém-semeado: o dono de seed ainda não concluiu o tour do Inno, que abre sozinho 700 ms depois
  // da página e cobre a tela inteira (`data-tour-overlay`), interceptando qualquer clique. No banco de dev
  // de longa data alguém já o tinha fechado; num banco novo (CI, banco dedicado) faltava e specs
  // aleatórias falhavam por "overlay intercepta cliques". As fixtures abaixo já nascem com o tour concluído.
  await prisma.user.updateMany({
    where: { email: SEED_OWNER_EMAIL, onboardingTourCompletedAt: null },
    data: { onboardingTourCompletedAt: new Date() },
  });

  // Empresa B — isolada, com seu próprio OWNER.
  const tenantB = await prisma.tenant.create({
    data: {
      slug: generated.tenantBSlug,
      name: "Empresa B (E2E)",
      timezone: "America/Sao_Paulo",
    },
  });
  await prisma.subscription.create({
    data: { tenantId: tenantB.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) },
  });
  const ownerB = await prisma.user.create({
    data: {
      email: generated.tenantBOwnerEmail,
      passwordHash: await hashPassword(TENANT_B_OWNER_PASSWORD),
      emailVerifiedAt: new Date(),
      termsAcceptedAt: new Date(),
      termsVersion: "e2e",
      // O tour do Inno abre sozinho 700ms depois da página para quem ainda não o concluiu e o
      // overlay intercepta cliques — usuários de fixture já chegam com o tour concluído.
      onboardingTourCompletedAt: new Date(),
    },
  });
  await prisma.membership.create({ data: { userId: ownerB.id, tenantId: tenantB.id, role: "OWNER" } });

  // Cria um profissional em B com um id previsível de guardar — usado no teste de isolamento
  // (tentar acessar `/studio-demo/profissionais/{id-do-profissional-de-B}`).
  const professionalB = await prisma.professional.create({
    data: { tenantId: tenantB.id, name: "Profissional da Empresa B", sortOrder: 0 },
  });

  // Membro STAFF (não-OWNER) da empresa de SEED.
  const tenantSeed = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG } });

  // O tenant de seed já está no limite do plano (3 profissionais — 2 do seed + "Profissional QA",
  // leftover de sessão manual anterior, com 1 agendamento pendurado, então não é seguro apagar).
  // Sobe o override SÓ para esta suíte poder criar um profissional extra sem tropeçar no limite
  // — não é o que estamos testando aqui, e `global-teardown.ts` devolve para `null`.
  await prisma.tenant.update({ where: { id: tenantSeed.id }, data: { maxProfessionalsOverride: 10 } });
  const staffUser = await prisma.user.create({
    data: {
      email: generated.staffEmail,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      emailVerifiedAt: new Date(),
      termsAcceptedAt: new Date(),
      termsVersion: "e2e",
      // O tour do Inno abre sozinho 700ms depois da página para quem ainda não o concluiu e o
      // overlay intercepta cliques — usuários de fixture já chegam com o tour concluído.
      onboardingTourCompletedAt: new Date(),
    },
  });
  await prisma.membership.create({ data: { userId: staffUser.id, tenantId: tenantSeed.id, role: "STAFF" } });

  saveRunFixtures({
    ...generated,
    tenantBId: tenantB.id,
    professionalBId: professionalB.id,
    tenantSeedId: tenantSeed.id,
  });

  await prisma.$disconnect();

  // `storageState` por papel — logins reais pela UI (3 no total, feitos AQUI, uma vez), para os
  // specs consumirem via `test.use({ storageState: ... })` em vez de logar de novo em cada teste
  // (ver `fixtures/storage-state.ts` e `.claude/agent-memory/iris/login_rate_limit_e2e.md`: o
  // rate limit de login é 8 tentativas/15min por e-mail, e a suíte inteira reusava
  // `dev@innochat.local` em quase todo spec).
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const ownerContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
    const ownerPage = await ownerContext.newPage();
    await loginAndWaitForPanel(ownerPage, SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD, SEED_TENANT_SLUG);
    await ownerContext.storageState({ path: OWNER_STORAGE_STATE });
    await ownerContext.close();

    const staffContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
    const staffPage = await staffContext.newPage();
    await loginAndWaitForPanel(staffPage, generated.staffEmail, STAFF_PASSWORD, SEED_TENANT_SLUG);
    await staffContext.storageState({ path: STAFF_STORAGE_STATE });
    await staffContext.close();

    const tenantBContext = await browser.newContext({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
    const tenantBPage = await tenantBContext.newPage();
    await loginAndWaitForPanel(tenantBPage, generated.tenantBOwnerEmail, TENANT_B_OWNER_PASSWORD, generated.tenantBSlug);
    await tenantBContext.storageState({ path: TENANT_B_OWNER_STORAGE_STATE });
    await tenantBContext.close();
  } finally {
    await browser.close();
  }
}
