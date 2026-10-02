/**
 * Onda 0 (docs/plano-melhorias-2026-10.md): restrições do banco contra Postgres real — únicos, CHECKs,
 * append-only da auditoria, índices únicos parciais da lista de espera, singleton do backup.
 */
import { randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import { afterAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

const prisma = getPrisma();
const run = randomUUID().slice(0, 8);

const tenantIds: string[] = [];
const planIds: string[] = [];
const userIds: string[] = [];
const couponIds: string[] = [];
const groupIds: string[] = [];

async function rejects(p: Promise<unknown>, pattern?: RegExp) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err, "a operação deveria ter sido recusada pelo banco").toBeDefined();
  if (pattern) expect(String((err as Error).message)).toMatch(pattern);
}

async function makeTenant(label: string) {
  const t = await prisma.tenant.create({ data: { slug: `it-o0-${label}-${run}`, name: `O0 ${label}`, timezone: "America/Sao_Paulo" } });
  tenantIds.push(t.id);
  return t;
}
async function makePlan() {
  const p = await prisma.plan.create({
    data: { code: `it-o0-${run}-${planIds.length}`, name: "P", priceCents: 1000, maxWhatsappNumbers: 1, maxProfessionals: 1, active: false, sortOrder: 999 },
  });
  planIds.push(p.id);
  return p;
}
let couponSeq = 0;
function couponData(over: Record<string, unknown> = {}) {
  return { code: `CUP${run}${couponSeq++}`.toUpperCase(), kind: "PERCENT", value: 10, ...over } as never;
}
async function makeCoupon(over: Record<string, unknown> = {}) {
  const c = await prisma.coupon.create({ data: couponData(over) });
  couponIds.push(c.id);
  return c;
}

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.couponRedemption.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.subscription.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.errorGroup.deleteMany({ where: { id: { in: groupIds } } });
});

describe("item 1 — erros", () => {
  it("fingerprint é único, status/source são conjuntos fechados, eventos caem em cascata", async () => {
    const fp = `fp-${run}`;
    const g = await prisma.errorGroup.create({ data: { fingerprint: fp, message: "boom", type: "TypeError", source: "SERVER" } });
    groupIds.push(g.id);
    await rejects(prisma.errorGroup.create({ data: { fingerprint: fp, message: "x", type: "E", source: "SERVER" } }), /Unique|fingerprint/i);
    await rejects(prisma.errorGroup.create({ data: { fingerprint: `${fp}-b`, message: "x", type: "E", source: "MOBILE" } }), /check/i);
    await rejects(prisma.errorGroup.update({ where: { id: g.id }, data: { status: "WHATEVER" } }), /check/i);
    await rejects(prisma.errorGroup.create({ data: { fingerprint: `${fp}-c`, message: "m".repeat(301), type: "E", source: "CLIENT" } }), /check/i);

    await prisma.errorEvent.create({ data: { groupId: g.id, stack: "at x", context: { a: 1 } } });
    await rejects(prisma.errorEvent.create({ data: { groupId: g.id, stack: "s".repeat(8001) } }), /check/i);
    await rejects(prisma.errorEvent.create({ data: { groupId: g.id, context: { big: "x".repeat(5000) } } }), /check/i);
    await prisma.errorGroup.delete({ where: { id: g.id } });
    expect(await prisma.errorEvent.count({ where: { groupId: g.id } })).toBe(0);
  });
});

