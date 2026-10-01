import crypto from "node:crypto";
import { getActiveMercadoPagoCredentials, getMercadoPagoCredentials, type MercadoPagoEnv } from "@/modules/platform/mercadopago-config";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { tryGetPublicBaseUrl } from "@/lib/public-url";

/**
 * Adaptador do Mercado Pago (Pix pontual, docs/arquitetura.md §7.1). Interface isolada de
 * propósito — não temos credenciais reais ainda (PENDÊNCIAS no handoff), então todo o resto do
 * módulo de cobrança (webhook, tick) depende de `MercadoPagoGateway`, nunca do SDK/fetch direto,
 * para os testes injetarem `createMockMercadoPagoGateway()` em vez de bater na API real.
 */

export type PixPaymentResult = {
  paymentId: string;
  qrCode: string;
  copyPaste: string;
  expiresAt: Date;
};

export type MercadoPagoPaymentStatus = "approved" | "pending" | "rejected" | "cancelled" | "in_process" | string;

export type MercadoPagoPayment = {
  id: string;
  status: MercadoPagoPaymentStatus;
  dateApproved: Date | null;
  externalReference: string | null;
  /** Valor pago em centavos (`transaction_amount` do MP); `null` se a resposta não trouxe. */
  transactionAmountCents: number | null;
};

export type CreatePixPaymentInput = {
  /** `Invoice.id` — vai em `external_reference`, é como o webhook re-associa o pagamento à fatura. */
  externalReference: string;
  amountCents: number;
  description: string;
  payerEmail: string;
  /** Nome do pagador (`Tenant.name`) — o MP quebra em `first_name`/`last_name` (ver `splitPayerName`). */
  payerName: string;
  /**
   * CPF/CNPJ do pagador, só dígitos (`Tenant.document`, já validado por
   * `src/core/billing/document.ts` antes de chegar aqui). O Mercado Pago EXIGE
   * `payer.identification` para criar uma cobrança Pix — sem isso ele recusa com
   * `payer.identification.number attribute can't be null`, conferido contra o incidente real do
   * Parque das Feiras (`payments.pix.cpf.test.ts`). `null` faz `createPixPayment` lançar
   * `MercadoPagoApiError` com `kind: "missing_payer_document"` ANTES de chamar a API (falha
   * cedo — mesmo padrão do PF, "nem chega a chamar o gateway").
   */
  payerDocument: string | null;
  /** Chave de idempotência do MP (header `X-Idempotency-Key`) — evita criar 2 cobranças se a chamada for repetida. */
  idempotencyKey: string;
  expiresInDays: number;
};

export interface MercadoPagoGateway {
  /** Ambiente cujas credenciais este gateway usa (gravado em `Invoice.mpEnvironment` ao gerar o Pix). Ausente em fakes de teste. */
  readonly environment?: MercadoPagoEnv;
  createPixPayment(input: CreatePixPaymentInput): Promise<PixPaymentResult>;
  getPayment(paymentId: string): Promise<MercadoPagoPayment>;
  /**
   * Cancela um pagamento PENDENTE (`PUT /v1/payments/{id}` com `{ status: "cancelled" }`) — usado
   * quando a fatura é anulada (cancelamento da assinatura) para o Pix já emitido não poder mais
   * ser pago. Lança `MercadoPagoApiError` se o MP recusar (ex.: pagamento já aprovado).
   */
  cancelPayment(paymentId: string): Promise<void>;
}

const API_BASE = "https://api.mercadopago.com";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;

