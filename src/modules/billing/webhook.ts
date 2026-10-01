import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { logger } from "@/lib/logger";
import { getActiveMercadoPagoCredentials, getMercadoPagoCredentials, type MercadoPagoEnv } from "@/modules/platform/mercadopago-config";
import { applyInvoicePayment } from "./service";
import { explainMercadoPagoSignature, getMercadoPagoGateway, MercadoPagoApiError, type MercadoPagoGateway } from "./mercadopago";
import { recordWebhookReceived, recordWebhookRejected, sanitizeWebhookType, type WebhookRejectionReason } from "./webhook-diagnostics";

/**
 * `POST /api/webhooks/mercadopago` (docs/arquitetura.md §7.1, §6.10). Segue o mesmo formato de
 * erro `{ error: { code, message } }` da API interna (§6.1), embora este endpoint responda ao
 * Mercado Pago, não ao n8n.
 *
 * Fluxo (nunca confia no corpo do webhook para dar baixa — só para saber QUAL pagamento
 * reconsultar):
 * 1. Valida `x-signature` (assinatura HMAC do MP — `verifyMercadoPagoSignature`). Assinatura
 *    inválida → 401, sem tocar no banco.
 * 2. Extrai `data.id` (id do pagamento) do corpo/query.
 * 2b. Confere `type`/`topic` (conferido contra o Parque das Feiras,
 *    `AdaptadorMercadoPago#interpretarNotificacao`): notificação que não é `payment` (ex.:
 *    `merchant_order`, formato antigo de webhook do MP) é `ignored` sem chamar `getPayment` —
 *    esse `dataId` não é necessariamente um id de pagamento, e reconsultar como se fosse
 *    devolveria 404/erro do MP por um evento que não interessa aqui.
 * 3. Idempotência por `ProviderEvent(provider, providerEventId)` — `providerEventId` é o id do
 *    pagamento: se o MP reentregar a MESMA notificação (ou duas notificações do mesmo
 *    pagamento, ex.: "pending" e depois "approved"), só processa uma vez de verdade
 *    (`applyInvoicePayment` também é idempotente por si — dupla trava).
 * 4. RECONSULTA o pagamento na API do MP (`gateway.getPayment`) — nunca confia no `status` que
 *    vier no corpo do webhook (podem falsificar a notificação; a chamada autenticada com o
 *    access token é a fonte da verdade).
 * 5. Se `status === "approved"`, aplica o pagamento à fatura (`external_reference` =
 *    `Invoice.id`).
 */

async function getOtherEnvironmentWebhookSecret(active: MercadoPagoEnv): Promise<string | null> {
  return (await getMercadoPagoCredentials(active === "PRODUCTION" ? "SANDBOX" : "PRODUCTION")).webhookSecret;
}

export class WebhookAuthError extends Error {
  constructor(
    message: string,
    readonly reason?: WebhookRejectionReason,
  ) {
    super(message);
  }
}
export class WebhookIgnored extends Error {}

export type MercadoPagoWebhookBody = {
  data?: { id?: string | number };
  type?: string;
  /** Formato antigo do webhook do MP (`?topic=payment&id=...`). Aceito como sinônimo de `type`. */
  topic?: string;
};

