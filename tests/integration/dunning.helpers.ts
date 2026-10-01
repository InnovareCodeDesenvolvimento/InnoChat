/**
 * Apoio dos testes de integração da régua de cobrança (F2, docs/regua-de-cobranca.md). Fica fora dos arquivos
 * `*.test.ts` para os três (escada, motor, cadastro/contato) usarem o mesmo dublê de SMTP e de WhatsApp e as mesmas
 * fábricas de empresa. Os relógios são sempre INJETADOS (`runBillingTick(now, ...)`): os avisos só saem dentro da
 * janela de horário, então nenhum teste depende da hora em que roda.
 */
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

export const prisma = getPrisma();

// --- SMTP -------------------------------------------------------------------------------------------

export type SentMail = { to: string; subject: string; text: string };
export const sentEmails: SentMail[] = [];
export const mailControl: { mode: "ok" | "fail" | "not_configured" | "throw"; gate: Promise<void> | null } = { mode: "ok", gate: null };

export function fakeSendMail(actual: { SmtpNotConfiguredError: new () => Error }) {
  return vi.fn(async (input: SentMail) => {
    if (mailControl.gate) await mailControl.gate;
    if (mailControl.mode === "not_configured") throw new actual.SmtpNotConfiguredError();
    if (mailControl.mode === "throw") throw new Error("boom");
    if (mailControl.mode === "fail") return { sent: false };
    sentEmails.push({ to: input.to, subject: input.subject, text: input.text });
    return { sent: true };
  });
}

export function resetMail() {
  sentEmails.length = 0;
  mailControl.mode = "ok";
  mailControl.gate = null;
}

// --- WhatsApp da plataforma ----------------------------------------------------------------------------

export type WhatsappOutcome = "SENT" | "NO_PLATFORM_NUMBER" | "CHANNEL_DOWN" | "FAILED" | "BLOCKED_LOOP";
export const whatsapp: { sent: { toE164: string; text: string; tenantId: string; noticeId: string }[]; outcome: WhatsappOutcome; calls: number } = {
  sent: [],
  outcome: "SENT",
  calls: 0,
};

export function resetWhatsapp() {
  whatsapp.sent.length = 0;
  whatsapp.outcome = "SENT";
  whatsapp.calls = 0;
}

let testConnectionId: string | null = null;

/** Conexão da plataforma APOSENTADA só para satisfazer a FK de `BillingNotice.platformConnectionId` nos testes. */
export async function ensureTestConnection(): Promise<string> {
  if (testConnectionId) return testConnectionId;
  const id = randomUUID().slice(0, 8);
  const connection = await prisma.platformWhatsappConnection.create({
    data: {
      instanceName: `it-dun-conn-${id}`,
      webhookTokenHash: `hash-${id}-${randomUUID()}`,
      label: "Teste da régua",
      status: "DISCONNECTED",
      phoneE164: "5584900000000",
      role: "RETIRED",
      retiredAt: new Date(),
      retiredReason: "REPLACED",
    },
  });
  testConnectionId = connection.id;
  return connection.id;
}

export async function dropTestConnection() {
  if (!testConnectionId) return;
  await prisma.platformWhatsappConnection.deleteMany({ where: { id: testConnectionId } });
  testConnectionId = null;
}

/** Dublê do `sendPlatformWhatsapp` (F4): grava o que "saiu" e devolve o resultado configurado. */
export async function fakeSendWhatsapp(args: { toE164: string; text: string; tenantId: string; noticeId: string }) {
  whatsapp.calls += 1;
  if (whatsapp.outcome !== "SENT") return { outcome: whatsapp.outcome };
  whatsapp.sent.push(args);
  return { outcome: "SENT" as const, connectionId: await ensureTestConnection(), senderPhoneE164: "5584900000000", providerMessageId: `pm-${whatsapp.sent.length}` };
}

/** Opções do tick que trocam o sender real pelo dublê e tiram a espera entre envios. */
export const tickDispatch = { sendWhatsapp: fakeSendWhatsapp, sleep: async () => undefined };

// --- Fábricas -----------------------------------------------------------------------------------------

export type Fixtures = { tenantIds: string[]; userIds: string[]; planIds: string[] };
export const newFixtures = (): Fixtures => ({ tenantIds: [], userIds: [], planIds: [] });