describe("item 2 — backup", () => {
  it("singleton id=1 nasce desligado; segunda linha e automático sem destino são recusados", async () => {
    const cfg = await prisma.backupConfig.findUniqueOrThrow({ where: { id: 1 } });
    expect(cfg.enabled).toBe(false);
    expect(cfg.destination).toBeNull();
    await rejects(prisma.backupConfig.create({ data: { id: 2 } }), /check/i);
    await rejects(prisma.backupConfig.update({ where: { id: 1 }, data: { enabled: true } }), /check/i);
    await rejects(prisma.backupConfig.update({ where: { id: 1 }, data: { hourLocal: 24 } }), /check/i);
    await rejects(prisma.backupConfig.update({ where: { id: 1 }, data: { destination: "FTP" } }), /check/i);
  });
  it("BackupRun aceita BigInt e recusa status inválido", async () => {
    const r = await prisma.backupRun.create({ data: { status: "SUCCESS", trigger: "MANUAL", sizeBytes: BigInt(5_000_000_000), destination: "S3" } });
    expect(r.sizeBytes).toBe(BigInt(5_000_000_000));
    await rejects(prisma.backupRun.create({ data: { status: "DONE" } }), /check/i);
    await prisma.backupRun.delete({ where: { id: r.id } });
  });
});

describe("item 3 — 2FA", () => {
  it("2FA ligada exige segredo; código de recuperação é único por usuário e cai em cascata", async () => {
    const u = await prisma.user.create({ data: { email: `o0-${run}@example.test` } });
    userIds.push(u.id);
    expect(u.twoFactorRequired).toBe(false);
    await rejects(prisma.user.update({ where: { id: u.id }, data: { totpEnabledAt: new Date() } }), /check/i);
    await prisma.user.update({ where: { id: u.id }, data: { totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() } });
    await prisma.twoFactorRecoveryCode.create({ data: { userId: u.id, codeHash: "h1" } });
    await rejects(prisma.twoFactorRecoveryCode.create({ data: { userId: u.id, codeHash: "h1" } }), /Unique/i);
    // consumo atômico: só o primeiro UPDATE condicional vence
    const first = await prisma.twoFactorRecoveryCode.updateMany({ where: { userId: u.id, codeHash: "h1", usedAt: null }, data: { usedAt: new Date() } });
    const second = await prisma.twoFactorRecoveryCode.updateMany({ where: { userId: u.id, codeHash: "h1", usedAt: null }, data: { usedAt: new Date() } });
    expect([first.count, second.count]).toEqual([1, 0]);
    await prisma.user.delete({ where: { id: u.id } });
    expect(await prisma.twoFactorRecoveryCode.count({ where: { userId: u.id } })).toBe(0);
    userIds.pop();
  });
});

describe("item 4 — auditoria append-only", () => {
  it("UPDATE é bloqueado pelo trigger; role/summary/changes têm CHECK; DELETE da empresa cascateia", async () => {
    const t = await makeTenant("audit");
    const a = await prisma.auditLog.create({
      data: { tenantId: t.id, actorUserId: "u-sem-fk", actorRole: "OWNER", action: "service.price_changed", summary: "Preço alterado", changes: { priceCents: { de: 100, para: 200 } }, ipTruncated: "203.0.113.0" },
    });
    await rejects(prisma.auditLog.update({ where: { id: a.id }, data: { summary: "adulterado" } }), /append-only/i);
    await rejects(prisma.auditLog.updateMany({ where: { id: a.id }, data: { action: "x" } }), /append-only/i);
    await rejects(prisma.auditLog.create({ data: { tenantId: t.id, actorRole: "HACKER", action: "x", summary: "s" } }), /check/i);
    await rejects(prisma.auditLog.create({ data: { tenantId: t.id, actorRole: "SYSTEM", action: "x", summary: "" } }), /check/i);
    await rejects(prisma.auditLog.create({ data: { tenantId: t.id, actorRole: "SYSTEM", action: "x", summary: "s", changes: { big: "x".repeat(9000) } } }), /check/i);
    // ação da plataforma, sem empresa
    const p = await prisma.auditLog.create({ data: { actorRole: "PLATFORM_ADMIN", action: "settings.updated", summary: "Configuração" } });
    expect(p.tenantId).toBeNull();
    await prisma.auditLog.delete({ where: { id: p.id } }); // DELETE continua permitido (retenção)
    await prisma.tenant.delete({ where: { id: t.id } }); // cascata
    tenantIds.pop();
    expect(await prisma.auditLog.count({ where: { id: a.id } })).toBe(0);
  });
});

