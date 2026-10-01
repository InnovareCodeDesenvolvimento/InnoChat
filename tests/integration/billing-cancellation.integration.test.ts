/**
 * Cancelamento da assinatura pelo painel (Termos §9; docs/contratos.md, "Cancelamento pelo
 * painel") contra Postgres real: agenda (ACTIVE/TRIALING), cancela na hora (SUSPENDED), desfaz,
 * o tick efetiva na data (números desconectados, CANCELED), nenhuma fatura depois de agendar,
 * idempotência, papéis e isolamento entre empresas, reativação paga. `sendMail`, a Evolution e o
 * Mercado Pago são dublês.
 */
import { randomUUID } from "node:crypto";
import { addDays, addHours, addMonths } from "date-fns";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { TenantContext } from "@/lib/auth/guards";
import type { EvolutionClient } from "@/modules/whatsapp/evolution-client";

const session: { ctx: TenantContext | null } = { ctx: null };
vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: async (slug: string, roles?: string[]) => {
    const { DomainError } = await import("@/lib/errors");
    if (!session.ctx || session.ctx.tenant.slug !== slug) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
    if (roles && roles.length > 0 && !roles.includes(session.ctx.membership.role)) throw new DomainError("FORBIDDEN", "Sem permissão para esta ação.");
    return session.ctx;
  },
}));

const sentEmails: { to: string; subject: string; text: string }[] = [];
vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return {
    ...actual,
    sendMail: vi.fn(async (input: { to: string; subject: string; text: string }) => {
      sentEmails.push(input);
      return { sent: true };
    }),
  };
});

const logoutCalls: string[] = [];
vi.mock("@/modules/whatsapp/evolution-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/whatsapp/evolution-client")>();
  return {
    ...original,
    getEvolutionClient: async () =>
      ({
        logout: async (instanceName: string) => {
          logoutCalls.push(instanceName);
        },
      }) as unknown as EvolutionClient,
  };
});

const { cancelSubscriptionAction, undoCancellationAction, reactivateSubscriptionAction } = await import("@/modules/billing/actions");
const { requestCancellation, undoCancellation, startReactivation } = await import("@/modules/billing/cancellation");
const { applyInvoicePayment, assertTenantCanWrite } = await import("@/modules/billing/service");
const { runBillingTick } = await import("@/modules/billing/tick");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { listPlatformNotifications } = await import("@/modules/platform-notifications/service");

const prisma = getPrisma();
const cleanupTenantIds: string[] = [];
const cleanupUserIds: string[] = [];
const cleanupPlanIds: string[] = [];

beforeEach(() => {
  sentEmails.length = 0;
  logoutCalls.length = 0;
  session.ctx = null;
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: cleanupTenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: cleanupPlanIds } } });
  await prisma.$disconnect();
});

type SubOverrides = Partial<{
  status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELED";
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  firstPaidAt: Date | null;
}>;