export async function cleanup(f: Fixtures) {
  await prisma.tenant.deleteMany({ where: { id: { in: f.tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: f.userIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: f.planIds } } });
}

export async function makePlan(f: Fixtures, label: string, priceCents = 4990) {
  const plan = await prisma.plan.create({
    data: { code: `it-dun-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`, name: "Plano IT", priceCents, maxWhatsappNumbers: 99, maxProfessionals: 99, active: false, sortOrder: 999 },
  });
  f.planIds.push(plan.id);
  return plan;
}

export type TenantOpts = {
  timezone?: string;
  billingEmail?: string | null;
  billingWhatsappE164?: string | null;
  optOut?: boolean;
  /** Número de cobrança SEM o "SIM" de posse (padrão: confirmado, para os testes da régua não esbarrarem no limite de 1 por dia). */
  unconfirmedPhone?: boolean;
  ownerName?: string | null;
  document?: string | null;
};

/** Empresa com OWNER, no fuso de São Paulo e com WhatsApp de cobrança (os dois ligados, como no cadastro novo). */
export async function makeTenant(f: Fixtures, label: string, opts: TenantOpts = {}) {
  const slug = `it-dun-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const tenant = await prisma.tenant.create({
    data: {
      slug,
      name: `Salão ${label}`,
      timezone: opts.timezone ?? "America/Sao_Paulo",
      billingEmail: opts.billingEmail ?? null,
      billingWhatsappE164: opts.billingWhatsappE164 === undefined ? "5584999990001" : opts.billingWhatsappE164,
      billingWhatsappOptOutAt: opts.optOut ? new Date("2026-01-01T00:00:00Z") : null,
      billingWhatsappConfirmedAt: opts.unconfirmedPhone ? null : new Date("2026-01-01T00:00:00Z"),
      document: opts.document === undefined ? null : opts.document,
    },
  });
  f.tenantIds.push(tenant.id);
  const email = `${slug}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash: "x", emailVerifiedAt: new Date(), name: opts.ownerName === undefined ? "Ana Souza" : opts.ownerName } });
  f.userIds.push(user.id);
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });
  return { tenant, user, email, slug };
}

export async function makePayingSubscription(
  f: Fixtures,
  tenantId: string,
  label: string,
  over: { currentPeriodEnd: Date; status?: "ACTIVE" | "PAST_DUE" | "SUSPENDED"; priceCents?: number; firstPaidAt?: Date | null; createdAt?: Date },
) {
  const plan = await makePlan(f, label, over.priceCents ?? 4990);
  return prisma.subscription.create({
    data: {
      tenantId,
      planId: plan.id,
      status: over.status ?? "ACTIVE",
      currentPeriodEnd: over.currentPeriodEnd,
      firstPaidAt: over.firstPaidAt === undefined ? new Date("2026-06-01T00:00:00Z") : over.firstPaidAt,
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    },
  });
}

export async function makeOpenInvoice(
  subscriptionId: string,
  over: { periodStart: Date; dueAt: Date; createdAt: Date; amountCents?: number; pix?: string | null; pixExpiresAt?: Date | null; isTrialConversion?: boolean },
) {
  return prisma.invoice.create({
    data: {
      subscriptionId,
      amountCents: over.amountCents ?? 4990,
      periodStart: over.periodStart,
      periodEnd: new Date(over.periodStart.getTime() + 30 * 86_400_000),
      dueAt: over.dueAt,
      status: "OPEN",
      createdAt: over.createdAt,
      pixCopyPaste: over.pix === undefined ? "00020126PIXCOPIAECOLA" : over.pix,
      pixExpiresAt: over.pixExpiresAt === undefined ? new Date("2036-01-01T00:00:00Z") : over.pixExpiresAt,
      isTrialConversion: over.isTrialConversion ?? false,
    },
  });
}

export const at = (iso: string) => new Date(iso);

export async function noticesOf(subscriptionId: string) {
  return prisma.billingNotice.findMany({ where: { subscriptionId }, orderBy: [{ createdAt: "asc" }, { step: "asc" }, { channel: "asc" }] });
}

export const stepChannelStatus = (rows: { step: string; channel: string; status: string }[]) => rows.map((r) => `${r.step}/${r.channel}/${r.status}`).sort();
