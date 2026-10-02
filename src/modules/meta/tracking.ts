import { getPrisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/db/types";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { logger } from "@/lib/logger";
import { SITE_URL } from "@/lib/site";
import { isValidMetaEventId } from "@/core/meta/pixel";
import { sendCapiEvent, type MetaServerEvent } from "./capi";
import { getMetaRuntimeConfig } from "./config";

/**
 * Eventos de conversão enviados pelo servidor. Duas regras amarram tudo:
 *  1. LGPD: só existe evento para quem ACEITOU o banner na hora do cadastro. O aceite vira uma linha
 *     em `ProviderEvent` (provider `meta-signup`, id = tenantId) com o que a Meta pede para casar o
 *     evento (cookies `_fbp`/`_fbc`, IP e navegador). Sem a linha, nada vai para a Meta, nem o Purchase.
 *  2. Nada aqui derruba o fluxo de quem chamou: tudo captura erro, e o envio HTTP é fire-and-forget.
 *
 * Dedup: `event_id` do navegador = `event_id` do servidor (CompleteRegistration). Purchase usa
 * `purchase-<invoiceId>` e uma trava em `ProviderEvent` (provider `meta-capi`) para sair uma vez só.
 */

const SIGNUP_PROVIDER = "meta-signup";
const CAPI_PROVIDER = "meta-capi";

export type MetaClientContext = {
  ip?: string | null;
  userAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
};

type SignupPayload = { userId: string; eventId: string } & MetaClientContext;

/** Fire-and-forget: a promessa nunca rejeita e ninguém precisa esperar por ela. */
function fireAndForget(task: Promise<unknown>): void {
  void task.catch((error) => {
    logger.warn("meta.tracking.unexpected", { errorName: error instanceof Error ? error.name : "unknown" });
  });
}

/**
 * Chamado logo depois de um cadastro concluído em que o navegador mandou `eventId` (= o visitante
 * aceitou o Pixel). Grava o aceite e dispara `CompleteRegistration` pela CAPI com o MESMO id.
 */
export async function trackCompleteRegistration(params: {
  tenantSlug: string;
  userId: string;
  eventId: unknown;
  client: MetaClientContext;
}): Promise<void> {
  try {
    if (!isValidMetaEventId(params.eventId)) return;
    const config = await getMetaRuntimeConfig();
    if (!config) return; // Pixel desligado: não guarda nada

    const prisma = getPrisma();
    const tenant = await prisma.tenant.findUnique({
      where: { slug: params.tenantSlug },
      select: { id: true, billingWhatsappE164: true },
    });
    if (!tenant) return;
    const user = await prisma.user.findUnique({ where: { id: params.userId }, select: { email: true } });

    const payload: SignupPayload = {
      userId: params.userId,
      eventId: params.eventId,
      ip: params.client.ip ?? null,
      userAgent: params.client.userAgent ?? null,
      fbp: params.client.fbp ?? null,
      fbc: params.client.fbc ?? null,
    };
    try {
      await prisma.providerEvent.create({
        data: { provider: SIGNUP_PROVIDER, providerEventId: tenant.id, payload: payload as unknown as Prisma.InputJsonValue, processedAt: new Date() },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    if (!config.capiToken || !user) return;
    fireAndForget(
      sendCapiEvent(
        { pixelId: config.pixelId, token: config.capiToken, testEventCode: config.testEventCode },
        {
          name: "CompleteRegistration",
          eventId: params.eventId,
          sourceUrl: `${SITE_URL}/cadastro`,
          user: {
            email: user.email,
            phone: tenant.billingWhatsappE164,
            externalId: params.userId,
            clientIp: params.client.ip,
            clientUserAgent: params.client.userAgent,
            fbp: params.client.fbp,
            fbc: params.client.fbc,
          },
          customData: { status: true, content_name: "Teste grátis" },
        },
      ),
    );
  } catch (error) {
    logger.warn("meta.tracking.complete_registration_failed", { errorName: error instanceof Error ? error.name : "unknown" });
  }
}

export type PurchaseInput = {
  tenantId: string;
  invoiceId: string;
  amountCents: number;
  paidAt: Date;
};

/**
 * Primeiro pagamento confirmado -> `Purchase` pela CAPI. Nunca lança e nunca espera a Meta. Sem
 * aceite gravado no cadastro, sem Pixel ligado ou sem token, não faz nada.
 */
export async function trackPurchase(input: PurchaseInput): Promise<void> {
  try {
    const config = await getMetaRuntimeConfig();
    if (!config?.capiToken) return;

    const prisma = getPrisma();
    const consent = await prisma.providerEvent.findUnique({
      where: { provider_providerEventId: { provider: SIGNUP_PROVIDER, providerEventId: input.tenantId } },
    });
    if (!consent) return;
    const payload = consent.payload as unknown as Partial<SignupPayload> | null;
    if (!payload?.userId) return;

    const eventId = `purchase-${input.invoiceId}`;
    try {
      await prisma.providerEvent.create({
        data: { provider: CAPI_PROVIDER, providerEventId: eventId, payload: { tenantId: input.tenantId }, processedAt: new Date() },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return; // já enviado
      throw error;
    }

    const [user, tenant] = await Promise.all([
      prisma.user.findUnique({ where: { id: payload.userId }, select: { email: true } }),
      prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { billingWhatsappE164: true } }),
    ]);
    const event: MetaServerEvent = {
      name: "Purchase",
      eventId,
      eventTime: Math.floor(input.paidAt.getTime() / 1000),
      sourceUrl: `${SITE_URL}/cadastro`,
      user: {
        email: user?.email ?? null,
        phone: tenant?.billingWhatsappE164 ?? null,
        externalId: payload.userId,
        clientIp: payload.ip,
        clientUserAgent: payload.userAgent,
        fbp: payload.fbp,
        fbc: payload.fbc,
      },
      customData: { currency: "BRL", value: Math.round(input.amountCents) / 100 },
    };
    fireAndForget(sendCapiEvent({ pixelId: config.pixelId, token: config.capiToken, testEventCode: config.testEventCode }, event));
  } catch (error) {
    logger.warn("meta.tracking.purchase_failed", { errorName: error instanceof Error ? error.name : "unknown" });
  }
}

/** Dispara sem esperar (a baixa da fatura, acionada pelo webhook, segue o caminho dela). */
export function trackPurchaseInBackground(input: PurchaseInput): void {
  fireAndForget(trackPurchase(input));
}

/** Envia um evento de teste com o código de teste salvo (botão do Admin). */
export async function sendMetaTestEvent(): Promise<{ ok: boolean; detail: string }> {
  const config = await getMetaRuntimeConfig();
  if (!config) return { ok: false, detail: "Ligue o Pixel e salve o ID antes de testar." };
  if (!config.capiToken) return { ok: false, detail: "Salve o token da API de Conversões antes de testar." };
  if (!config.testEventCode) return { ok: false, detail: "Informe o código de teste do Gerenciador de Eventos e salve. Sem ele, o evento entraria como real." };
  return sendCapiEvent(
    { pixelId: config.pixelId, token: config.capiToken, testEventCode: config.testEventCode },
    {
      name: "Lead",
      eventId: `teste-${Date.now()}`,
      sourceUrl: SITE_URL,
      user: { email: "teste@innochat.invalid" },
    },
  );
}
