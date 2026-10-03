/**
 * WhatsApp de cobrança que falhou: conferência ao salvar ("esse número tem WhatsApp?"), correção pelo Admin com
 * auditoria mascarada e o aviso do painel do dono (derivado dos BillingNotice, sem tabela nova). Postgres real.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/lib/auth/guards";

const session: { ctx: TenantContext | null; admin: boolean } = { ctx: null, admin: false };
const numberCheck = vi.hoisted(() => ({ result: "UNKNOWN" as "EXISTS" | "NOT_FOUND" | "UNKNOWN", calls: [] as string[] }));

vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: async (slug: string, roles?: string[]) => {
    const { DomainError } = await import("@/lib/errors");
    if (!session.ctx || session.ctx.tenant.slug !== slug) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
    if (roles && roles.length > 0 && !roles.includes(session.ctx.membership.role)) throw new DomainError("FORBIDDEN", "Sem permissão para esta ação.");
    return session.ctx;
  },
  requirePlatformAdmin: async () => {
    const { DomainError } = await import("@/lib/errors");
    if (!session.admin) throw new DomainError("FORBIDDEN", "Requer acesso de administrador da plataforma.");
    return { id: adminUserId };
  },
}));
vi.mock("@/modules/platform-whatsapp/sender", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/platform-whatsapp/sender")>();
  return {
    ...original,
    checkPlatformWhatsappNumber: async (e164: string) => {
      numberCheck.calls.push(e164);
      return numberCheck.result;
    },
  };
});

const h = await import("./dunning.helpers");
const { updateBillingContactAction, updateBillingContactAsAdminAction } = await import("@/modules/billing/contact-actions");
const { getBillingWhatsappProblem } = await import("@/modules/billing/whatsapp-problem");

const { prisma } = h;
const fixtures = h.newFixtures();
let adminUserId = "";

beforeEach(async () => {
  session.ctx = null;
  session.admin = false;
  numberCheck.result = "UNKNOWN";
  numberCheck.calls.length = 0;
  const admin = await prisma.user.create({ data: { email: `adm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`, passwordHash: "x", emailVerifiedAt: new Date(), isPlatformAdmin: true } });
  adminUserId = admin.id;
  fixtures.userIds.push(admin.id);
});
afterEach(async () => {
  await h.cleanup(fixtures);
  fixtures.tenantIds.length = 0;
  fixtures.userIds.length = 0;
  fixtures.planIds.length = 0;
});
afterAll(async () => {
  await h.dropTestConnection();
  await prisma.$disconnect();
});

async function world(label: string, phone: string | null = "5584999993082") {
  const t = await h.makeTenant(fixtures, label, { billingWhatsappE164: phone });
  const m = await prisma.membership.findFirstOrThrow({ where: { tenantId: t.tenant.id, userId: t.user.id } });
  const asOwner: TenantContext = {
    tenant: { id: t.tenant.id, slug: t.tenant.slug, name: t.tenant.name, timezone: t.tenant.timezone },
    membership: { id: m.id, role: "OWNER" },
    user: { id: t.user.id },
  };
  const sub = await h.makePayingSubscription(fixtures, t.tenant.id, label, { currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000) });
  return { ...t, asOwner, sub };
}

describe("conferir ao salvar", () => {
  it("número novo sem WhatsApp: recusa com NO_WHATSAPP e não grava; 'salvar mesmo assim' grava", async () => {
    const w = await world("nowa");
    session.ctx = w.asOwner;
    numberCheck.result = "NOT_FOUND";
    const refused = await updateBillingContactAction(w.slug, { billingWhatsapp: "+5584988887777" });
    expect(refused).toMatchObject({ ok: false, error: { code: "NO_WHATSAPP" } });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenant.id } })).billingWhatsappE164).toBe("5584999993082");

    const forced = await updateBillingContactAction(w.slug, { billingWhatsapp: "+5584988887777", skipWhatsappCheck: true });
    expect(forced.ok).toBe(true);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenant.id } })).billingWhatsappE164).toBe("5584988887777");
  });

  it("Evolution fora ou sem número ativo (UNKNOWN) salva normalmente; EXISTS também", async () => {
    const w = await world("unk");
    session.ctx = w.asOwner;
    expect((await updateBillingContactAction(w.slug, { billingWhatsapp: "(84) 98888-1111" })).ok).toBe(true);
    numberCheck.result = "EXISTS";
    expect((await updateBillingContactAction(w.slug, { billingWhatsapp: "(84) 98888-2222" })).ok).toBe(true);
  });

  it("só confere quando o número muda (mesmo número ou só e-mail não consultam)", async () => {
    const w = await world("same");
    session.ctx = w.asOwner;
    numberCheck.result = "NOT_FOUND";
    expect((await updateBillingContactAction(w.slug, { billingWhatsapp: "+5584999993082", billingEmail: "fin@x.com.br" })).ok).toBe(true);
    expect((await updateBillingContactAction(w.slug, { billingEmail: "outro@x.com.br" })).ok).toBe(true);
    expect((await updateBillingContactAction(w.slug, { billingWhatsapp: null })).ok).toBe(true);
    expect(numberCheck.calls).toHaveLength(0);
  });
});

describe("Admin corrige o contato de cobrança", () => {
  it("só admin da plataforma; grava, audita com número mascarado e sem o número inteiro", async () => {
    const w = await world("adm");
    const denied = await updateBillingContactAsAdminAction(w.slug, { billingWhatsapp: "(84) 98888-3333" });
    expect(denied).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    session.admin = true;
    const ok = await updateBillingContactAsAdminAction(w.slug, { billingWhatsapp: "(84) 98888-3333" });
    expect(ok.ok).toBe(true);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenant.id } })).billingWhatsappE164).toBe("5584988883333");

    const log = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: w.tenant.id, action: "company.billing_contact_changed" } });
    expect(log.actorRole).toBe("PLATFORM_ADMIN");
    expect(log.actorUserId).toBe(adminUserId);
    const raw = JSON.stringify({ summary: log.summary, changes: log.changes });
    expect(raw).not.toContain("988883333");
    expect(raw).not.toContain("999993082");
    expect(raw).toContain("3333");
  });

  it("número novo sem WhatsApp recusa para o admin também (e o admin pode forçar); empresa inexistente dá NOT_FOUND", async () => {
    const w = await world("adm2");
    session.admin = true;
    numberCheck.result = "NOT_FOUND";
    expect(await updateBillingContactAsAdminAction(w.slug, { billingWhatsapp: "(84) 98888-4444" })).toMatchObject({ ok: false, error: { code: "NO_WHATSAPP" } });
    expect((await updateBillingContactAsAdminAction(w.slug, { billingWhatsapp: "(84) 98888-4444", skipWhatsappCheck: true })).ok).toBe(true);
    expect(await updateBillingContactAsAdminAction("nao-existe-xyz", { billingEmail: "a@b.com.br" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("aviso 'WhatsApp que não chegou' (getBillingWhatsappProblem)", () => {
  async function failedNotice(w: Awaited<ReturnType<typeof world>>, over: { recipient?: string; lastErrorCode?: string; attempts?: number; status?: "FAILED" | "SENT"; sentAt?: Date; step?: string } = {}) {
    const now = new Date();
    return prisma.billingNotice.create({
      data: {
        tenantId: w.tenant.id,
        subscriptionId: w.sub.id,
        step: over.step ?? "TRIAL_ENDING",
        channel: "WHATSAPP",
        cycleKey: `${w.sub.id}:${over.step ?? "TRIAL_ENDING"}:${Math.random()}`,
        status: over.status ?? "FAILED",
        attempts: over.attempts ?? 1,
        notBefore: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
        nextAttemptAt: now,
        lastErrorCode: over.status === "SENT" ? null : (over.lastErrorCode ?? "WHATSAPP_INVALID_NUMBER"),
        recipient: over.recipient ?? "5584999993082",
        recipientKind: "BILLING_WHATSAPP",
        ...(over.status === "SENT" ? { sentAt: over.sentAt ?? new Date(now.getTime() + 60_000) } : {}),
      },
    });
  }
  const contact = (phone: string | null, optedOut = false) => ({ billingWhatsappE164: phone, optedOut });

  it("número recusado no número atual: aparece, com o número formatado", async () => {
    const w = await world("p1");
    await failedNotice(w);
    expect(await getBillingWhatsappProblem(w.tenant.id, contact("5584999993082"))).toMatchObject({ phoneDisplay: "(84) 99999-3082" });
  });

  it("trocou o número: some na hora (a falha era do número antigo)", async () => {
    const w = await world("p2");
    await failedNotice(w);
    expect(await getBillingWhatsappProblem(w.tenant.id, contact("5584988887777"))).toBeNull();
  });

  it("um envio que deu certo depois da falha apaga o aviso", async () => {
    const w = await world("p3");
    const failed = await failedNotice(w);
    expect(await getBillingWhatsappProblem(w.tenant.id, contact("5584999993082"))).not.toBeNull();
    await failedNotice(w, { status: "SENT", step: "TRIAL_ENDED", sentAt: new Date(failed.updatedAt.getTime() + 5_000) });
    expect(await getBillingWhatsappProblem(w.tenant.id, contact("5584999993082"))).toBeNull();
  });

  it("falha genérica de uma tentativa só não acusa o número; a repetida (2+) acusa", async () => {
    const w = await world("p4");
    await failedNotice(w, { lastErrorCode: "WHATSAPP_SEND_FAILED", attempts: 1 });
    expect(await getBillingWhatsappProblem(w.tenant.id, contact("5584999993082"))).toBeNull();
    await failedNotice(w, { lastErrorCode: "WHATSAPP_SEND_FAILED", attempts: 2, step: "TRIAL_ENDED" });
    expect(await getBillingWhatsappProblem(w.tenant.id, contact("5584999993082"))).not.toBeNull();
  });

  it("sem número, avisos desligados ou falha de outra empresa: sem aviso", async () => {
    const w = await world("p5");
    const other = await world("p5b");
    await failedNotice(w);
    expect(await getBillingWhatsappProblem(w.tenant.id, contact(null))).toBeNull();
    expect(await getBillingWhatsappProblem(w.tenant.id, contact("5584999993082", true))).toBeNull();
    expect(await getBillingWhatsappProblem(other.tenant.id, contact("5584999993082"))).toBeNull();
  });
});
