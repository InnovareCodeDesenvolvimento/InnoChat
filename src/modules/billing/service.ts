import crypto from "node:crypto";
import type { Prisma } from "@/lib/db/types";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { sendMail, SmtpNotConfiguredError, loadEmailContext, invoiceGeneratedEmail, subscriptionSuspendedEmail, type SendMailInput } from "@/lib/email";
import { getPublicBaseUrl } from "@/lib/public-url";
import { CANCEL_AFTER_SUSPENDED_TRIAL_DAYS, computeTrialEndsAt, effectiveStatus, validateCpfCnpj, type SubscriptionStatus } from "@/core/billing";
import { formatCentsBRL, formatDateBR } from "./format";
import { recordBillingEvent } from "./dunning/events";
import { getActiveMercadoPagoCredentials, type MercadoPagoEnv } from "@/modules/platform/mercadopago-config";
import { getMercadoPagoGateway, getMercadoPagoGatewayForEnvironment, MercadoPagoApiError, type MercadoPagoFailureKind, type MercadoPagoGateway } from "./mercadopago";

/**
 * Camada de serviço da cobrança (docs/arquitetura.md §7). Reúne o que toca banco/e-mail/MP —
 * `src/core/billing` fica só com a matemática pura (`effectiveStatus`, datas de ciclo).
 */

const PIX_EXPIRATION_DAYS = 3;

/** Valor de `Invoice.paidByPaymentId` quando quem baixou foi o admin (sem pagamento no MP). */
const MANUAL_PAYMENT_MARK = "manual";

export async function billingUrlFor(tenantSlug: string): Promise<string> {
  return `${await getPublicBaseUrl()}/${tenantSlug}/assinatura`;
}

// ---------------------------------------------------------------------------
// Plano padrão do cadastro público
// ---------------------------------------------------------------------------

/**
 * Plano assumido no cadastro público (§7.3): o de menor `sortOrder` (Essencial). Deliberadamente
 * NÃO filtra por `active: true` — os planos nascem `active: false` até o dono definir preço
 * (decisão de 2026-09-28, ver `.claude/agent-memory/cronos/fase7_cobranca_decisoes.md`), e o
 * trial precisa funcionar ponta a ponta mesmo antes disso. `active` só controla o que aparece
 * numa futura tela de upgrade/downgrade de plano pago, não o trial gratuito.
 */