export async function handleMercadoPagoWebhook(params: {
  xSignature: string | null;
  xRequestId: string | null;
  dataId: string | null;
  /** `type` (formato novo) ou `topic` (formato antigo) da notificação. `null`/ausente é tratado como "payment" — mesmo comportamento de antes desta checagem existir, para não quebrar uma notificação que não traga o campo. */
  type?: string | null;
  gateway?: MercadoPagoGateway;
}): Promise<{ status: "processed" | "ignored" | "already_processed" }> {
  const prisma = getPrisma();

  // Rota pública: sem data.id só loga (nada de escrita no banco antes de autenticar).
  if (!params.dataId) {
    logger.info("billing.webhook.missing_data_id");
    throw new WebhookIgnored("Notificação sem data.id — nada a processar.");
  }

  // Segredo do ambiente ATIVO (produção ou teste). Fail-closed: ausente ou que não decifra => rejeita.
  const { webhookSecret, environment } = await getActiveMercadoPagoCredentials();
  const info = { environment, type: sanitizeWebhookType(params.type) };

  if (!webhookSecret) {
    // Sem segredo configurado (ou ilegível): não dá para validar a assinatura com segurança.
    // Rejeitar é mais seguro que aceitar sem checagem.
    await recordWebhookRejected("no_secret_for_env", info);
    throw new WebhookAuthError("Assinatura inválida.", "no_secret_for_env");
  }

  const signatureFailure = explainMercadoPagoSignature({
    xSignature: params.xSignature,
    xRequestId: params.xRequestId,
    dataId: params.dataId,
    secret: webhookSecret,
  });
  if (signatureFailure) {
    // Diagnóstico: a assinatura bate com o segredo do OUTRO ambiente? Então o painel do MP está
    // mandando notificações de um modo (teste/produção) diferente do ambiente ativo aqui.
    let reason: WebhookRejectionReason = signatureFailure;
    if (signatureFailure === "bad_signature") {
      const otherSecret = await getOtherEnvironmentWebhookSecret(environment);
      if (otherSecret && explainMercadoPagoSignature({ xSignature: params.xSignature, xRequestId: params.xRequestId, dataId: params.dataId, secret: otherSecret }) === null) {
        reason = "wrong_environment_secret";
      }
    }
    await recordWebhookRejected(reason, info);
    throw new WebhookAuthError("Assinatura inválida.", reason);
  }

  if (params.type && params.type !== "payment") {
    logger.info("billing.webhook.irrelevant_type", { type: info.type });
    await recordWebhookReceived("ignored", info, "ignored_type");
    return { status: "ignored" };
  }

  const providerEventId = params.dataId;

  const gateway = params.gateway ?? (await getMercadoPagoGateway());
  let payment: Awaited<ReturnType<typeof gateway.getPayment>>;
  try {
    payment = await gateway.getPayment(providerEventId);
  } catch (error) {
    // Pagamento que não existe nesta conta (ex.: "Simular notificação" do painel do MP manda
    // `data.id=123456`; ou evento de outro ambiente): nada a baixar. Responde 200 `ignored` —
    // 500 aqui faria o MP reentregar para sempre (teste real do dono em 2026-09-29).
    if (error instanceof MercadoPagoApiError && error.status === 404) {
      logger.info("billing.webhook.payment_not_found", { paymentId: providerEventId });
      throw new WebhookIgnored("Pagamento não encontrado no Mercado Pago.");
    }
    throw error;
  }

  // Corrida (revisão de segurança 2026-09-28, achado MÉDIA): o MP pode reentregar a mesma
  // notificação quase simultaneamente (retry de rede, ou 2 notificações de status diferentes
  // para o mesmo pagamento). Duas chamadas concorrentes podem ambas ler "não existe" (READ
  // COMMITTED, o isolamento padrão do Postgres) antes que a primeira comite — a segunda
  // `create` então falha por violação da constraint única `provider_providerEventId`. Mesmo
  // padrão `isUniqueViolation` de `claim.ts`/`connection.ts`: trata como "já processado" (a
  // constraint é o backstop final contra a corrida), nunca deixa subir como erro/500.
  //
  // Sem `$transaction` (diferente da versão anterior): uma vez que uma query falha dentro de
  // uma transação interativa do Prisma, a transação Postgres subjacente entra em estado
  // "aborted" e QUALQUER query seguinte na mesma transação falha com "current transaction is
  // aborted" — não dá para simplesmente reler dentro do mesmo `tx` depois de capturar o P2002
  // (mesma lição já aplicada em `claim.ts`: a releitura de recuperação sempre usa uma
  // transação/conexão NOVA, nunca continua na que acabou de falhar). Aqui nem precisávamos da
  // transação para isto: a constraint única já é a fonte de atomicidade real — o
  // `findUnique`+`create` não-transacional é exatamente o padrão "tenta, trata P2002" do resto
  // do código.
  let result: "new" | "already_processed";
  try {
    const existingEvent = await prisma.providerEvent.findUnique({
      where: { provider_providerEventId: { provider: "mercadopago", providerEventId } },
    });
    if (existingEvent?.processedAt) {
      result = "already_processed";
    } else if (existingEvent) {
      // Existe mas ainda não foi marcado como processado (a outra chamada concorrente está no
      // meio do próprio processamento) — segue como "new". O pior caso é aplicar o pagamento em
      // paralelo com a outra chamada, mas `applyInvoicePayment` já é idempotente por si (dupla
      // trava, ver cabeçalho deste arquivo), então não há efeito duplicado real.
      result = "new";
    } else {
      await prisma.providerEvent.create({
        data: { provider: "mercadopago", providerEventId, payload: { status: payment.status, externalReference: payment.externalReference } },
      });
      result = "new";
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const concurrent = await prisma.providerEvent.findUniqueOrThrow({
      where: { provider_providerEventId: { provider: "mercadopago", providerEventId } },
    });
    result = concurrent.processedAt ? "already_processed" : "new";
  }

  if (result === "already_processed") {
    await recordWebhookReceived("already_processed", info);
    return { status: "already_processed" };
  }

  if (payment.status !== "approved" || !payment.externalReference) {
    await prisma.providerEvent.update({
      where: { provider_providerEventId: { provider: "mercadopago", providerEventId } },
      data: { processedAt: new Date() },
    });
    await recordWebhookReceived("ignored", info);
    return { status: "ignored" };
  }

  // Valor pago tem que bater com a fatura (fail-closed: valor ausente também não baixa).
  const invoiceForAmount = await prisma.invoice.findUnique({ where: { id: payment.externalReference }, select: { amountCents: true } });
  if (invoiceForAmount && payment.transactionAmountCents !== invoiceForAmount.amountCents) {
    logger.warn("billing.webhook.amount_mismatch", {
      invoiceId: payment.externalReference,
      providerEventId,
      paidCents: payment.transactionAmountCents,
      expectedCents: invoiceForAmount.amountCents,
    });
    await prisma.providerEvent.update({
      where: { provider_providerEventId: { provider: "mercadopago", providerEventId } },
      data: {
        processedAt: new Date(),
        payload: { status: payment.status, externalReference: payment.externalReference, amountMismatch: true },
      },
    });
    await recordWebhookReceived("ignored", info);
    return { status: "ignored" };
  }

  const applied = await applyInvoicePayment(payment.externalReference, payment.dateApproved ?? new Date(), payment.id);

  if (applied.voided) {
    // Pagamento aprovado para fatura ANULADA (teste não convertido já cancelado): não reativa
    // sozinho. Fica registrado no evento (auditoria) e no log para o admin decidir — reativar a
    // empresa e/ou estornar no Mercado Pago. Nunca é tratado como erro (o MP não deve reentregar).
    logger.warn("billing.webhook.payment_for_void_invoice", { invoiceId: payment.externalReference, providerEventId });
    await prisma.providerEvent.update({
      where: { provider_providerEventId: { provider: "mercadopago", providerEventId } },
      data: {
        processedAt: new Date(),
        payload: { status: payment.status, externalReference: payment.externalReference, voidedInvoicePayment: true },
      },
    });
    await recordWebhookReceived("ignored", info);
    return { status: "ignored" };
  }

  await prisma.providerEvent.update({
    where: { provider_providerEventId: { provider: "mercadopago", providerEventId } },
    data: { processedAt: new Date() },
  });

  await recordWebhookReceived("processed", info);
  return { status: "processed" };
}