describe("item 5 — pixel do Meta", () => {
  it("metaEnabled nasce false e o Pixel ID só aceita dígitos", async () => {
    const s = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(s.metaEnabled).toBe(false);
    await rejects(prisma.platformSettings.update({ where: { id: 1 }, data: { metaPixelId: "abc" } }), /check/i);
    const ok = await prisma.platformSettings.update({ where: { id: 1 }, data: { metaPixelId: "123456789012345" } });
    expect(ok.metaPixelId).toBe("123456789012345");
    await prisma.platformSettings.update({ where: { id: 1 }, data: { metaPixelId: null } });
  });
});

describe("item 6 — anual e cupons", () => {
  it("cupom: código maiúsculo e único, tipo/valor/duração coerentes, teto de usos no banco", async () => {
    await rejects(prisma.coupon.create({ data: couponData({ code: "minusculo" }) }), /check/i);
    await rejects(prisma.coupon.create({ data: couponData({ code: "AB" }) }), /check/i);
    const c = await makeCoupon({ code: `UNICO${run}`.toUpperCase() });
    await rejects(prisma.coupon.create({ data: couponData({ code: c.code }) }), /Unique/i);
    await rejects(prisma.coupon.create({ data: couponData({ value: 101 }) }), /check/i);
    await rejects(prisma.coupon.create({ data: couponData({ value: 0 }) }), /check/i);
    await rejects(prisma.coupon.create({ data: couponData({ kind: "AMOUNT", value: 0 }) }), /check/i);
    await rejects(prisma.coupon.create({ data: couponData({ duration: "N_CYCLES" }) }), /check/i);
    await rejects(prisma.coupon.create({ data: couponData({ duration: "ONCE", durationCycles: 3 }) }), /check/i);
    await rejects(prisma.coupon.create({ data: couponData({ duration: "FOREVER", appliesToCycle: "WEEKLY" }) }), /check/i);
    await rejects(prisma.coupon.create({ data: couponData({ validFrom: new Date("2026-02-01"), validUntil: new Date("2026-01-01") }) }), /check/i);
    const nc = await makeCoupon({ duration: "N_CYCLES", durationCycles: 3, kind: "AMOUNT", value: 500, appliesToCycle: "ANNUAL" });
    expect(nc.durationCycles).toBe(3);

    const limited = await makeCoupon({ maxRedemptions: 1 });
    const claim = () => prisma.$executeRaw`UPDATE "coupons" SET "redemptionsCount" = "redemptionsCount" + 1 WHERE "id" = ${limited.id} AND ("maxRedemptions" IS NULL OR "redemptionsCount" < "maxRedemptions")`;
    expect([await claim(), await claim()]).toEqual([1, 0]);
    await rejects(prisma.coupon.update({ where: { id: limited.id }, data: { redemptionsCount: 2 } }), /check/i);
  });

  it("resgate único por (cupom, empresa); cupom em uso não pode ser apagado; ciclo e desconto têm CHECK", async () => {
    const t = await makeTenant("cup");
    const plan = await makePlan();
    const c = await makeCoupon({ duration: "N_CYCLES", durationCycles: 2 });
    await prisma.couponPlan.create({ data: { couponId: c.id, planId: plan.id } });
    const sub = await prisma.subscription.create({
      data: { tenantId: t.id, planId: plan.id, currentPeriodEnd: addDays(new Date(), 30), couponId: c.id, couponCyclesRemaining: 2, billingCycle: "ANNUAL" },
    });
    expect(sub.billingCycle).toBe("ANNUAL");
    await prisma.couponRedemption.create({ data: { couponId: c.id, tenantId: t.id, discountCents: 100 } });
    await rejects(prisma.couponRedemption.create({ data: { couponId: c.id, tenantId: t.id } }), /Unique/i);
    await rejects(prisma.coupon.delete({ where: { id: c.id } }), /foreign|constraint|violates/i);

    await rejects(prisma.subscription.update({ where: { id: sub.id }, data: { billingCycle: "WEEKLY" } }), /check/i);
    await rejects(prisma.subscription.update({ where: { id: sub.id }, data: { couponCyclesRemaining: -1 } }), /check/i);
    await rejects(prisma.subscription.update({ where: { id: sub.id }, data: { couponId: null } }), /check/i); // contador sem cupom
    await prisma.subscription.update({ where: { id: sub.id }, data: { couponId: null, couponCyclesRemaining: null } });

    const inv = await prisma.invoice.create({
      data: { subscriptionId: sub.id, amountCents: 900, periodStart: new Date(), periodEnd: addDays(new Date(), 30), dueAt: addDays(new Date(), 30), discountCents: 100, couponCode: c.code, cycle: "ANNUAL" },
    });
    await rejects(prisma.invoice.update({ where: { id: inv.id }, data: { discountCents: -1 } }), /check/i);
    await rejects(prisma.invoice.update({ where: { id: inv.id }, data: { cycle: "X" } }), /check/i);
    const legacy = await prisma.invoice.create({
      data: { subscriptionId: sub.id, amountCents: 900, periodStart: addDays(new Date(), 40), periodEnd: addDays(new Date(), 70), dueAt: addDays(new Date(), 70) },
    });
    expect([legacy.cycle, legacy.discountCents]).toEqual(["MONTHLY", 0]);

    await rejects(prisma.plan.update({ where: { id: plan.id }, data: { annualPriceCents: 0 } }), /check/i);
    const withAnnual = await prisma.plan.update({ where: { id: plan.id }, data: { annualPriceCents: 9900 } });
    expect(withAnnual.annualPriceCents).toBe(9900);
  });
});