async function makeTenant(label: string, sub: SubOverrides = {}) {
  const slug = `it-cancel-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const tenant = await prisma.tenant.create({ data: { slug, name: `Cancel ${label}`, timezone: "UTC" } });
  cleanupTenantIds.push(tenant.id);
  const plan = await prisma.plan.create({
    data: { code: `${slug}-plan`, name: "Plano IT", priceCents: 4990, maxWhatsappNumbers: 3, maxProfessionals: 3, active: false, sortOrder: 999 },
  });
  cleanupPlanIds.push(plan.id);
  const owner = await prisma.user.create({ data: { email: `${slug}-owner@example.com`, passwordHash: "x", emailVerifiedAt: new Date() } });
  const staff = await prisma.user.create({ data: { email: `${slug}-staff@example.com`, passwordHash: "x", emailVerifiedAt: new Date() } });
  cleanupUserIds.push(owner.id, staff.id);
  const ownerMembership = await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, role: "OWNER" } });
  const staffMembership = await prisma.membership.create({ data: { userId: staff.id, tenantId: tenant.id, role: "STAFF" } });
  const subscription = await prisma.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: sub.status ?? "ACTIVE",
      currentPeriodEnd: sub.currentPeriodEnd ?? addDays(new Date(), 20),
      trialEndsAt: sub.trialEndsAt ?? null,
      firstPaidAt: sub.firstPaidAt === undefined ? new Date() : sub.firstPaidAt,
    },
  });
  const instance = await prisma.whatsappInstance.create({
    data: {
      tenantId: tenant.id,
      instanceName: `inst-${slug}`,
      label: "Principal",
      status: "CONNECTED",
      phoneE164: "+5511999990000",
      webhookToken: randomUUID(),
    },
  });
  const ctxFor = (userId: string, role: "OWNER" | "STAFF", membershipId: string): TenantContext => ({
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, timezone: "UTC" },
    membership: { id: membershipId, role },
    user: { id: userId, email: "x@example.com" },
  } as unknown as TenantContext);
  return {
    tenant,
    plan,
    subscription,
    instance,
    owner,
    asOwner: () => (session.ctx = ctxFor(owner.id, "OWNER", ownerMembership.id)),
    asStaff: () => (session.ctx = ctxFor(staff.id, "STAFF", staffMembership.id)),
  };
}

async function openInvoice(subscriptionId: string, periodStart: Date, extra: { isTrialConversion?: boolean } = {}) {
  return prisma.invoice.create({
    data: {
      subscriptionId,
      amountCents: 4990,
      periodStart,
      periodEnd: addMonths(periodStart, 1),
      dueAt: periodStart,
      status: "OPEN",
      isTrialConversion: extra.isTrialConversion ?? false,
    },
  });
}

describe("cancelar assinatura ATIVA (paga) — agenda para o fim do período", () => {
  it("agenda: nada muda até a data, fatura em aberto é anulada, motivo/data gravados, e-mail com a data e o lembrete do CSV", async () => {
    const t = await makeTenant("active");
    await openInvoice(t.subscription.id, t.subscription.currentPeriodEnd);
    t.asOwner();

    const result = await cancelSubscriptionAction(t.tenant.slug, { reason: "  estou fechando o salão  " });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ mode: "SCHEDULED", alreadyRequested: false });
    expect(result.data.endsAt).toBe(t.subscription.currentPeriodEnd.toISOString());

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: t.subscription.id } });
    expect(sub.status).toBe("ACTIVE");
    expect(sub.cancelAtPeriodEnd).toBe(true);
    expect(sub.cancelReason).toBe("estou fechando o salão");
    expect(sub.cancelRequestedAt).not.toBeNull();
    expect(sub.canceledAt).toBeNull();

    // Até a data, tudo funciona: escrita liberada, número continua conectado, nenhum logout.
    await expect(assertTenantCanWrite(t.tenant.id)).resolves.toBeUndefined();
    expect((await prisma.whatsappInstance.findUniqueOrThrow({ where: { id: t.instance.id } })).status).toBe("CONNECTED");
    expect(logoutCalls).toHaveLength(0);

    // Nenhuma cobrança futura: a fatura em aberto foi anulada.
    expect(await prisma.invoice.count({ where: { subscriptionId: t.subscription.id, status: "OPEN" } })).toBe(0);

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe(`${t.tenant.slug}-owner@example.com`);
    expect(sentEmails[0]!.text).toContain("CSV");
    expect(sentEmails[0]!.text).toContain("90 dias");
  });

  it("idempotência: clique duplo concorrente agenda uma vez só (1 e-mail, motivo do primeiro)", async () => {
    const t = await makeTenant("double");
    t.asOwner();

    const [a, b] = await Promise.all([
      requestCancellation(t.tenant.id, { reason: "primeiro" }),
      requestCancellation(t.tenant.id, { reason: "segundo" }),
    ]);
    expect([a.alreadyRequested, b.alreadyRequested].sort()).toEqual([false, true]);
    expect(sentEmails).toHaveLength(1);

    const again = await requestCancellation(t.tenant.id, { reason: "terceiro" });
    expect(again).toMatchObject({ mode: "SCHEDULED", alreadyRequested: true });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: t.subscription.id } });
    expect(["primeiro", "segundo"]).toContain(sub.cancelReason);
    expect(sentEmails).toHaveLength(1);
  });

  it("nenhuma fatura é gerada depois de agendar (mesmo a 2 dias do vencimento), nem ao rodar o tick duas vezes", async () => {
    const t = await makeTenant("noinvoice", { currentPeriodEnd: addDays(new Date(), 2) });
    t.asOwner();
    await requestCancellation(t.tenant.id, {});

    const { gateway } = createMockMercadoPagoGateway();
    await runBillingTick(new Date(), gateway);
    await runBillingTick(new Date(), gateway);
    expect(await prisma.invoice.count({ where: { subscriptionId: t.subscription.id } })).toBe(0);
  });

  it("desfazer: limpa o agendamento, reabre a fatura anulada pelo pedido, e é idempotente", async () => {
    const t = await makeTenant("undo");
    const invoice = await openInvoice(t.subscription.id, t.subscription.currentPeriodEnd);
    t.asOwner();
    await requestCancellation(t.tenant.id, { reason: "teste" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("VOID");

    const first = await undoCancellationAction(t.tenant.slug);
    expect(first).toMatchObject({ ok: true, data: { undone: true } });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: t.subscription.id } });
    expect(sub).toMatchObject({ cancelAtPeriodEnd: false, cancelRequestedAt: null, cancelReason: null, status: "ACTIVE" });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("OPEN");

    const second = await undoCancellationAction(t.tenant.slug);
    expect(second).toMatchObject({ ok: true, data: { undone: false } });
  });

  it("desfazer depois da data é recusado (INVALID_STATE)", async () => {
    const t = await makeTenant("undo-late");
    await requestCancellation(t.tenant.id, {});
    await expect(undoCancellation(t.tenant.id, { now: addDays(t.subscription.currentPeriodEnd, 1) })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("o tick efetiva na data: CANCELED, canceledAt = fim do período, números desconectados, sem e-mail de suspensão; 2ª rodada não muda nada", async () => {
    const periodEnd = addHours(new Date(), -2);
    const t = await makeTenant("tick", { currentPeriodEnd: addDays(new Date(), 1) });
    await requestCancellation(t.tenant.id, { reason: "x" });
    // A data chega: o fim do período fica no passado.
    await prisma.subscription.update({ where: { id: t.subscription.id }, data: { currentPeriodEnd: periodEnd } });
    sentEmails.length = 0;

    await runBillingTick(new Date(), createMockMercadoPagoGateway().gateway);

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: t.subscription.id } });
    expect(sub.status).toBe("CANCELED");
    expect(sub.canceledAt?.getTime()).toBe(periodEnd.getTime());
    const instance = await prisma.whatsappInstance.findUniqueOrThrow({ where: { id: t.instance.id } });
    expect(instance).toMatchObject({ status: "DISCONNECTED", phoneE164: null, disconnectedAt: null });
    expect(logoutCalls).toEqual([t.instance.instanceName]);
    expect(sentEmails.filter((e) => e.to.startsWith(t.tenant.slug))).toHaveLength(0);
    await expect(assertTenantCanWrite(t.tenant.id)).rejects.toMatchObject({ code: "TENANT_SUSPENDED" });

    await runBillingTick(new Date(), createMockMercadoPagoGateway().gateway);
    const sub2 = await prisma.subscription.findUniqueOrThrow({ where: { id: t.subscription.id } });
    expect(sub2.canceledAt?.getTime()).toBe(periodEnd.getTime());
    expect(logoutCalls).toHaveLength(1);
  });
});

describe("cancelar em TRIAL — vale no fim do teste", () => {
  it("agenda para trialEndsAt, anula a fatura do teste e o tick cancela depois do fim do teste", async () => {
    const trialEndsAt = addDays(new Date(), 2);
    const t = await makeTenant("trial", { status: "TRIALING", trialEndsAt, currentPeriodEnd: trialEndsAt, firstPaidAt: null });
    const invoice = await openInvoice(t.subscription.id, trialEndsAt, { isTrialConversion: true });
    t.asOwner();

    const result = await cancelSubscriptionAction(t.tenant.slug, {});
    expect(result).toMatchObject({ ok: true, data: { mode: "SCHEDULED", alreadyRequested: false } });
    if (!result.ok) return;
    expect(result.data.endsAt).toBe(trialEndsAt.toISOString());
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("VOID");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: t.subscription.id } })).status).toBe("TRIALING");
    await expect(assertTenantCanWrite(t.tenant.id)).resolves.toBeUndefined();

    // Passou o fim do teste: vai direto a CANCELED (sem PAST_DUE/SUSPENDED).
    await prisma.subscription.update({ where: { id: t.subscription.id }, data: { trialEndsAt: addHours(new Date(), -1), currentPeriodEnd: addHours(new Date(), -1) } });
    await runBillingTick(new Date(), createMockMercadoPagoGateway().gateway);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: t.subscription.id } });
    expect(sub.status).toBe("CANCELED");
    expect((await prisma.whatsappInstance.findUniqueOrThrow({ where: { id: t.instance.id } })).status).toBe("DISCONNECTED");
  });
});

describe("cancelar assinatura SUSPENSA — imediato", () => {
  it("cancela na hora: CANCELED, números desconectados, faturas anuladas, e-mail de confirmação", async () => {
    const t = await makeTenant("suspended", { status: "SUSPENDED", currentPeriodEnd: addDays(new Date(), -10) });
    const invoice = await openInvoice(t.subscription.id, addDays(new Date(), -10));
    t.asOwner();

    const result = await cancelSubscriptionAction(t.tenant.slug, { reason: "não uso mais" });
    expect(result).toMatchObject({ ok: true, data: { mode: "IMMEDIATE", alreadyRequested: false } });

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: t.subscription.id } });
    expect(sub.status).toBe("CANCELED");
    expect(sub.canceledAt).not.toBeNull();
    expect(sub.cancelReason).toBe("não uso mais");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("VOID");
    expect((await prisma.whatsappInstance.findUniqueOrThrow({ where: { id: t.instance.id } })).status).toBe("DISCONNECTED");
    expect(logoutCalls).toEqual([t.instance.instanceName]);
    expect(sentEmails).toHaveLength(1);

    const again = await cancelSubscriptionAction(t.tenant.slug, {});
    expect(again).toMatchObject({ ok: true, data: { mode: "IMMEDIATE", alreadyRequested: true } });
    expect(sentEmails).toHaveLength(1);
    expect(logoutCalls).toHaveLength(1);
  });
});

describe("permissões e isolamento", () => {
  it("STAFF não cancela nem desfaz (FORBIDDEN) e nada muda", async () => {
    const t = await makeTenant("staff");
    t.asStaff();
    expect(await cancelSubscriptionAction(t.tenant.slug, {})).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await undoCancellationAction(t.tenant.slug)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await reactivateSubscriptionAction(t.tenant.slug)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: t.subscription.id } })).cancelAtPeriodEnd).toBe(false);
  });

  it("dono de OUTRA empresa não cancela esta (NOT_FOUND) e nada muda", async () => {
    const a = await makeTenant("iso-a");
    const b = await makeTenant("iso-b");
    a.asOwner();
    expect(await cancelSubscriptionAction(b.tenant.slug, {})).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: b.subscription.id } })).cancelAtPeriodEnd).toBe(false);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: a.subscription.id } })).cancelAtPeriodEnd).toBe(false);
  });

  it("motivo acima de 500 caracteres é recusado na validação", async () => {
    const t = await makeTenant("longreason");
    t.asOwner();
    const result = await cancelSubscriptionAction(t.tenant.slug, { reason: "a".repeat(501) });
    expect(result.ok).toBe(false);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: t.subscription.id } })).cancelAtPeriodEnd).toBe(false);
  });
});

describe("aviso ao admin da plataforma", () => {
  it("cancelamento agendado aparece no sino do admin com o motivo", async () => {
    const t = await makeTenant("notify");
    await requestCancellation(t.tenant.id, { reason: "ficou caro" });
    const { items } = await listPlatformNotifications("usuario-inexistente");
    const item = items.find((i) => i.id.startsWith(`cancelreq:${t.subscription.id}:`));
    expect(item).toMatchObject({ kind: "TENANT_CANCEL_SCHEDULED", tenant: { id: t.tenant.id } });
    expect(item?.body).toContain("ficou caro");

    // Desfeito: o aviso some.
    await undoCancellation(t.tenant.id);
    const after = await listPlatformNotifications("usuario-inexistente");
    expect(after.items.find((i) => i.id.startsWith(`cancelreq:${t.subscription.id}:`))).toBeUndefined();
  });
});

describe("reativação pelo dono", () => {
  it("gera 1 fatura (idempotente), e o pagamento volta a ACTIVE com o ciclo contado do pagamento e o cancelamento zerado", async () => {
    const t = await makeTenant("reactivate", { status: "SUSPENDED", currentPeriodEnd: addDays(new Date(), -10) });
    await requestCancellation(t.tenant.id, { reason: "pausa" });
    const { gateway } = createMockMercadoPagoGateway();

    const [a, b] = await Promise.all([startReactivation(t.tenant.id, { gateway }), startReactivation(t.tenant.id, { gateway })]);
    expect(a.invoiceId).toBe(b.invoiceId);
    expect(await prisma.invoice.count({ where: { subscriptionId: t.subscription.id, status: "OPEN" } })).toBe(1);

    const paidAt = new Date();
    await applyInvoicePayment(a.invoiceId, paidAt);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: t.subscription.id } });
    expect(sub.status).toBe("ACTIVE");
    expect(sub).toMatchObject({ canceledAt: null, cancelAtPeriodEnd: false, cancelReason: null, cancelRequestedAt: null });
    expect(sub.currentPeriodEnd.getTime()).toBeGreaterThan(addDays(paidAt, 27).getTime());
    await expect(assertTenantCanWrite(t.tenant.id)).resolves.toBeUndefined();
  });

  it("só quem está CANCELED pode reativar (INVALID_STATE)", async () => {
    const t = await makeTenant("reactivate-active");
    t.asOwner();
    expect(await reactivateSubscriptionAction(t.tenant.slug)).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
  });
});
