/**
 * Fixtures do registro de envios de cobrança e da visão financeira (F6): empresa com assinatura, fatura,
 * avisos em cada situação e eventos de cobrança. Prisma direto (a UI não cria avisos: quem cria é o tick).
 * Tudo nasce com o prefixo da rodada (`E2E_RUN_PREFIX`) no nome, para o teardown limpar por `contains`.
 */
import { prisma } from "./db";

const DAY = 86_400_000;

export type SeedPlan = { id: string; priceCents: number };

export type SeededCompany = {
  tenantId: string;
  name: string;
  slug: string;
  ownerEmail: string;
  subscriptionId: string;
  invoiceId: string;
  notices: {
    sentEmail: string;
    failedWhatsapp: string;
    skippedNoNumber: string;
    pendingEmail: string;
    sentNoSnapshot: string;
    oldMasked: string;
  };
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Empresa com assinatura ACTIVE, uma fatura aberta e um e-mail de dono. */
export async function seedCompany(opts: {
  name: string;
  plan: SeedPlan;
  status?: "TRIALING" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELED";
  ownerEmail?: string;
  phone?: string;
  invoiceDueInDays?: number;
  invoiceAmountCents?: number;
}) {
  const slug = slugify(opts.name);
  const ownerEmail = opts.ownerEmail ?? `${slug}@e2e.innochat.local`;
  const tenant = await prisma.tenant.create({
    data: { slug, name: opts.name, timezone: "America/Sao_Paulo", document: "52998224725" },
  });
  const user = await prisma.user.create({
    data: { email: ownerEmail, name: "Dona da empresa", passwordHash: "x", emailVerifiedAt: new Date() },
  });
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });
  const status = opts.status ?? "ACTIVE";
  const dueInDays = opts.invoiceDueInDays ?? 3;
  const subscription = await prisma.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: opts.plan.id,
      status,
      currentPeriodEnd: new Date(Date.now() + dueInDays * DAY),
      firstPaidAt: status === "TRIALING" ? null : new Date(Date.now() - 60 * DAY),
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      subscriptionId: subscription.id,
      amountCents: opts.invoiceAmountCents ?? opts.plan.priceCents,
      periodStart: new Date(Date.now() + (dueInDays - 30) * DAY),
      periodEnd: new Date(Date.now() + dueInDays * DAY),
      dueAt: new Date(Date.now() + dueInDays * DAY),
      status: "OPEN",
    },
  });
  return { tenant, user, subscription, invoice, slug, ownerEmail };
}

type NoticeSeed = {
  step: string;
  channel: "EMAIL" | "WHATSAPP";
  status: "PENDING" | "SENDING" | "SENT" | "FAILED" | "SKIPPED";
  recipient?: string | null;
  recipientMasked?: string | null;
  recipientKind?: "OWNER" | "BILLING_EMAIL" | "BILLING_WHATSAPP" | null;
  skippedReason?: string;
  attempts?: number;
  lastErrorCode?: string;
  subject?: string;
  text?: string;
  senderPhoneE164?: string;
  hoursAgo: number;
  withInvoice?: boolean;
};

async function createNotice(company: { tenantId: string; subscriptionId: string; invoiceId: string }, tag: string, n: NoticeSeed): Promise<string> {
  const at = new Date(Date.now() - n.hoursAgo * 3_600_000);
  const created = await prisma.billingNotice.create({
    data: {
      tenantId: company.tenantId,
      subscriptionId: company.subscriptionId,
      invoiceId: n.withInvoice === false ? null : company.invoiceId,
      step: n.step,
      channel: n.channel,
      cycleKey: `${company.invoiceId}:${tag}`,
      status: n.status,
      skippedReason: n.status === "SKIPPED" ? n.skippedReason : undefined,
      attempts: n.attempts ?? (n.status === "PENDING" ? 0 : 1),
      notBefore: at,
      expiresAt: new Date(at.getTime() + 3 * DAY),
      nextAttemptAt: n.status === "PENDING" ? new Date(Date.now() + 3_600_000) : at,
      lastErrorCode: n.lastErrorCode,
      sentAt: n.status === "SENT" ? at : undefined,
      recipient: n.recipient ?? null,
      recipientKind: n.recipientKind ?? null,
      recipientMasked: n.recipientMasked ?? null,
      renderedSubject: n.subject ?? null,
      renderedText: n.text ?? null,
      senderPhoneE164: n.senderPhoneE164,
      createdAt: at,
      updatedAt: at,
    },
  });
  return created.id;
}