describe("item 7 — lista de espera", () => {
  async function setup(label: string) {
    const t = await makeTenant(label);
    const contact = await prisma.contact.create({ data: { tenantId: t.id, waJid: `55119${run}${label}@s.whatsapp.net` } });
    const service = await prisma.service.create({ data: { tenantId: t.id, name: "Corte", durationMin: 30 } });
    const prof = await prisma.professional.create({ data: { tenantId: t.id, name: "Ana" } });
    const prof2 = await prisma.professional.create({ data: { tenantId: t.id, name: "Bia" } });
    const contact2 = await prisma.contact.create({ data: { tenantId: t.id, waJid: `55118${run}${label}@s.whatsapp.net` } });
    return { t, contact, contact2, service, prof, prof2 };
  }
  const day = new Date("2026-11-10T00:00:00.000Z");

  it("uma entrada ativa por contato+serviço+dia+profissional; liberada após cancelar", async () => {
    const { t, contact, service, prof } = await setup("wl1");
    const base = { tenantId: t.id, contactId: contact.id, serviceId: service.id, desiredDate: day };
    const first = await prisma.waitlistEntry.create({ data: base });
    expect(first.status).toBe("WAITING");
    await rejects(prisma.waitlistEntry.create({ data: base }), /Unique/i);
    // outro profissional específico é outra entrada; "qualquer" já existe
    await prisma.waitlistEntry.create({ data: { ...base, professionalId: prof.id } });
    await rejects(prisma.waitlistEntry.create({ data: { ...base, professionalId: prof.id } }), /Unique/i);
    await prisma.waitlistEntry.update({ where: { id: first.id }, data: { status: "CANCELED" } });
    await prisma.waitlistEntry.create({ data: base });
  });

  it("OFFERED exige horário/prazo; mesmo horário não pode ser oferecido a duas pessoas", async () => {
    const { t, contact, contact2, service, prof } = await setup("wl2");
    const e1 = await prisma.waitlistEntry.create({ data: { tenantId: t.id, contactId: contact.id, serviceId: service.id, desiredDate: day } });
    const e2 = await prisma.waitlistEntry.create({ data: { tenantId: t.id, contactId: contact2.id, serviceId: service.id, desiredDate: day } });
    await rejects(prisma.waitlistEntry.update({ where: { id: e1.id }, data: { status: "OFFERED" } }), /check/i);
    const slot = new Date("2026-11-10T14:00:00.000Z");
    const offer = { status: "OFFERED", offeredSlotStart: slot, offeredAt: new Date(), offerExpiresAt: addDays(new Date(), 1), offeredProfessionalId: prof.id };
    await prisma.waitlistEntry.update({ where: { id: e1.id }, data: offer });
    await rejects(prisma.waitlistEntry.update({ where: { id: e2.id }, data: offer }), /Unique/i);
    await prisma.waitlistEntry.update({ where: { id: e1.id }, data: { status: "EXPIRED" } });
    await prisma.waitlistEntry.update({ where: { id: e2.id }, data: offer }); // liberado
  });

  it("CHECKs de período, origem, status e janela; agendamento gerado é único", async () => {
    const { t, contact, service, prof } = await setup("wl3");
    const base = { tenantId: t.id, contactId: contact.id, serviceId: service.id, desiredDate: day };
    await rejects(prisma.waitlistEntry.create({ data: { ...base, period: "NIGHT" } }), /check/i);
    await rejects(prisma.waitlistEntry.create({ data: { ...base, source: "SMS" } }), /check/i);
    await rejects(prisma.waitlistEntry.create({ data: { ...base, status: "DONE" } }), /check/i);
    await rejects(prisma.waitlistEntry.create({ data: { ...base, windowStartMin: 600 } }), /check/i);
    await rejects(prisma.waitlistEntry.create({ data: { ...base, windowStartMin: 700, windowEndMin: 600 } }), /check/i);
    await rejects(prisma.waitlistEntry.create({ data: { ...base, windowStartMin: 0, windowEndMin: 1441 } }), /check/i);
    const ok = await prisma.waitlistEntry.create({ data: { ...base, period: "MORNING", windowStartMin: 540, windowEndMin: 720, source: "PANEL" } });

    const startsAt = new Date("2026-11-10T13:00:00.000Z");
    const appt = await prisma.appointment.create({
      data: { tenantId: t.id, contactId: contact.id, serviceId: service.id, professionalId: prof.id, startsAt, endsAt: new Date(startsAt.getTime() + 1800_000), blockEndsAt: new Date(startsAt.getTime() + 1800_000) },
    });
    await prisma.waitlistEntry.update({ where: { id: ok.id }, data: { status: "FULFILLED", appointmentId: appt.id } });
    const other = await prisma.waitlistEntry.create({ data: { ...base, serviceId: service.id, professionalId: prof.id } });
    await rejects(prisma.waitlistEntry.update({ where: { id: other.id }, data: { appointmentId: appt.id } }), /Unique/i);
    // apagar o agendamento não apaga a entrada (SetNull)
    await prisma.appointment.delete({ where: { id: appt.id } });
    expect((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: ok.id } })).appointmentId).toBeNull();
  });
});