export async function getDefaultSignupPlan() {
  const plan = await getPrisma().plan.findFirst({ orderBy: { sortOrder: "asc" } });
  if (!plan) {
    throw new DomainError("NO_PLAN_AVAILABLE", "Nenhum plano cadastrado. Fale com o suporte.");
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Status efetivo / guards
// ---------------------------------------------------------------------------

export async function getSubscriptionSnapshot(tenantId: string) {
  const subscription = await forTenant(tenantId).subscription.findFirst({});
  if (!subscription) {
    throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta empresa.");
  }
  return subscription;
}

export async function effectiveStatusForTenant(tenantId: string, now: Date = new Date()): Promise<SubscriptionStatus> {
  const subscription = await getSubscriptionSnapshot(tenantId);
  return effectiveStatus(subscription, now);
}

/**
 * Painel só-leitura quando SUSPENDED (§7.4): toda Server Action que MUTA dados de negócio
 * (agenda, catálogo, clientes) deve chamar isto depois de `requireTenantMember` — nunca antes,
 * porque precisa do `tenant.id` já resolvido pelo slug.
 *
 * `CANCELED` também bloqueia escrita (só a tela de Assinatura, para reativar, funciona — e essa
 * tela usa uma Server Action própria de pagamento/reativação, não esta função).
 */
export async function assertTenantCanWrite(tenantId: string, now: Date = new Date()): Promise<void> {
  const status = await effectiveStatusForTenant(tenantId, now);
  if (status === "SUSPENDED" || status === "CANCELED") {
    throw new DomainError(
      "TENANT_SUSPENDED",
      "Assinatura suspensa: o painel está somente leitura. Pague a fatura em aberto para reativar.",
      { status },
    );
  }
}

/**
 * Usada pelo `claim` do bot (Fase 4, docs/arquitetura.md §2 regra 8, §7.4). Exportada aqui —
 * NÃO editamos `src/modules/bot-api/subscription-gate.ts` (posse da Fase 4/outra instância);
 * o Atlas liga esta função no lugar do `TODO` de lá depois.
 */
export async function isTenantBotAllowedFor(tenantId: string, now: Date = new Date()): Promise<boolean> {
  const status = await effectiveStatusForTenant(tenantId, now);
  return status !== "SUSPENDED" && status !== "CANCELED";
}

// ---------------------------------------------------------------------------
// Criação de fatura + Pix
// ---------------------------------------------------------------------------

/**
 * Cria (ou reaproveita, se já existir para o mesmo `periodStart` — idempotência por
 * `@@unique([subscriptionId, periodStart])`) a fatura de um ciclo e tenta gerar o Pix.
 *
 * Gerar o Pix NUNCA impede a fatura de existir: se o Mercado Pago não está configurado ainda
 * (sem credenciais — PENDÊNCIAS no handoff) ou a chamada falha, a fatura fica `OPEN` sem
 * `pixQrCode`/`pixCopyPaste` — a tela de Assinatura oferece "gerar Pix" (mesmo caminho de
 * `regeneratePixForInvoice`) e o `billing/tick` tenta de novo nas próximas rodadas (Pix
 * "expirado" inclui nunca ter sido gerado, ver `runBillingTick`).
 */
export async function createInvoiceForPeriod(params: {
  subscriptionId: string;
  amountCents: number;
  periodStart: Date;
  periodEnd: Date;
  dueAt: Date;
  payerEmail: string;
  description: string;
  gateway?: MercadoPagoGateway;
}) {
  const { invoice } = await createInvoiceForPeriodTracked(params);
  return invoice;
}

/** Igual a `createInvoiceForPeriod`, mas diz se CRIOU (para o tick só disparar o e-mail "fatura gerada" uma vez). */
export async function createInvoiceForPeriodTracked(params: {
  subscriptionId: string;
  amountCents: number;
  periodStart: Date;
  periodEnd: Date;
  dueAt: Date;
  payerEmail: string;
  description: string;
  gateway?: MercadoPagoGateway;
}) {
  const prisma = getPrisma();

  const existing = await prisma.invoice.findUnique({
    where: { subscriptionId_periodStart: { subscriptionId: params.subscriptionId, periodStart: params.periodStart } },
  });
  if (existing) {
    return { invoice: existing, created: false };
  }

  const invoice = await prisma.invoice.create({
    data: {
      subscriptionId: params.subscriptionId,
      amountCents: params.amountCents,
      periodStart: params.periodStart,
      periodEnd: params.periodEnd,
      dueAt: params.dueAt,
      status: "OPEN",
    },
  });

  const withPix = await tryAttachPix(invoice.id, params.payerEmail, params.description, params.gateway);
  return { invoice: withPix ?? invoice, created: true };
}

/**
 * Documento (CPF/CNPJ) do pagador de uma fatura, já normalizado e validado — ou `null` quando
 * `Tenant.document` está vazio ou (defensivamente) veio com dígito verificador inválido. O
 * Mercado Pago exige `payer.identification` para Pix (ver `mercadopago.ts#createPixPayment`);
 * este é o único lugar que lê `Tenant.document` para essa finalidade.
 */
async function resolvePayerForInvoice(invoiceId: string): Promise<{ name: string; document: string | null; tenantId: string }> {
  const invoice = await getPrisma().invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { subscription: { include: { tenant: { select: { id: true, name: true, document: true } } } } },
  });
  const { tenant } = invoice.subscription;
  const validated = tenant.document ? validateCpfCnpj(tenant.document) : { valid: false as const };
  if (tenant.document && !validated.valid) {
    // Não deveria acontecer se a gravação (`updateTenantDocument`) sempre validar antes de
    // salvar — mas um dado corrompido não pode se disfarçar de "documento presente" e mandar a
    // cobrança para o MP do jeito errado. Loga para investigar a origem do dado ruim.
    logger.warn("billing.pix.tenant_document_invalid", { tenantId: tenant.id });
  }
  return { name: tenant.name, document: validated.valid ? validated.digits : null, tenantId: tenant.id };
}

/**
 * `MercadoPagoFailureKind` → código de `DomainError`, para quem chama poder mostrar UMA frase
 * certa em vez de "algo deu errado" — mesma régua do Parque das Feiras
 * (`lib/pagamentos/porta.ts#FalhaDoGateway`, `paymentErrorResponse.ts`): cada falha diz de QUEM
 * é o problema (empresa sem documento cadastrado, admin da plataforma com credencial errada, ou
 * o Mercado Pago fora do ar).
 */