/** Os seis avisos que cobrem cada situação da tela de envios. */
export async function seedNotices(company: { tenantId: string; subscriptionId: string; invoiceId: string; ownerEmail: string }, phone = "5584999991234") {
  const sentEmail = await createNotice(company, "sent-email", {
    step: "DUE_D1",
    channel: "EMAIL",
    status: "SENT",
    recipient: company.ownerEmail,
    recipientKind: "OWNER",
    subject: "Sua mensalidade vence amanhã",
    text: "Oi, tudo bem?\n\nSua mensalidade do InnoChat vence amanhã. O Pix já está no painel, na tela Assinatura.\n\nQualquer dúvida, é só responder este e-mail.",
    hoursAgo: 2,
  });
  const failedWhatsapp = await createNotice(company, "failed-wa", {
    step: "DUE_D0",
    channel: "WHATSAPP",
    status: "FAILED",
    recipient: phone,
    recipientKind: "BILLING_WHATSAPP",
    // Esgotado (NOTICE_MAX_ATTEMPTS = 5): só FAILED sem nova tentativa automática pode ser reenviado.
    attempts: 5,
    lastErrorCode: "WHATSAPP_SEND_FAILED",
    senderPhoneE164: "5584988880000",
    hoursAgo: 5,
  });
  const skippedNoNumber = await createNotice(company, "skipped-wa", {
    step: "SUSPENDED",
    channel: "WHATSAPP",
    status: "SKIPPED",
    recipient: phone,
    recipientKind: "BILLING_WHATSAPP",
    skippedReason: "NO_PLATFORM_NUMBER",
    attempts: 0,
    hoursAgo: 26,
    withInvoice: false,
  });
  const pendingEmail = await createNotice(company, "pending-email", {
    step: "INVOICE_CREATED",
    channel: "EMAIL",
    status: "PENDING",
    recipient: company.ownerEmail,
    recipientKind: "OWNER",
    hoursAgo: 1,
  });
  const sentNoSnapshot = await createNotice(company, "sent-nosnap", {
    step: "INVOICE_CREATED",
    channel: "EMAIL",
    status: "SENT",
    recipient: company.ownerEmail,
    recipientKind: "OWNER",
    hoursAgo: 50,
  });
  const oldMasked = await createNotice(company, "old-masked", {
    step: "TRIAL_T1",
    channel: "EMAIL",
    status: "SENT",
    recipient: null,
    recipientMasked: "do***@e2e.innochat.local",
    hoursAgo: 200,
    withInvoice: false,
  });
  return { sentEmail, failedWhatsapp, skippedNoNumber, pendingEmail, sentNoSnapshot, oldMasked };
}

/** Eventos de cobrança para a linha do tempo da empresa. */
export async function seedEvents(company: { tenantId: string; subscriptionId: string; invoiceId: string }) {
  const mk = (type: string, daysAgo: number, extra: { from?: "ACTIVE" | "PAST_DUE" | "SUSPENDED"; to?: "ACTIVE" | "PAST_DUE" | "SUSPENDED"; actor?: string } = {}) =>
    prisma.billingEvent.create({
      data: {
        tenantId: company.tenantId,
        subscriptionId: company.subscriptionId,
        invoiceId: company.invoiceId,
        type,
        fromStatus: extra.from,
        toStatus: extra.to,
        actorType: extra.actor ?? "SYSTEM",
        createdAt: new Date(Date.now() - daysAgo * DAY),
      },
    });
  await mk("INVOICE_CREATED", 6);
  await mk("STATUS_CHANGED", 4, { from: "ACTIVE", to: "PAST_DUE" });
  await mk("PAYMENT_CONFIRMED", 3);
  await mk("MANUAL_REACTIVATE", 1, { actor: "ADMIN" });
}

export async function seedCompanyWithNotices(opts: { name: string; plan: SeedPlan; ownerEmail?: string; phone?: string }): Promise<SeededCompany> {
  const c = await seedCompany({ name: opts.name, plan: opts.plan, ownerEmail: opts.ownerEmail, phone: opts.phone });
  const ref = { tenantId: c.tenant.id, subscriptionId: c.subscription.id, invoiceId: c.invoice.id, ownerEmail: c.ownerEmail };
  const notices = await seedNotices(ref, opts.phone);
  await seedEvents(ref);
  return {
    tenantId: c.tenant.id,
    name: opts.name,
    slug: c.slug,
    ownerEmail: c.ownerEmail,
    subscriptionId: c.subscription.id,
    invoiceId: c.invoice.id,
    notices,
  };
}

/** Avisos a mais (e-mails enviados de uma etapa só), para a lista passar de uma página. */
export async function seedExtraNotices(company: { tenantId: string; subscriptionId: string; invoiceId: string; ownerEmail: string }, count: number) {
  for (let i = 0; i < count; i += 1) {
    const at = new Date(Date.now() - (300 + i) * 3_600_000);
    await prisma.billingNotice.create({
      data: {
        tenantId: company.tenantId,
        subscriptionId: company.subscriptionId,
        invoiceId: company.invoiceId,
        step: "SUSP_3",
        channel: "EMAIL",
        cycleKey: `${company.invoiceId}:extra-${i}`,
        status: "SENT",
        attempts: 1,
        notBefore: at,
        expiresAt: new Date(at.getTime() + 3 * 86_400_000),
        nextAttemptAt: at,
        sentAt: at,
        recipient: company.ownerEmail,
        recipientKind: "OWNER",
        createdAt: at,
        updatedAt: at,
      },
    });
  }
}
