import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getActiveMercadoPagoCredentials, type MercadoPagoEnv } from "@/modules/platform/mercadopago-config";
import { applyInvoicePayment } from "./service";
import { getMercadoPagoGatewayForEnvironment, MercadoPagoApiError, type MercadoPagoGateway } from "./mercadopago";

/**
 * Conciliação ATIVA de Pix (padrão do Parque das Feiras: consulta o MP em vez de depender só do
 * webhook). Reconsulta `GET /v1/payments/{mpPaymentId}` e, se `approved`, chama
 * `applyInvoicePayment` (idempotente e race-safe — webhook e conciliação concorrentes nunca
 * somam dois meses). Nunca confia em nada além da resposta autenticada do MP.
 *
 * - Credenciais do ambiente em que o Pix foi gerado (`Invoice.mpEnvironment`); legado (nulo) tenta
 *   o ativo e, se o MP não reconhecer o pagamento/credencial, o outro ambiente configurado.
 * - Rate limit no BANCO (`mpLastCheckedAt`, UPDATE condicional atômico): vale entre instâncias e
 *   entre o polling da tela e o tick.
 * - Auditoria: `ProviderEvent(provider = "mercadopago-reconcile", providerEventId = paymentId)`.
 */

export type ReconcileSource = "tenant_poll" | "admin_button" | "tick";

export type ReconcileOutcome =
  | { status: "paid"; environment: MercadoPagoEnv }
  | { status: "already_paid" }
  | { status: "pending"; mpStatus: string }
  | { status: "payment_failed"; mpStatus: string }
  | { status: "voided_invoice_paid" }
  | { status: "throttled" }
  | { status: "no_payment" }
  | { status: "not_open" }
  | { status: "error"; code: "NOT_CONFIGURED" | "MP_UNAVAILABLE" | "PAYMENT_MISMATCH" | "AMOUNT_MISMATCH" };

/** Estados do MP que encerram o pagamento sem dinheiro — nunca dão baixa. */
const FAILED_MP_STATUSES = new Set(["rejected", "cancelled", "expired", "refunded", "charged_back"]);

export const DEFAULT_RECONCILE_MIN_INTERVAL_MS = 5_000;

export type ReconcileOptions = {
  source: ReconcileSource;
  /** Intervalo mínimo entre consultas ao MP para a mesma fatura. 0 desliga (tick/admin). */
  minIntervalMs?: number;
  now?: Date;
  /** Injeta o gateway (testes). Sem isto, resolve pelas credenciais do ambiente da fatura. */
  gateway?: MercadoPagoGateway;
  /** Injeta a resolução de gateway por ambiente (testes que checam qual credencial foi usada). */
  resolveGateway?: (environment: MercadoPagoEnv) => Promise<MercadoPagoGateway>;
};

const OTHER_ENV: Record<MercadoPagoEnv, MercadoPagoEnv> = { PRODUCTION: "SANDBOX", SANDBOX: "PRODUCTION" };

async function acquireCheckSlot(invoiceId: string, now: Date, minIntervalMs: number): Promise<boolean> {
  const prisma = getPrisma();
  if (minIntervalMs <= 0) {
    await prisma.invoice.update({ where: { id: invoiceId }, data: { mpLastCheckedAt: now } });
    return true;
  }
  const claimed = await prisma.invoice.updateMany({
    where: { id: invoiceId, OR: [{ mpLastCheckedAt: null }, { mpLastCheckedAt: { lt: new Date(now.getTime() - minIntervalMs) } }] },
    data: { mpLastCheckedAt: now },
  });
  return claimed.count === 1;
}