const DOMAIN_ERROR_BY_MP_FAILURE: Readonly<Record<MercadoPagoFailureKind, { code: string; message: string }>> = {
  missing_payer_document: {
    code: "MERCADOPAGO_MISSING_DOCUMENT",
    message: "Cadastre o CPF ou CNPJ da empresa antes de gerar o Pix (o Mercado Pago exige essa informação).",
  },
  invalid_payer_document: {
    code: "MERCADOPAGO_MISSING_DOCUMENT",
    message: "O Mercado Pago recusou o CPF/CNPJ cadastrado da empresa. Verifique o documento em Configurações.",
  },
  invalid_credentials: {
    code: "MERCADOPAGO_MISCONFIGURED",
    message: "O Mercado Pago recusou a credencial da plataforma. Contate o suporte.",
  },
  pix_key_not_enabled: {
    code: "MERCADOPAGO_MISCONFIGURED",
    message: "A conta do Mercado Pago da plataforma não tem chave Pix habilitada. Contate o suporte.",
  },
  rate_limited: {
    code: "MERCADOPAGO_UNAVAILABLE",
    message: "O Mercado Pago recusou por excesso de chamadas. Tente de novo daqui a alguns minutos.",
  },
  payload_rejected: {
    code: "MERCADOPAGO_UNAVAILABLE",
    message: "O Mercado Pago recusou a cobrança. Tente de novo ou fale com o suporte.",
  },
  unavailable: {
    code: "MERCADOPAGO_UNAVAILABLE",
    message: "Não deu para gerar o Pix agora. Tente de novo daqui a alguns minutos.",
  },
};

/**
 * Ambiente do MP em que o gateway gerou o Pix — vai para `Invoice.mpEnvironment` para a conciliação
 * consultar com as credenciais certas mesmo que o admin troque o ambiente ativo depois. Gateway sem
 * `environment` (fake de teste) cai no ambiente ativo.
 */
export async function pixEnvironmentFor(gateway: MercadoPagoGateway): Promise<MercadoPagoEnv> {
  return gateway.environment ?? (await getActiveMercadoPagoCredentials()).environment;
}

