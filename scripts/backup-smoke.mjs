/**
 * Prova de que a restauração do backup funciona (job `backup-restore` do CI, .github/workflows/ci.yml).
 *
 * Roda contra um Postgres de verdade, em três atos:
 *   1) `semear`   grava linhas conhecidas no banco
 *   2) (o workflow faz o dump, APAGA o schema inteiro e restaura)
 *   3) `conferir` exige que aquelas mesmas linhas estejam de volta
 *
 * Backup que nunca foi restaurado é uma suposição, e testar uma vez à mão não basta: o schema muda
 * toda semana. Por isso o ciclo roda a cada push. Abordagem do Parque das Feiras (docs/BACKUP.md dele).
 *
 * Os dados são ATÍPICOS de propósito: acento, cedilha, emoji, decimal com 2 casas e data. Se a
 * restauração perder codificação ou precisão, é aqui que aparece, e não na agenda de uma empresa.
 *
 * Uso: node scripts/backup-smoke.mjs semear|conferir   (DATABASE_URL no ambiente)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SLUG = "backup-smoke";
const PLAN_CODE = "backup-smoke-plano";
const TENANT_NAME = "Clínica da Ação, Cãmisas & Açaí 🛍️";
const PROFESSIONAL_NAME = "Dra. Conceição Müller 💉";
const COMMISSION = "12.35";
const PRICE_CENTS = 12345;
const PERIOD_END = new Date("2031-05-17T15:30:00.000Z");

async function clean() {
  await prisma.professional.deleteMany({ where: { tenant: { slug: SLUG } } });
  await prisma.subscription.deleteMany({ where: { tenant: { slug: SLUG } } });
  await prisma.tenant.deleteMany({ where: { slug: SLUG } });
  await prisma.plan.deleteMany({ where: { code: PLAN_CODE } });
}

async function semear() {
  // Repetível na mesma base.
  await clean();
  const plan = await prisma.plan.create({
    data: { code: PLAN_CODE, name: "Plano do teste", priceCents: PRICE_CENTS, maxWhatsappNumbers: 1, maxProfessionals: 3, active: false, sortOrder: 999 },
  });
  const tenant = await prisma.tenant.create({ data: { slug: SLUG, name: TENANT_NAME, timezone: "America/Sao_Paulo" } });
  await prisma.subscription.create({ data: { tenantId: tenant.id, planId: plan.id, status: "TRIALING", trialEndsAt: PERIOD_END, currentPeriodEnd: PERIOD_END } });
  await prisma.professional.create({ data: { tenantId: tenant.id, name: PROFESSIONAL_NAME, commissionPct: COMMISSION } });
  console.log("[smoke] semeado: 1 plano, 1 empresa, 1 assinatura, 1 profissional");
}

async function conferir() {
  const problems = [];

  const tenant = await prisma.tenant.findUnique({ where: { slug: SLUG } });
  if (!tenant) problems.push("a empresa semeada não voltou");
  else if (tenant.name !== TENANT_NAME) problems.push(`o nome da empresa voltou diferente: ${JSON.stringify(tenant.name)}`);

  const plan = await prisma.plan.findUnique({ where: { code: PLAN_CODE } });
  if (!plan) problems.push("o plano semeado não voltou");
  else if (plan.priceCents !== PRICE_CENTS) problems.push(`o preço do plano voltou como ${plan.priceCents}, esperado ${PRICE_CENTS}`);

  if (tenant) {
    const subscription = await prisma.subscription.findUnique({ where: { tenantId: tenant.id } });
    if (!subscription) problems.push("a assinatura semeada não voltou");
    else {
      // Data: prova que o fuso e a precisão sobreviveram.
      if (subscription.currentPeriodEnd.toISOString() !== PERIOD_END.toISOString()) {
        problems.push(`a data da assinatura voltou como ${subscription.currentPeriodEnd.toISOString()}`);
      }
      // A relação precisa apontar para o plano restaurado, e não para o vazio.
      if (plan && subscription.planId !== plan.id) problems.push("a assinatura perdeu o vínculo com o plano");
    }

    const professional = await prisma.professional.findFirst({ where: { tenantId: tenant.id } });
    if (!professional) problems.push("o profissional semeado não voltou");
    else {
      if (professional.name !== PROFESSIONAL_NAME) problems.push("o nome do profissional voltou diferente");
      // Decimal: prova que não virou float pelo caminho.
      if (String(professional.commissionPct) !== COMMISSION) problems.push(`a comissão voltou como ${professional.commissionPct}, esperado ${COMMISSION}`);
    }
  }

  if (problems.length > 0) {
    console.error("[smoke] RESTAURAÇÃO REPROVADA:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("[smoke] restauração aprovada: empresa, plano, assinatura e profissional voltaram íntegros");
  console.log("[smoke]   acentuação, emoji, decimal, data e vínculo entre tabelas conferidos");
}

const action = process.argv[2];
try {
  if (action === "semear") await semear();
  else if (action === "conferir") await conferir();
  else {
    console.error("Uso: node scripts/backup-smoke.mjs semear|conferir");
    process.exit(1);
  }
} finally {
  await prisma.$disconnect();
}