/**
 * `fetch` com timeout e retry — só em erro de rede/timeout e 5xx (nunca em 4xx: erro do nosso
 * lado, repetir não ajuda), mesma política do §6.1 ("no n8n: timeout de 10s; retry 3x só em
 * 5xx e timeout, nunca em 409" — aplicamos a mesma régua aqui, chamando o MP em vez de sermos
 * chamados por ele).
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        lastError = new Error(`Mercado Pago respondeu ${response.status}`);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_RETRIES) break;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Falha ao chamar Mercado Pago");
}

/**
 * Classificação de falha do Mercado Pago (conferida contra o Parque das Feiras,
 * `backend/src/lib/mercadopago-errors.ts` — lá corrigiu um incidente real: cobrança Pix sem CPF
 * virava 500 mudo em produção porque nada classificava a resposta 400 do MP).
 *
 * `unavailable` é o lado seguro: quando não dá para saber o motivo (sem status, corpo
 * irreconhecível), tratamos como "o MP não respondeu" — nunca como "o pagador errou algo", que
 * mandaria a pessoa errada resolver o problema.
 */
export type MercadoPagoFailureKind =
  | "missing_payer_document"
  | "invalid_payer_document"
  | "invalid_credentials"
  | "pix_key_not_enabled"
  | "rate_limited"
  | "payload_rejected"
  | "unavailable";

export class MercadoPagoApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: MercadoPagoFailureKind = "unavailable",
  ) {
    super(message);
    this.name = "MercadoPagoApiError";
  }
}

/** Marcadores textuais de "a conta do vendedor não tem chave Pix habilitada" (erro 13253 do MP). */
const PIX_KEY_MARKERS = ["without key enabled for qr render", "pa_unauthorized_result_from_policies", "collector user without key"];

/**
 * Marcadores ancorados no CAMPO (`payer.identification`/`identification.number`), não na
 * palavra solta — um `includes("cpf")` classificaria qualquer menção a CPF (inclusive a nossa
 * própria, no corpo que ENVIAMOS) como recusa, o que é o mesmo tipo de inversão que o Parque das
 * Feiras já documentou (`mercadopago-errors.ts`, `MARCADORES_DOCUMENTO_PAGADOR`).
 */
const PAYER_DOCUMENT_MARKERS = [/payer[._]?identification/, /identification\.(number|type)/, /\bidentification\b[^|]{0,40}\b(number|type|attribute)\b/];

/** Classifica o corpo/status de uma resposta de erro do MP na criação do Pix. */
function classifyMercadoPagoError(status: number, body: string): MercadoPagoFailureKind {
  const haystack = body.toLowerCase();

  if (haystack.includes("13253") || PIX_KEY_MARKERS.some((m) => haystack.includes(m))) {
    return "pix_key_not_enabled";
  }
  if (status === 401 || status === 403) return "invalid_credentials";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";

  const mentionsIdentification = PAYER_DOCUMENT_MARKERS.some((r) => r.test(haystack));
  if (mentionsIdentification) {
    const missing = haystack.includes("can't be null") || haystack.includes("cannot be null") || haystack.includes("is required");
    return missing ? "missing_payer_document" : "invalid_payer_document";
  }

  if (status === 400 || status === 422) return "payload_rejected";
  return "unavailable";
}

/**
 * Quebra `Tenant.name` em `first_name`/`last_name` para `payer` — o MP não aceita nome único.
 * Mesma regra do Parque das Feiras (`lib/mercadopago.ts#createPixCharge`): sem sobrenome, repete
 * o primeiro nome como último (nunca manda `last_name` vazio).
 */
function splitPayerName(name: string): { firstName: string; lastName: string } {
  const [firstName, ...rest] = name.trim().split(/\s+/);
  const lastName = rest.join(" ") || firstName || "";
  return { firstName: firstName || "", lastName };
}

/**
 * `payer.identification` no formato que o MP exige — CPF (11 dígitos) ou CNPJ (14 dígitos).
 * `payerDocument` já chega só com dígitos (`src/core/billing/document.ts` normaliza e valida
 * antes); aqui só decide o `type` pela contagem, igual ao Parque das Feiras
 * (`lib/mercadopago.ts`: `.length === 14 ? 'CNPJ' : 'CPF'`).
 */
function buildPayerIdentification(payerDocument: string): { type: "CPF" | "CNPJ"; number: string } {
  return { type: payerDocument.length === 14 ? "CNPJ" : "CPF", number: payerDocument };
}