/** Exportada para quem já tem a fatura criada (sem passar pelo check de idempotência de `createInvoiceForPeriodTracked`, que trataria a fatura recém-criada como "já existe" e nunca chamaria isto). */
export async function tryAttachPix(
  invoiceId: string,
  payerEmail: string,
  description: string,
  gateway?: MercadoPagoGateway,
  /**
   * Sobrescreve a chave de idempotência do MP. Fatura REABERTA (VOID→OPEN) precisa de chave nova:
   * com `invoice.id` o MP devolveria o pagamento antigo, que foi cancelado ao anular.
   */
  options: { idempotencyKey?: string } = {},
) {
  try {
    const mp = gateway ?? (await getMercadoPagoGateway({ forNewCharge: true }));
    const invoice = await getPrisma().invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    const payer = await resolvePayerForInvoice(invoiceId);

    const pix = await mp.createPixPayment({
      externalReference: invoice.id,
      amountCents: invoice.amountCents,
      description,
      payerEmail,
      payerName: payer.name,
      payerDocument: payer.document,
      idempotencyKey: options.idempotencyKey ?? invoice.id, // mesma fatura nunca gera 2 cobranças no MP
      expiresInDays: PIX_EXPIRATION_DAYS,
    });

    return getPrisma().invoice.update({
      where: { id: invoiceId },
      data: {
        mpPaymentId: pix.paymentId,
        pixQrCode: pix.qrCode,
        pixCopyPaste: pix.copyPaste,
        pixExpiresAt: pix.expiresAt,
        mpEnvironment: await pixEnvironmentFor(mp),
      },
    });
  } catch (error) {
    // "Falta documento" é um estado ESPERADO enquanto a empresa não cadastrou CPF/CNPJ (nenhuma
    // tela pública de cadastro coleta isso ainda — PENDÊNCIAS no handoff) — não é falha de
    // infraestrutura, por isso `info` e não `warn`.
    const kind = error instanceof MercadoPagoApiError ? error.kind : undefined;
    const level = kind === "missing_payer_document" ? "info" : "warn";
    logger[level]("billing.pix.create_failed", {
      invoiceId,
      kind,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Regera o Pix de uma fatura OPEN (expirado ou nunca gerado) — mesma linha, nunca cria outra.
 *
 * Diferente de `tryAttachPix` (usado em segundo plano por `signup`/`tick`, que só loga e
 * devolve `null` em qualquer falha), esta função é chamada por uma ação explícita do OWNER na
 * tela de Assinatura — por isso ela CHAMA o gateway direto (não engole o erro) e traduz o
 * `MercadoPagoFailureKind` num `DomainError` específico, para a tela dizer exatamente o que
 * fazer (cadastrar documento vs. tentar de novo vs. contatar o suporte) em vez de um
 * "indisponível" genérico para qualquer causa.
 */
export async function regeneratePixForInvoice(invoiceId: string, payerEmail: string, gateway?: MercadoPagoGateway) {
  const invoice = await getPrisma().invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new DomainError("NOT_FOUND", "Fatura não encontrada.");
  if (invoice.status !== "OPEN") {
    throw new DomainError("INVALID_STATE", "Só é possível gerar Pix para uma fatura em aberto.");
  }

  const mp = gateway ?? (await getMercadoPagoGateway({ forNewCharge: true }));
  const payer = await resolvePayerForInvoice(invoiceId);

  let pix;
  try {
    pix = await mp.createPixPayment({
      externalReference: invoice.id,
      amountCents: invoice.amountCents,
      description: "Assinatura InnoChat",
      payerEmail,
      payerName: payer.name,
      payerDocument: payer.document,
      idempotencyKey: `${invoice.id}:${Date.now()}`, // Pix anterior expirou/nunca existiu — precisa de cobrança nova
      expiresInDays: PIX_EXPIRATION_DAYS,
    });
  } catch (error) {
    const kind = error instanceof MercadoPagoApiError ? error.kind : "unavailable";
    const mapped = DOMAIN_ERROR_BY_MP_FAILURE[kind];
    logger.warn("billing.pix.regenerate_failed", { invoiceId, kind, errorMessage: error instanceof Error ? error.message : String(error) });
    throw new DomainError(mapped.code, mapped.message, { kind });
  }

  const updated = await getPrisma().invoice.update({
    where: { id: invoiceId },
    data: {
      mpPaymentId: pix.paymentId,
      pixQrCode: pix.qrCode,
      pixCopyPaste: pix.copyPaste,
      pixExpiresAt: pix.expiresAt,
      mpEnvironment: await pixEnvironmentFor(mp),
    },
  });

  // O Pix anterior ainda pode estar pagável no app do cliente (o aviso antigo foi enviado por e-mail/WhatsApp):
  // cancela no MP para a mesma fatura nunca ter dois QR vivos (pagar os dois = cobrança em dobro). Falha só é
  // logada; se o antigo ainda for pago, `applyInvoicePayment` marca `duplicatePaymentAt` e o sino do admin avisa.
  if (invoice.mpPaymentId && invoice.mpPaymentId !== pix.paymentId && (!invoice.pixExpiresAt || invoice.pixExpiresAt > new Date())) {
    await cancelPixPayments([{ invoiceId: invoice.id, mpPaymentId: invoice.mpPaymentId, mpEnvironment: invoice.mpEnvironment }], gateway);
  }
  return updated;
}

/**
 * Confere que `invoiceId` pertence de fato à `Subscription` de `tenantId` — para
 * `regenerateMyInvoicePixAction` (`src/modules/billing/actions.ts`, tela de Assinatura da
 * própria empresa) nunca deixar um OWNER regerar Pix de uma fatura de OUTRA empresa só por
 * adivinhar/tentar um `invoiceId` de outra conta.
 */
export async function findOwnInvoiceOrThrow(tenantId: string, invoiceId: string) {
  const invoice = await getPrisma().invoice.findUnique({ where: { id: invoiceId }, include: { subscription: true } });
  if (!invoice || invoice.subscription.tenantId !== tenantId) {
    throw new DomainError("NOT_FOUND", "Fatura não encontrada.");
  }
  return invoice;
}

// ---------------------------------------------------------------------------
// Anular fatura + cancelar o Pix no Mercado Pago
// ---------------------------------------------------------------------------

/** Pix emitido de uma fatura que acabou de ser anulada. */
export type VoidedPix = { invoiceId: string; mpPaymentId: string; mpEnvironment: MercadoPagoEnv | null };

/**
 * Anula (VOID) as faturas `OPEN` de uma assinatura (filtro extra opcional) e devolve os Pix que
 * ficaram pendurados no MP, para o chamador cancelá-los DEPOIS (fora de transação) com
 * `cancelPixPayments`. Aceita o client de uma transação. Só toca fatura ainda `OPEN`: pagamento
 * concorrente que a marcou `PAID` nunca é sobrescrito.
 */
export async function voidOpenInvoices(
  db: Pick<Prisma.TransactionClient, "invoice">,
  where: Prisma.InvoiceWhereInput,
): Promise<{ count: number; pix: VoidedPix[] }> {
  const open = await db.invoice.findMany({
    where: { ...where, status: "OPEN" },
    select: { id: true, mpPaymentId: true, mpEnvironment: true },
  });
  if (open.length === 0) return { count: 0, pix: [] };
  const ids = open.map((i) => i.id);
  const voided = await db.invoice.updateMany({ where: { id: { in: ids }, status: "OPEN" }, data: { status: "VOID" } });
  const pix = open.flatMap((i) => (i.mpPaymentId ? [{ invoiceId: i.id, mpPaymentId: i.mpPaymentId, mpEnvironment: i.mpEnvironment }] : []));
  return { count: voided.count, pix };
}

/**
 * Cancela no Mercado Pago os pagamentos Pix de faturas anuladas, para o QR já emitido não poder
 * mais ser pago (o dinheiro cairia numa fatura VOID, sem baixa). NUNCA lança: a falha só é logada
 * (id da fatura e tipo do erro — nada sensível) e não desfaz o cancelamento; se o Pix ainda for
 * pago, o aviso `PAYMENT_ON_VOID_INVOICE` chega ao admin (`applyInvoicePayment`).
 */
export async function cancelPixPayments(pix: VoidedPix[], injected?: MercadoPagoGateway): Promise<{ cancelled: number }> {
  let cancelled = 0;
  for (const item of pix) {
    try {
      const gateway =
        injected ?? (item.mpEnvironment ? await getMercadoPagoGatewayForEnvironment(item.mpEnvironment) : await getMercadoPagoGateway());
      await gateway.cancelPayment(item.mpPaymentId);
      cancelled += 1;
    } catch (error) {
      logger.warn("billing.pix.cancel_failed", {
        invoiceId: item.invoiceId,
        kind: error instanceof MercadoPagoApiError ? error.kind : undefined,
        httpStatus: error instanceof MercadoPagoApiError ? error.status : undefined,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { cancelled };
}

// ---------------------------------------------------------------------------
// Pagamento confirmado (webhook / tick reconsultando o MP)
// ---------------------------------------------------------------------------

/**
 * Aplica um pagamento confirmado a uma fatura (docs/arquitetura.md §7.1, §6.10): marca `PAID`,
 * avança `currentPeriodEnd` (mantendo o dia-âncora, ou a partir de `paidAt` se estava
 * `SUSPENDED`) e volta a assinatura para `ACTIVE`. Idempotente: se a fatura já está `PAID`,
 * não faz nada (retorna sem erro) — é o que garante que o mesmo evento do webhook, reentregue
 * pelo Mercado Pago, nunca dá baixa duas vezes nem soma dois meses.
 */
export async function applyInvoicePayment(
  invoiceId: string,
  paidAt: Date,
  /** Id do pagamento no MP que está baixando a fatura. Ausente = baixa manual do admin (`"manual"`). */
  paymentId?: string,
): Promise<{ alreadyProcessed: boolean; voided?: boolean; duplicate?: boolean }> {
  const prisma = getPrisma();
  const paidBy = paymentId ?? MANUAL_PAYMENT_MARK;

  const outcome = await prisma.$transaction(async (tx): Promise<{ alreadyProcessed: boolean; voided?: boolean; duplicate?: boolean; receipt?: PaymentReceipt; staleCancel?: VoidedPix[] }> => {
    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) {
      throw new DomainError("NOT_FOUND", "Fatura não encontrada.");
    }

    // Baixa CONDICIONAL antes de mexer na assinatura: duas chamadas concorrentes (webhook +
    // baixa manual, ou duplo clique no admin) leem `OPEN` ao mesmo tempo em READ COMMITTED; só
    // uma consegue o UPDATE com `status != PAID` (o Postgres serializa a linha), a outra vê
    // `count === 0` e sai sem somar um segundo mês (revisão do Órion, 2026-09-29).
    // `VOID` (anulada no cancelamento de um teste não convertido) NUNCA é baixada aqui: pagamento
    // tardio de fatura anulada não reativa sozinho — o chamador registra/loga e o admin decide
    // (decisão do dono, 2026-09-29; ver docs/contratos.md).
    if (invoice.status === "VOID") {
      // Dinheiro entrou numa fatura anulada: marca (uma vez) para o sino do admin decidir o estorno.
      await tx.invoice.updateMany({ where: { id: invoice.id, paidWhileVoidAt: null }, data: { paidWhileVoidAt: paidAt } });
      return { alreadyProcessed: false, voided: true };
    }
    const claimed = await tx.invoice.updateMany({
      where: { id: invoice.id, status: { notIn: ["PAID", "VOID"] } },
      data: { status: "PAID", paidAt, paidByPaymentId: paidBy },
    });
    if (claimed.count === 0) {
      // Já `PAID` — ou anulada por uma corrida entre a leitura acima e a baixa.
      // Se foi OUTRO pagamento que a baixou (Pix antigo/regerado pago depois, ou Pix pago depois da baixa manual),
      // o cliente pagou duas vezes: marca (uma vez) para o sino do admin decidir o estorno (manual). O mesmo
      // pagamento reentregue (webhook + conciliação) tem o mesmo id e NÃO é duplicado.
      if (paymentId) {
        const current = await tx.invoice.findUnique({ where: { id: invoice.id }, select: { status: true, paidByPaymentId: true } });
        if (current?.status === "PAID" && current.paidByPaymentId && current.paidByPaymentId !== paymentId) {
          await tx.invoice.updateMany({ where: { id: invoice.id, duplicatePaymentAt: null }, data: { duplicatePaymentAt: paidAt } });
          return { alreadyProcessed: true, duplicate: true };
        }
      }
      return { alreadyProcessed: true };
    }

    const subscription = await tx.subscription.findUnique({ where: { id: invoice.subscriptionId } });
    if (!subscription) {
      throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta fatura.");
    }

    // `CANCELED` (reativação paga pelo dono, ver `cancellation.ts#startReactivation`) também
    // conta o novo período a partir do pagamento: `currentPeriodEnd` antigo já está no passado.
    // Cancelamento agendado cuja data já passou (o tick ainda não persistiu `CANCELED`) é o mesmo
    // caso: o status EFETIVO é `CANCELED`, então limpa os campos de cancelamento e reativa.
    const wasCanceled = subscription.status === "CANCELED" || (subscription.cancelAtPeriodEnd && effectiveStatus(subscription, paidAt) === "CANCELED");
    const wasSuspended = effectiveStatus(subscription, paidAt) === "SUSPENDED" || subscription.status === "SUSPENDED" || wasCanceled;
    const anchor = wasSuspended ? paidAt : subscription.currentPeriodEnd;
    const nextPeriodEnd = new Date(anchor);
    nextPeriodEnd.setMonth(nextPeriodEnd.getMonth() + 1);

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: "ACTIVE",
        currentPeriodEnd: nextPeriodEnd,
        trialEndsAt: null,
        // Pagou: a suspensão manual (se havia) acabou.
        manualSuspendedAt: null,
        // Reativação: zera o estado de cancelamento (data, agendamento, motivo) e a marca de suspensão.
        ...(wasCanceled ? { canceledAt: null, cancelAtPeriodEnd: false, cancelRequestedAt: null, cancelReason: null, suspendedEmailSentAt: null } : {}),
        // Primeiro pagamento: passa a valer o prazo de 60 dias em SUSPENDED (não o de teste).
        ...(subscription.firstPaidAt ? {} : { firstPaidAt: paidAt }),
        // O ciclo pago que está começando AGORA é o "próximo ciclo" do §7.2: se havia um
        // downgrade agendado (`changePlan`), é aqui que ele entra em vigor — nunca antes
        // (upgrade já aplicou na hora, em `changePlan`; downgrade espera o pagamento que abre
        // o novo período, não só o tick rodar perto do vencimento).
        ...(subscription.pendingPlanId ? { planId: subscription.pendingPlanId, pendingPlanId: null } : {}),
      },
    });

    // Pix pendente da MESMA fatura que não foi o que pagou (regerado, ou baixa manual): cancela depois da transação.
    const stale: VoidedPix[] =
      invoice.mpPaymentId && invoice.mpPaymentId !== paymentId
        ? [{ invoiceId: invoice.id, mpPaymentId: invoice.mpPaymentId, mpEnvironment: invoice.mpEnvironment }]
        : [];

    return {
      alreadyProcessed: false,
      staleCancel: stale,
      receipt: {
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
        invoiceId: invoice.id,
        amountCents: invoice.amountCents,
        paidAt,
        activeUntil: nextPeriodEnd,
        fromStatus: subscription.status,
        reactivated: wasCanceled,
      },
    };
  });

  // Histórico e aviso FORA da transação e só na primeira baixa (`receipt` só existe quando este chamador
  // ganhou o UPDATE condicional: webhook reentregue, conciliação e baixa manual concorrentes caem em
  // `alreadyProcessed` e nunca reenviam). Nenhum dos dois desfaz o pagamento.
  if (outcome.staleCancel && outcome.staleCancel.length > 0) await cancelPixPayments(outcome.staleCancel);
  if (outcome.duplicate) logger.warn("billing.payment.duplicate_on_paid_invoice", { invoiceId });
  if (outcome.receipt) {
    const receipt = outcome.receipt;
    await recordBillingEvent({
      tenantId: receipt.tenantId,
      subscriptionId: receipt.subscriptionId,
      invoiceId: receipt.invoiceId,
      type: "PAYMENT_CONFIRMED",
      fromStatus: receipt.fromStatus,
      toStatus: "ACTIVE",
      metadata: { amountCents: receipt.amountCents, paidAt: receipt.paidAt.toISOString(), activeUntil: receipt.activeUntil.toISOString(), reactivated: receipt.reactivated },
    });
    // Aviso "pagamento confirmado" (e-mail e WhatsApp) pelo outbox da régua; import dinâmico por causa do ciclo service <-> dunning.
    const { notifyPaymentConfirmed } = await import("./dunning/payment");
    await notifyPaymentConfirmed({ tenantId: receipt.tenantId, subscriptionId: receipt.subscriptionId, invoiceId: receipt.invoiceId, now: new Date() });
  }
  if (outcome.voided) return { alreadyProcessed: outcome.alreadyProcessed, voided: true };
  return outcome.duplicate ? { alreadyProcessed: outcome.alreadyProcessed, duplicate: true } : { alreadyProcessed: outcome.alreadyProcessed };
}

type PaymentReceipt = {
  tenantId: string;
  subscriptionId: string;
  invoiceId: string;
  amountCents: number;
  paidAt: Date;
  activeUntil: Date;
  fromStatus: SubscriptionStatus;
  reactivated: boolean;
};

// ---------------------------------------------------------------------------
// Troca de plano pelo OWNER (docs/arquitetura.md §7.2)
// ---------------------------------------------------------------------------

export type ChangePlanResult = { appliedImmediately: boolean };

/**
 * Upgrade (novo plano com `sortOrder` maior) vale na hora — a diferença de preço só aparece na
 * próxima fatura, sem cálculo proporcional (§7.2, decisão do dono). Downgrade fica em
 * `pendingPlanId` e só é aceito se o uso ATUAL já couber no plano novo (considerando os
 * overrides da empresa, que continuam valendo depois da troca) — a `DomainError` traz `rule`/
 * `limit`/`current` para a tela dizer exatamente o que remover antes de tentar de novo.
 */
export async function changePlan(tenantId: string, newPlanId: string): Promise<ChangePlanResult> {
  const prisma = getPrisma();

  const [subscription, newPlan, tenant] = await Promise.all([
    prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true } }),
    prisma.plan.findUnique({ where: { id: newPlanId } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { maxProfessionalsOverride: true, maxWhatsappNumbersOverride: true } }),
  ]);

  if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta empresa.");
  if (!newPlan || !newPlan.active) throw new DomainError("NOT_FOUND", "Plano não encontrado ou não disponível.");
  if (!tenant) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
  if (subscription.status === "CANCELED") {
    throw new DomainError("INVALID_STATE", "Reative a assinatura antes de trocar de plano.");
  }
  if (newPlan.id === subscription.planId && !subscription.pendingPlanId) {
    throw new DomainError("INVALID_STATE", "A empresa já está neste plano.");
  }

  const isUpgrade = newPlan.sortOrder >= subscription.plan.sortOrder;

  if (isUpgrade) {
    await prisma.subscription.update({ where: { tenantId }, data: { planId: newPlan.id, pendingPlanId: null } });
    await recordBillingEvent({ tenantId, subscriptionId: subscription.id, type: "PLAN_CHANGED", actorType: "OWNER", metadata: { appliedImmediately: true, planCode: newPlan.code } });
    return { appliedImmediately: true };
  }

  const profLimit = tenant.maxProfessionalsOverride ?? newPlan.maxProfessionals;
  const whatsappLimit = tenant.maxWhatsappNumbersOverride ?? newPlan.maxWhatsappNumbers;
  const scoped = forTenant(tenantId);

  if (profLimit !== null) {
    const current = await scoped.professional.count({});
    if (current > profLimit) {
      throw new DomainError(
        "PLAN_DOWNGRADE_BLOCKED",
        `O plano novo permite até ${profLimit} profissional(is), e a empresa tem ${current}. Remova profissionais antes de trocar.`,
        { rule: "maxProfessionals", limit: profLimit, current },
      );
    }
  }
  if (whatsappLimit !== null) {
    const current = await scoped.whatsappInstance.count({ where: { deletedAt: null } });
    if (current > whatsappLimit) {
      throw new DomainError(
        "PLAN_DOWNGRADE_BLOCKED",
        `O plano novo permite até ${whatsappLimit} número(s) de WhatsApp, e a empresa tem ${current}. Desconecte números antes de trocar.`,
        { rule: "maxWhatsappNumbers", limit: whatsappLimit, current },
      );
    }
  }

  await prisma.subscription.update({ where: { tenantId }, data: { pendingPlanId: newPlan.id } });
  await recordBillingEvent({ tenantId, subscriptionId: subscription.id, type: "PLAN_CHANGED", actorType: "OWNER", metadata: { appliedImmediately: false, planCode: newPlan.code } });
  return { appliedImmediately: false };
}

/** Planos visíveis para a empresa escolher (docs/arquitetura.md §7.2 — `active` controla o que aparece aqui). */
export async function listActivePlans() {
  return getPrisma().plan.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } });
}