describe("item 8 — comissões", () => {
  it("comissão 0–100 no profissional e no override por serviço; nula por padrão", async () => {
    const t = await makeTenant("com");
    const service = await prisma.service.create({ data: { tenantId: t.id, name: "Corte", durationMin: 30 } });
    const prof = await prisma.professional.create({ data: { tenantId: t.id, name: "Ana" } });
    expect(prof.commissionPct).toBeNull();
    await rejects(prisma.professional.update({ where: { id: prof.id }, data: { commissionPct: 100.01 } }), /check/i);
    await rejects(prisma.professional.update({ where: { id: prof.id }, data: { commissionPct: -1 } }), /check/i);
    const ok = await prisma.professional.update({ where: { id: prof.id }, data: { commissionPct: 12.5 } });
    expect(Number(ok.commissionPct)).toBe(12.5);
    const ps = await prisma.professionalService.create({ data: { professionalId: prof.id, serviceId: service.id } });
    expect(ps.commissionPct).toBeNull();
    await rejects(prisma.professionalService.update({ where: { id: ps.id }, data: { commissionPct: 150 } }), /check/i);
    const zero = await prisma.professionalService.update({ where: { id: ps.id }, data: { commissionPct: 0 } });
    expect(Number(zero.commissionPct)).toBe(0);
  });
});