/**
 * `{ notification_url }` para entrar no corpo do POST via spread, ou `{}` quando não há como
 * resolver a URL pública agora (fora de uma requisição E `PlatformSettings.publicBaseUrl` ainda
 * não gravado — ver `getPublicBaseUrl`). Nunca lança: a criação do Pix não pode falhar por causa
 * disto, ela só perde a URL explícita e volta a depender da cadastrada manualmente no MP.
 */
async function notificationUrlOrUndefined(): Promise<{ notification_url: string } | Record<string, never>> {
  const base = await tryGetPublicBaseUrl();
  return base ? { notification_url: `${base}/api/webhooks/mercadopago` } : {};
}

/** Implementação real, contra a API do Mercado Pago (Pagamentos Pix). */
export function createMercadoPagoGateway(accessToken: string, environment?: MercadoPagoEnv): MercadoPagoGateway {
  return {
    environment,
    async createPixPayment(input) {
      // Falha CEDO, sem chamar o MP — mesma defesa do incidente do Parque das Feiras
      // (`payments.pix.cpf.test.ts`, "FALHA CEDO: nem chega a chamar o gateway"): o MP exige
      // `payer.identification` para Pix, então mandar a cobrança sem CPF/CNPJ é certeza de
      // recusa. Falhar antes do fetch evita gastar a chamada de rede (e o retry/timeout de
      // `fetchWithRetry`) num pedido que o MP vai recusar de todo jeito.
      if (!input.payerDocument) {
        throw new MercadoPagoApiError("Falta o CPF/CNPJ do pagador para criar a cobrança Pix.", undefined, "missing_payer_document");
      }

      const { firstName, lastName } = splitPayerName(input.payerName);
      // Instante absoluto — `.toISOString()` (sufixo `Z`) é ISO-8601 válido para o MP e
      // equivalente a `-03:00` na mesma hora relógio; evita aritmética manual de fuso (o
      // Parque das Feiras usa `-03:00` porque o servidor dele roda nesse fuso — aqui preferimos
      // o formato sem deslocamento, que não tem como errar por horário de verão nem por o
      // processo rodar em outro fuso).
      const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

      const response = await fetchWithRetry(`${API_BASE}/v1/payments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "X-Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({
          transaction_amount: Math.round(input.amountCents) / 100,
          description: input.description,
          payment_method_id: "pix",
          external_reference: input.externalReference,
          date_of_expiration: expiresAt.toISOString(),
          // URL explícita por cobrança (conferido contra o Parque das Feiras,
          // `lib/mercadopago.ts#createPixCharge`) — mais robusto que depender só da URL
          // cadastrada manualmente no painel de Developers do MP, e nunca falha a criação do
          // Pix se `getPublicBaseUrl()` não tiver de onde resolver (cai no que já estava
          // cadastrado no MP).
          ...(await notificationUrlOrUndefined()),
          payer: {
            email: input.payerEmail,
            first_name: firstName,
            last_name: lastName,
            identification: buildPayerIdentification(input.payerDocument),
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const kind = classifyMercadoPagoError(response.status, body);
        logger.error("mercadopago.createPixPayment.failed", { status: response.status, kind });
        throw new MercadoPagoApiError(`Mercado Pago recusou a criação do Pix (${response.status}): ${body.slice(0, 300)}`, response.status, kind);
      }

      const json = (await response.json()) as {
        id: number | string;
        point_of_interaction?: { transaction_data?: { qr_code?: string; qr_code_base64?: string } };
        date_of_expiration?: string | null;
      };
      const qr = json.point_of_interaction?.transaction_data;
      if (!qr?.qr_code) {
        throw new MercadoPagoApiError("Resposta do Mercado Pago sem QR code Pix.");
      }

      return {
        paymentId: String(json.id),
        qrCode: qr.qr_code,
        copyPaste: qr.qr_code,
        // O MP é quem define quando o QR de fato morre (ele pode ajustar o `date_of_expiration`
        // que mandamos) — usar o valor da RESPOSTA como fonte de verdade evita que
        // `Invoice.pixExpiresAt` diga uma coisa e o QR real diga outra. Cai no valor calculado
        // só se a resposta vier sem o campo (nunca visto na prática, mas não é motivo pra lançar).
        expiresAt: json.date_of_expiration ? new Date(json.date_of_expiration) : expiresAt,
      };
    },

    async getPayment(paymentId) {
      const response = await fetchWithRetry(`${API_BASE}/v1/payments/${paymentId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        throw new MercadoPagoApiError(`Mercado Pago recusou a consulta do pagamento (${response.status}).`, response.status);
      }

      const json = (await response.json()) as {
        id: number | string;
        status: string;
        date_approved: string | null;
        external_reference: string | null;
        transaction_amount?: number | null;
      };

      return {
        id: String(json.id),
        status: json.status,
        dateApproved: json.date_approved ? new Date(json.date_approved) : null,
        externalReference: json.external_reference,
        transactionAmountCents: typeof json.transaction_amount === "number" ? Math.round(json.transaction_amount * 100) : null,
      };
    },

    async cancelPayment(paymentId) {
      // Só dígitos: o id vai no path da URL (nunca confia no formato guardado no banco).
      if (!/^[0-9]{1,30}$/.test(paymentId)) {
        throw new MercadoPagoApiError("Identificador de pagamento do Mercado Pago inválido.", undefined, "payload_rejected");
      }
      const response = await fetchWithRetry(`${API_BASE}/v1/payments/${paymentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ status: "cancelled" }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new MercadoPagoApiError(
          `Mercado Pago recusou o cancelamento do pagamento (${response.status}).`,
          response.status,
          classifyMercadoPagoError(response.status, body),
        );
      }
    },
  };
}

/**
 * Resolve o gateway real a partir do access token do ambiente ATIVO (produção ou teste, escolhido
 * pelo admin — `getActiveMercadoPagoCredentials`). Fail-closed: token ausente ou que não decifra
 * lança `MERCADOPAGO_NOT_CONFIGURED`.
 *
 * `forNewCharge: true` (Gerar Pix, faturas do tick) também respeita "cobrança liberada"
 * (`mpEnabled`): desligada, lança `MERCADOPAGO_DISABLED`. O webhook NÃO usa isso — consultar um
 * pagamento já feito precisa continuar funcionando mesmo com a cobrança nova bloqueada.
 */
export async function getMercadoPagoGateway(options: { forNewCharge?: boolean } = {}): Promise<MercadoPagoGateway> {
  const active = await getActiveMercadoPagoCredentials();
  if (!active.accessToken) {
    throw new DomainError("MERCADOPAGO_NOT_CONFIGURED", "Mercado Pago não configurado (access token do ambiente ativo ausente).");
  }
  if (options.forNewCharge && !active.enabled) {
    throw new DomainError("MERCADOPAGO_DISABLED", "Cobrança pelo Mercado Pago desligada pelo administrador da plataforma.");
  }
  return createMercadoPagoGateway(active.accessToken, active.environment);
}

/**
 * Gateway com as credenciais de um ambiente ESPECÍFICO (não o ativo) — conciliação de uma fatura
 * usa o ambiente em que o Pix foi gerado (`Invoice.mpEnvironment`), porque o admin pode ter
 * trocado o ativo depois. Nunca checa `mpEnabled` (consultar pagamento já feito não é cobrança
 * nova). Lança `MERCADOPAGO_NOT_CONFIGURED` se o access token daquele ambiente não existe.
 */
export async function getMercadoPagoGatewayForEnvironment(environment: MercadoPagoEnv): Promise<MercadoPagoGateway> {
  const creds = await getMercadoPagoCredentials(environment);
  if (!creds.accessToken) {
    throw new DomainError("MERCADOPAGO_NOT_CONFIGURED", `Mercado Pago sem access token salvo para o ambiente ${environment}.`);
  }
  return createMercadoPagoGateway(creds.accessToken, environment);
}

/**
 * Tolerância contra replay: um `x-signature` capturado (ex.: log de proxy, MITM parcial) não
 * expira por si só — o `ts` está DENTRO do HMAC, mas nada nesse header o compara contra o
 * relógio atual. Sem isto, o mesmo header replayado passaria a validação para sempre. 10 min é
 * generoso o bastante para reentregas legítimas do MP com atraso de rede, e curto o bastante
 * para não ser útil a um replay (revisão de segurança 2026-09-28, achado MÉDIA/INFO).
 */
const SIGNATURE_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * Validação da assinatura do webhook do Mercado Pago (`x-signature`), conferida em 2026-09-28
 * pelo Atlas contra o SDK oficial em Go (`github.com/mercadopago/sdk-go/pkg/webhook`,
 * `ValidateSignature`) — substitui a implementação anterior (feita de memória/doc em texto),
 * que tinha 2 desvios reais:
 *
 * 1. **`data.id` vem do QUERY PARAM**, não do corpo — quem resolve isso é `route.ts` (o corpo
 *    pode nem ter `data.id`, ou pode ter um valor diferente do que o MP realmente assinou; a
 *    assinatura é sobre o que veio na URL da notificação).
 * 2. **Cada par ausente é OMITIDO do manifest**, nunca causa rejeição isolada — antes, `!dataId
 *    || !xRequestId` já devolvia `false` sem nem montar o manifest; o formato correto é: se
 *    `data.id` (ou `request-id`) não vier, o manifest simplesmente não tem aquele segmento, e a
 *    validação segue baseada no que sobrou.
 *
 * O header `x-signature` vem no formato `ts=<timestamp>,v1=<hash>`. A assinatura é
 * `HMAC-SHA256` (hex) do manifest `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (pares
 * ausentes omitidos, nesta ordem), com `data.id` sempre em minúsculas, usando
 * o webhook secret do ambiente ATIVO (`getActiveMercadoPagoCredentials`) como chave.
 */
export type SignatureFailureReason = "missing_signature" | "malformed_signature" | "stale_timestamp" | "bad_signature";

export function verifyMercadoPagoSignature(params: {
  xSignature: string | null;
  xRequestId: string | null;
  /** Já deve vir do query param `data.id` (nunca do corpo) — ver `route.ts`. */
  dataId: string | null;
  secret: string;
  /** Só para teste — no runtime real é sempre `new Date()` (injetado via `now` no `webhook.ts`). */
  now?: Date;
}): boolean {
  return explainMercadoPagoSignature(params) === null;
}

/** Mesma validação, mas devolve o MOTIVO da falha (diagnóstico do Admin → Saúde) ou `null` se válida. */
export function explainMercadoPagoSignature(params: {
  xSignature: string | null;
  xRequestId: string | null;
  dataId: string | null;
  secret: string;
  now?: Date;
}): SignatureFailureReason | null {
  const { xSignature, xRequestId, dataId, secret } = params;
  if (!xSignature) return "missing_signature";
  if (!secret) return "bad_signature";

  const parts = new Map<string, string>();
  for (const chunk of xSignature.split(",")) {
    const [key, value] = chunk.split("=").map((s) => s.trim());
    if (key && value) parts.set(key, value);
  }
  const ts = parts.get("ts");
  const v1 = parts.get("v1");
  if (!ts || !v1) return "malformed_signature";

  const tsSeconds = Number(ts);
  if (!Number.isFinite(tsSeconds)) return "malformed_signature";
  const now = params.now ?? new Date();
  if (Math.abs(now.getTime() - tsSeconds * 1000) > SIGNATURE_TOLERANCE_MS) {
    return "stale_timestamp";
  }

  let manifest = "";
  if (dataId) manifest += `id:${dataId.toLowerCase()};`;
  if (xRequestId) manifest += `request-id:${xRequestId};`;
  manifest += `ts:${ts};`;

  const expected = crypto.createHmac("sha256", secret).update(manifest).digest("hex");

  const expectedBuf = Buffer.from(expected);
  const receivedBuf = Buffer.from(v1);
  if (expectedBuf.length !== receivedBuf.length) return "bad_signature";
  return crypto.timingSafeEqual(expectedBuf, receivedBuf) ? null : "bad_signature";
}