// ---------------------------------------------------------------------------
// E-mails de cobrança (usados pelo signup e pelo tick)
// ---------------------------------------------------------------------------

/**
 * Envia um e-mail de cobrança e diz SE ele saiu. `true` só quando `sendMail` devolve `sent: true`.
 * `{ sent: false }` (falha de SMTP), `SmtpNotConfiguredError` e qualquer outro erro viram `false`
 * (nunca lançam). Quem chama só pode gravar marca de "já enviado" quando o retorno for `true`:
 * senão a próxima rodada do tick tenta de novo. O log leva só o motivo, nunca destinatário, assunto
 * com dado pessoal ou corpo (o assunto/erro de transporte já são logados por `sendMail`).
 */
export async function sendBillingMail(input: SendMailInput, logEvent: string): Promise<boolean> {
  try {
    const result = await sendMail(input);
    if (result.sent) return true;
    logger.warn(logEvent, { reason: "SEND_FAILED" });
    return false;
  } catch (error) {
    logger.warn(logEvent, {
      reason: error instanceof SmtpNotConfiguredError ? "SMTP_NOT_CONFIGURED" : "UNEXPECTED_ERROR",
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}

/** Devolve `true` se o e-mail saiu (ver `sendBillingMail`). */
export async function sendInvoiceGeneratedEmail(params: {
  toEmail: string;
  tenantName: string;
  tenantSlug: string;
  amountCents: number;
  dueAt: Date;
  pixCopyPaste: string | null;
  timezone: string;
}): Promise<boolean> {
  const logEvent = "billing.email.invoice_generated.not_sent";
  let mail: { subject: string; html: string; text: string };
  try {
    mail = invoiceGeneratedEmail({
      tenantName: params.tenantName,
      amountReais: formatCentsBRL(params.amountCents),
      dueDateBr: formatDateBR(params.dueAt, params.timezone),
      pixCopyPaste: params.pixCopyPaste,
      billingUrl: await billingUrlFor(params.tenantSlug),
      ctx: await loadEmailContext(),
    });
  } catch (error) {
    // Falha ao MONTAR o e-mail (URL publica/contexto): conta como "nao saiu", nunca aborta quem chama.
    logger.warn(logEvent, { reason: "BUILD_FAILED", errorName: error instanceof Error ? error.name : "unknown" });
    return false;
  }
  return sendBillingMail({ to: params.toEmail, ...mail }, logEvent);
}

export async function sendSubscriptionSuspendedEmail(params: {
  toEmail: string;
  tenantName: string;
  tenantSlug: string;
  /** `true` para quem nunca pagou: e-mail de "seu teste terminou", não de atraso. */
  trialNotConverted?: boolean;
}): Promise<boolean> {
  const logEvent = "billing.email.suspended.not_sent";
  let mail: { subject: string; html: string; text: string };
  try {
    mail = subscriptionSuspendedEmail({
      tenantName: params.tenantName,
      billingUrl: await billingUrlFor(params.tenantSlug),
      trialNotConverted: params.trialNotConverted,
      cancelInDays: params.trialNotConverted ? CANCEL_AFTER_SUSPENDED_TRIAL_DAYS : undefined,
      ctx: await loadEmailContext(),
    });
  } catch (error) {
    logger.warn(logEvent, { reason: "BUILD_FAILED", errorName: error instanceof Error ? error.name : "unknown" });
    return false;
  }
  return sendBillingMail({ to: params.toEmail, ...mail }, logEvent);
}

/** Primeiro OWNER (o mais antigo) da empresa: e-mail e primeiro nome. */
export async function findOwnerContact(tenantId: string): Promise<{ email: string; firstName: string | null } | null> {
  const membership = await forTenant(tenantId).membership.findFirst({
    where: { role: "OWNER" },
    orderBy: { createdAt: "asc" },
    select: { userId: true },
  });
  if (!membership) return null;
  const user = await getPrisma().user.findUnique({ where: { id: membership.userId }, select: { email: true, name: true } });
  if (!user) return null;
  const firstName = user.name?.trim().split(/\s+/)[0] ?? "";
  return { email: user.email, firstName: firstName || null };
}

export async function findOwnerEmail(tenantId: string): Promise<string | null> {
  return (await findOwnerContact(tenantId))?.email ?? null;
}

/**
 * E-mail de quem recebe cobrança: o e-mail de cobrança da empresa (`Tenant.billingEmail`, decisão D4) quando
 * existe; senão o OWNER mais antigo. As etapas críticas da régua também vão para o OWNER (ver
 * `src/modules/billing/dunning/recipients.ts`); aqui é o endereço "principal" (pagador do Pix, recibos).
 */
export async function findBillingRecipientEmail(tenantId: string): Promise<string | null> {
  const tenant = await getPrisma().tenant.findUnique({ where: { id: tenantId }, select: { billingEmail: true } });
  const billing = tenant?.billingEmail?.trim();
  if (billing) return billing;
  return findOwnerEmail(tenantId);
}

export function newTrialEndsAt(signupAt: Date): Date {
  return computeTrialEndsAt(signupAt);
}

export function generateInvoiceDescription(tenantName: string): string {
  return `Assinatura InnoChat (${tenantName})`;
}

/** Chave curta para operações que precisam de aleatoriedade (ex.: idempotência local). */
export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}