export async function reconcileInvoicePayment(invoiceId: string, options: ReconcileOptions): Promise<ReconcileOutcome> {
  const prisma = getPrisma();
  const now = options.now ?? new Date();
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new DomainError("NOT_FOUND", "Fatura não encontrada.");

  if (invoice.status === "PAID") return { status: "already_paid" };
  if (invoice.status === "VOID") return { status: "not_open" };
  if (!invoice.mpPaymentId) return { status: "no_payment" };

  const minIntervalMs = options.minIntervalMs ?? DEFAULT_RECONCILE_MIN_INTERVAL_MS;
  if (!(await acquireCheckSlot(invoice.id, now, minIntervalMs))) return { status: "throttled" };

  // Ambientes a tentar: o da fatura; legado → ativo primeiro, depois o outro.
  const environments: MercadoPagoEnv[] = invoice.mpEnvironment
    ? [invoice.mpEnvironment]
    : [(await getActiveMercadoPagoCredentials()).environment].flatMap((active) => [active, OTHER_ENV[active]]);
  const legacy = invoice.mpEnvironment === null;

  let payment: Awaited<ReturnType<MercadoPagoGateway["getPayment"]>> | null = null;
  let usedEnvironment: MercadoPagoEnv = environments[0]!;
  let sawUnavailable = false;
  let sawNotConfigured = false;

  for (const environment of environments) {
    let gateway: MercadoPagoGateway;
    try {
      gateway = options.gateway ?? (await (options.resolveGateway ?? getMercadoPagoGatewayForEnvironment)(environment));
    } catch (error) {
      if (error instanceof DomainError && error.code === "MERCADOPAGO_NOT_CONFIGURED") {
        sawNotConfigured = true;
        continue;
      }
      throw error;
    }
    try {
      payment = await gateway.getPayment(invoice.mpPaymentId);
      usedEnvironment = environment;
      break;
    } catch (error) {
      const status = error instanceof MercadoPagoApiError ? error.status : undefined;
      logger.warn("billing.reconcile.get_payment_failed", { invoiceId: invoice.id, environment, httpStatus: status, source: options.source });
      // Legado: 401/403/404 sugere que era do outro ambiente — tenta o próximo; senão, indisponível.
      if (legacy && (status === 401 || status === 403 || status === 404)) continue;
      sawUnavailable = true;
      break;
    }
  }

  if (!payment) {
    return { status: "error", code: sawUnavailable || !sawNotConfigured ? "MP_UNAVAILABLE" : "NOT_CONFIGURED" };
  }

  if (payment.externalReference !== invoice.id) {
    // Referência ausente (null) ou de OUTRA fatura — nunca baixa esta (igualdade estrita, fail-closed).
    logger.warn("billing.reconcile.external_reference_mismatch", { invoiceId: invoice.id, source: options.source });
    return { status: "error", code: "PAYMENT_MISMATCH" };
  }

  // Grava o ambiente descoberto em fatura legada (as próximas consultas já vão direto).
  if (legacy) {
    await prisma.invoice.updateMany({ where: { id: invoice.id, mpEnvironment: null }, data: { mpEnvironment: usedEnvironment } });
  }

  if (payment.status !== "approved") {
    if (FAILED_MP_STATUSES.has(payment.status)) {
      logger.info("billing.reconcile.payment_not_approved", { invoiceId: invoice.id, mpStatus: payment.status, source: options.source });
      return { status: "payment_failed", mpStatus: payment.status };
    }
    return { status: "pending", mpStatus: payment.status };
  }

  if (payment.transactionAmountCents !== invoice.amountCents) {
    logger.warn("billing.reconcile.amount_mismatch", {
      invoiceId: invoice.id,
      paidCents: payment.transactionAmountCents,
      expectedCents: invoice.amountCents,
      source: options.source,
    });
    return { status: "error", code: "AMOUNT_MISMATCH" };
  }

  const applied = await applyInvoicePayment(invoice.id, payment.dateApproved ?? now, payment.id);
  if (applied.voided) {
    logger.warn("billing.reconcile.payment_for_void_invoice", { invoiceId: invoice.id, source: options.source });
    return { status: "voided_invoice_paid" };
  }
  if (applied.alreadyProcessed) return { status: "already_paid" };

  await writeAudit(invoice.id, invoice.mpPaymentId, options.source, usedEnvironment, now);
  logger.info("billing.reconcile.invoice_paid", { invoiceId: invoice.id, environment: usedEnvironment, source: options.source });
  return { status: "paid", environment: usedEnvironment };
}

async function writeAudit(invoiceId: string, paymentId: string, source: ReconcileSource, environment: MercadoPagoEnv, now: Date) {
  try {
    await getPrisma().providerEvent.create({
      data: {
        provider: "mercadopago-reconcile",
        providerEventId: paymentId,
        payload: { invoiceId, source, environment, status: "approved", reconciledAt: now.toISOString() },
        processedAt: now,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      logger.warn("billing.reconcile.audit_failed", { invoiceId, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
}
