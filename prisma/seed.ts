// Seed de dev: 1 usuário dono (também admin da plataforma), 1 tenant demo, serviços e
// profissionais, expediente básico e um agendamento SCHEDULED de exemplo. Não roda em produção
// (chamar só via `npm run db:seed`). Credenciais de dev documentadas em `.env.example` — NUNCA
// uma senha real.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { addMonths } from "date-fns";

const prisma = new PrismaClient();

// Mesmo custo de src/modules/auth/service.ts (SALT_ROUNDS = 12) — só duplicado aqui porque
// prisma/seed.ts roda fora do bundler do Next (via tsx) e não importa de src/ de propósito,
// para não acoplar o seed aos módulos da aplicação.
const DEV_PASSWORD_HASH_ROUNDS = 12;
const DEV_USER_EMAIL = "dev@innochat.local";
const DEV_USER_PASSWORD = "innochat-dev-2026"; // dev-only — troque em qualquer ambiente real.

async function main() {
  const devUser = await prisma.user.upsert({
    where: { email: DEV_USER_EMAIL },
    update: {},
    create: {
      email: DEV_USER_EMAIL,
      passwordHash: await bcrypt.hash(DEV_USER_PASSWORD, DEV_PASSWORD_HASH_ROUNDS),
      emailVerifiedAt: new Date(),
      isPlatformAdmin: true,
      termsAcceptedAt: new Date(),
      termsVersion: "dev",
    },
  });

  const tenant = await prisma.tenant.upsert({
    where: { slug: "studio-demo" },
    update: {},
    create: {
      slug: "studio-demo",
      name: "Studio Demo",
      timezone: "America/Sao_Paulo",
      segment: "Salão de beleza",
    },
  });

  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: devUser.id, tenantId: tenant.id } },
    update: { role: "OWNER" },
    create: { userId: devUser.id, tenantId: tenant.id, role: "OWNER" },
  });

  const [corte, coloracao] = await Promise.all([
    prisma.service.upsert({
      where: { id: `${tenant.id}-svc-corte` },
      update: {},
      create: {
        id: `${tenant.id}-svc-corte`,
        tenantId: tenant.id,
        name: "Corte feminino",
        durationMin: 60,
        bufferAfterMin: 10,
        priceCents: 8000,
        sortOrder: 1,
      },
    }),
    prisma.service.upsert({
      where: { id: `${tenant.id}-svc-coloracao` },
      update: {},
      create: {
        id: `${tenant.id}-svc-coloracao`,
        tenantId: tenant.id,
        name: "Coloração",
        durationMin: 120,
        bufferAfterMin: 15,
        priceCents: 18000,
        sortOrder: 2,
      },
    }),
  ]);

  const [ana, bruna] = await Promise.all([
    prisma.professional.upsert({
      where: { id: `${tenant.id}-pro-ana` },
      update: {},
      create: {
        id: `${tenant.id}-pro-ana`,
        tenantId: tenant.id,
        name: "Ana",
        sortOrder: 1,
      },
    }),
    prisma.professional.upsert({
      where: { id: `${tenant.id}-pro-bruna` },
      update: {},
      create: {
        id: `${tenant.id}-pro-bruna`,
        tenantId: tenant.id,
        name: "Bruna",
        sortOrder: 2,
      },
    }),
  ]);

  await prisma.professionalService.createMany({
    data: [
      { professionalId: ana.id, serviceId: corte.id },
      { professionalId: ana.id, serviceId: coloracao.id },
      { professionalId: bruna.id, serviceId: corte.id },
    ],
    skipDuplicates: true,
  });

  // Expediente: terça a sábado, 09:00-18:00, para as duas profissionais.
  const weekdaysWithWork = [2, 3, 4, 5, 6];
  for (const professional of [ana, bruna]) {
    await prisma.workingHour.deleteMany({ where: { professionalId: professional.id } });
    await prisma.workingHour.createMany({
      data: weekdaysWithWork.map((weekday) => ({
        professionalId: professional.id,
        weekday,
        startTime: "09:00",
        endTime: "18:00",
      })),
    });
  }

  const contact = await prisma.contact.upsert({
    where: { tenantId_waJid: { tenantId: tenant.id, waJid: "5511999990000@s.whatsapp.net" } },
    update: {},
    create: {
      tenantId: tenant.id,
      waJid: "5511999990000@s.whatsapp.net",
      phoneE164: "+5511999990000",
      name: "Maria Souza",
    },
  });

  const startsAt = new Date();
  startsAt.setDate(startsAt.getDate() + 1);
  startsAt.setHours(14, 0, 0, 0);
  const endsAt = new Date(startsAt.getTime() + corte.durationMin * 60_000);
  const blockEndsAt = new Date(endsAt.getTime() + corte.bufferAfterMin * 60_000);

  await prisma.appointment.upsert({
    where: { tenantId_idempotencyKey: { tenantId: tenant.id, idempotencyKey: "seed-demo-appointment" } },
    update: {},
    create: {
      tenantId: tenant.id,
      contactId: contact.id,
      serviceId: corte.id,
      professionalId: ana.id,
      startsAt,
      endsAt,
      blockEndsAt,
      idempotencyKey: "seed-demo-appointment",
    },
  });

  // Fase 7 — os 3 planos aprovados pelo dono (docs/arquitetura.md §7.2), com os preços
  // definitivos (2026-09-28): Essencial R$ 59,90 / Profissional R$ 109,90 / Clínica R$ 189,90 —
  // mesmos valores aplicados em produção pela migration de dados `20260928000010_plan_prices`
  // (o seed não roda em produção; esta atualização é só para o ambiente de dev ficar consistente
  // com o que o dono já aprovou). `update: {}` de propósito: rodar o seed de novo NUNCA
  // sobrescreve um preço que o admin já tenha ajustado pela tela Admin → Planos.
  const [essencial, profissional, clinica] = await Promise.all([
    prisma.plan.upsert({
      where: { code: "essencial" },
      update: {},
      create: {
        code: "essencial",
        name: "Essencial",
        priceCents: 5990,
        maxWhatsappNumbers: 1,
        maxProfessionals: 3,
        active: true,
        sortOrder: 1,
      },
    }),
    prisma.plan.upsert({
      where: { code: "profissional" },
      update: {},
      create: {
        code: "profissional",
        name: "Profissional",
        priceCents: 10990,
        maxWhatsappNumbers: 2,
        maxProfessionals: 10,
        active: true,
        sortOrder: 2,
      },
    }),
    prisma.plan.upsert({
      where: { code: "clinica" },
      update: {},
      create: {
        code: "clinica",
        name: "Clínica",
        priceCents: 18990,
        maxWhatsappNumbers: 3,
        maxProfessionals: null, // ilimitado
        active: true,
        sortOrder: 3,
      },
    }),
  ]);

  // Assinatura ACTIVE de exemplo para o tenant demo, no plano Essencial, ciclo mensal iniciado
  // hoje (dado de dev — em produção nasce TRIALING via cadastro público, §7.3).
  const periodStart = new Date();
  const currentPeriodEnd = new Date(periodStart);
  currentPeriodEnd.setTime(addMonths(periodStart, 1).getTime());

  const subscription = await prisma.subscription.upsert({
    where: { tenantId: tenant.id },
    update: {},
    create: {
      tenantId: tenant.id,
      planId: essencial.id,
      status: "ACTIVE",
      trialEndsAt: null,
      currentPeriodEnd,
    },
  });

  await prisma.invoice.upsert({
    where: { subscriptionId_periodStart: { subscriptionId: subscription.id, periodStart } },
    update: {},
    create: {
      subscriptionId: subscription.id,
      amountCents: essencial.priceCents,
      periodStart,
      periodEnd: currentPeriodEnd,
      dueAt: periodStart,
      status: "PAID",
      paidAt: periodStart,
    },
  });

  console.log(
    `Seed ok: tenant "${tenant.slug}" (${tenant.id}) — planos: ${essencial.code}/${profissional.code}/${clinica.code} — login de dev: ${DEV_USER_EMAIL} / ${DEV_USER_PASSWORD}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
