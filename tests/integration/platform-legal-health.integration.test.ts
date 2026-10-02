/**
 * Dados jurídicos da plataforma (docs/contratos.md, "Dados jurídicos") e Admin → Saúde
 * (docs/contratos.md, "Admin Saúde") contra Postgres real.
 *
 * Antes de tudo, zera os campos de integração de `PlatformSettings` (evolution/n8n/mercadoPago/
 * smtp) — outros arquivos de integração (ex.: `platform-n8n-sync.integration.test.ts`) gravam
 * URLs de teste nesses campos e não necessariamente os limpam depois; sem isto,
 * `getIntegrationsHealth()` tentaria uma chamada de rede de verdade contra uma URL de mock que
 * só existe durante a execução daquele outro arquivo (5s de timeout por chamada — deixaria esta
 * suíte lenta e frágil à ordem de execução dos arquivos).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/db/prisma";
import { fillLegalPlaceholders } from "@/core/legal/placeholders";
import { getPlatformLegalInfo, getPublicLegalInfo, updatePlatformLegalInfo } from "@/modules/platform/legal-service";
import {
  getIntegrationsHealth,
  getPlatformHealth,
  recordBillingTickRun,
  recordMaintenanceTickRun,
  resetIntegrationsHealthCache,
} from "@/modules/platform/health-service";

const prisma = getPrisma();
const cleanupTenantIds: string[] = [];
const cleanupUserIds: string[] = [];
let adminId: string;

beforeAll(async () => {
  await prisma.platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {
      evolutionApiUrl: null,
      evolutionApiKey: null,
      n8nBaseUrl: null,
      n8nApiKey: null,
      mercadoPagoAccessToken: null,
      mpProdAccessTokenEnc: null,
      mpTestAccessTokenEnc: null,
      mpEnvironment: "PRODUCTION",
      smtpHost: null,
      smtpPort: null,
    },
  });
  resetIntegrationsHealthCache();

  // `updatePlatformLegalInfo` grava `updatedByUserId` com FK real para `User` — precisa de um
  // usuário de verdade (não um id inventado), diferente do resto deste arquivo (que só lê/conta,
  // sem FK a satisfazer).
  const admin = await prisma.user.create({
    data: { email: `it-legal-admin-${Date.now()}-${randomUUID().slice(0, 6)}@example.com`, passwordHash: "x", isPlatformAdmin: true, totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() },
  });
  cleanupUserIds.push(admin.id);
  adminId = admin.id;
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: cleanupTenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

describe("Dados jurídicos — getPlatformLegalInfo / updatePlatformLegalInfo", () => {
  it("grava e relê os campos jurídicos; nenhum é mascarado", async () => {
    const updated = await updatePlatformLegalInfo(
      {
        companyLegalName: "Innovare Code Tecnologia Ltda.",
        companyCnpj: "11444777000161",
        companyAddress: "Rua Exemplo, 123 — Curitiba/PR",
        contactEmail: "contato@innovarecode.com.br",
        dpoName: "Maria Encarregada",
        dpoEmail: "dpo@innovarecode.com.br",
        forumCity: "Curitiba",
        hostingRegion: "Brasil (São Paulo)",
        backupRetentionDays: 30,
      },
      adminId,
    );

    expect(updated.companyCnpj).toBe("11444777000161");
    expect(updated.contactEmail).toBe("contato@innovarecode.com.br");

    const read = await getPlatformLegalInfo();
    expect(read).toEqual(updated);
  });

  it("string vazia/null LIMPA o campo; undefined mantém o valor atual", async () => {
    await updatePlatformLegalInfo({ forumCity: "Curitiba" }, adminId);
    const afterSet = await updatePlatformLegalInfo({ dpoName: "Alguém" }, adminId);
    expect(afterSet.forumCity).toBe("Curitiba"); // não foi enviado neste update — mantém

    const cleared = await updatePlatformLegalInfo({ forumCity: "" }, adminId);
    expect(cleared.forumCity).toBeNull();
  });

  it("getPublicLegalInfo devolve os mesmos campos (leitura pública, sem admin)", async () => {
    await updatePlatformLegalInfo({ forumCity: "São Paulo" }, adminId);
    const publicInfo = await getPublicLegalInfo();
    expect(publicInfo.forumCity).toBe("São Paulo");
  });

  it("fillLegalPlaceholders usa os dados reais gravados para substituir os marcadores do texto público", async () => {
    await updatePlatformLegalInfo(
      { companyCnpj: "11444777000161", companyAddress: "Rua Real, 1", contactEmail: "real@innovarecode.com.br" },
      adminId,
    );
    const info = await getPublicLegalInfo();
    const text = "CNPJ [CNPJ], endereço [ENDEREÇO], contato [E-MAIL DE CONTATO].";
    const filled = fillLegalPlaceholders(text, info);
    expect(filled).toBe("CNPJ 11.444.777/0001-61, endereço Rua Real, 1, contato real@innovarecode.com.br.");
  });
});

describe("Admin Saúde — integrações não configuradas", () => {
  it("getIntegrationsHealth devolve 'não configurado' sem tentar rede quando os campos estão vazios", async () => {
    resetIntegrationsHealthCache();
    const health = await getIntegrationsHealth();
    expect(health.evolution).toMatchObject({ ok: false, configured: false });
    expect(health.n8n).toMatchObject({ ok: false, configured: false });
    expect(health.smtp).toMatchObject({ ok: false, configured: false });
    expect(health.mercadoPago).toMatchObject({ ok: false, configured: false });
  });

  it("usa cache por ~60s: duas chamadas seguidas devolvem o mesmo `checkedAt`", async () => {
    resetIntegrationsHealthCache();
    const first = await getIntegrationsHealth();
    const second = await getIntegrationsHealth();
    expect(second.checkedAt).toBe(first.checkedAt);
  });
});

describe("Admin Saúde — jobs periódicos (billing/maintenance tick)", () => {
  it("registra a última execução e sinaliza 'stale' quando passa da janela (2h billing / 26h maintenance)", async () => {
    const now = new Date();
    const recentRun = new Date(now.getTime() - 30 * 60 * 1000); // 30min atrás — dentro da janela
    const oldRun = new Date(now.getTime() - 3 * 60 * 60 * 1000); // 3h atrás — billing fica stale

    await recordBillingTickRun({ invoicesCreated: 1 }, recentRun);
    await recordMaintenanceTickRun({ inboundEventsPurged: 2 }, recentRun);

    const healthy = await getPlatformHealth(now);
    expect(healthy.billingTick.stale).toBe(false);
    expect(healthy.maintenanceTick.stale).toBe(false);
    expect(healthy.billingTick.lastResult).toEqual({ invoicesCreated: 1 });

    await recordBillingTickRun({ invoicesCreated: 0 }, oldRun);
    const staleBilling = await getPlatformHealth(now);
    expect(staleBilling.billingTick.stale).toBe(true);
    expect(staleBilling.alerts.some((a) => a.includes("billing/tick"))).toBe(true);
  });

  it("sem nenhuma execução registrada, os dois ticks aparecem stale", async () => {
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: {
        lastBillingTickAt: null,
        lastBillingTickResult: Prisma.JsonNull,
        lastMaintenanceTickAt: null,
        lastMaintenanceTickResult: Prisma.JsonNull,
      },
    });

    const health = await getPlatformHealth(new Date());
    expect(health.billingTick.stale).toBe(true);
    expect(health.maintenanceTick.stale).toBe(true);
  });
});

describe("Admin Saúde — contagens operacionais", () => {
  it("conta instâncias de WhatsApp por status e empresas por status de assinatura", async () => {
    const slug = `it-health-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const tenant = await prisma.tenant.create({ data: { slug, name: "Health Co", timezone: "UTC" } });
    cleanupTenantIds.push(tenant.id);

    const plan = await prisma.plan.create({
      data: {
        code: `it-health-plan-${Date.now()}-${randomUUID().slice(0, 6)}`,
        name: "Plano Health",
        priceCents: 1000,
        maxWhatsappNumbers: 2,
        maxProfessionals: 1,
        active: false,
        sortOrder: 999,
      },
    });
    await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
    });
    await prisma.whatsappInstance.create({
      data: {
        tenantId: tenant.id,
        instanceName: `it-health-inst-${Date.now()}-${randomUUID().slice(0, 6)}`,
        label: "Principal",
        status: "CONNECTED",
        webhookToken: randomUUID(),
      },
    });

    const health = await getPlatformHealth(new Date());
    expect(health.whatsappInstancesByStatus.CONNECTED).toBeGreaterThanOrEqual(1);
    expect(health.companiesBySubscriptionStatus.ACTIVE).toBeGreaterThanOrEqual(1);
    expect(typeof health.inboundEventsLast24h).toBe("number");
  });
});
