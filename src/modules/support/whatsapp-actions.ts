"use server";

import { z } from "zod";
import { createHash } from "node:crypto";
import { requireTenantMember } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import { runIdempotent } from "@/lib/idempotency";
import { runAction, type Result } from "@/lib/result";
import { assertTenantCanWrite } from "@/modules/billing/service";
import { recordAudit } from "@/modules/audit/record";
import { CONVERSATION_ITEM_SELECT, toConversationItem, type ConversationItem } from "@/modules/conversations/service";
import { sendTextToContact } from "@/modules/attendance/outbound";
import { AGENT_MESSAGE_MAX } from "@/modules/attendance/service";
import { sanitizeChatBody } from "@/modules/conversations/log";
import type { EvolutionClient } from "@/modules/whatsapp/evolution-client";

export const SUPPORT_PREFIX = "[Suporte InnoChat] ";
const IDEMPOTENCY_WINDOW_MS = 60 * 1000; // 1 minuto

const sendSupportSchema = z.object({
  tenantSlug: z.string().min(1).max(100),
  contactId: z.string().min(1).max(120),
  text: z.string().min(1).max(20_000),
  clientMessageId: z.string().uuid().optional(),
});

export type SendSupportMessageOutput = {
  message: ConversationItem;
  noop?: boolean;
};

/**
 * Envia mensagem ao cliente do WhatsApp sob a identidade de Suporte da Plataforma.
 * Restrito a admin em sessão ativa de suporte (impersonação).
 * O body recebe o selo prefixado `[Suporte InnoChat] `.
 * Envia pela instância da própria empresa e audita com PLATFORM_ADMIN e supportSessionId.
 * Idempotente: envio idêntico em < 1 min para o mesmo contato vira noop.
 */
export async function sendSupportMessageAction(
  tenantSlugOrInput: string | { tenantSlug: string; contactId: string; text?: string; body?: string; clientMessageId?: string },
  contactIdArg?: string,
  bodyArg?: string,
  deps?: { evolution?: EvolutionClient; now?: Date },
): Promise<Result<SendSupportMessageOutput>> {
  return runAction(async () => {
    const rawInput = typeof tenantSlugOrInput === "string"
      ? { tenantSlug: tenantSlugOrInput, contactId: contactIdArg, text: bodyArg }
      : { tenantSlug: tenantSlugOrInput.tenantSlug, contactId: tenantSlugOrInput.contactId, text: tenantSlugOrInput.text ?? tenantSlugOrInput.body, clientMessageId: tenantSlugOrInput.clientMessageId };

    const parsed = sendSupportSchema.parse(rawInput);
    const ctx = await requireTenantMember(parsed.tenantSlug);

    if (!ctx.isSupportImpersonation) {
      throw new DomainError(
        "SUPPORT_SESSION_REQUIRED",
        "Esta ação é permitida apenas durante uma sessão de suporte ativa por administrador da plataforma.",
      );
    }

    await assertTenantCanWrite(ctx.tenant.id);

    const rawBody = parsed.text.trim();
    if (!rawBody) {
      throw new DomainError("TEXT_EMPTY", "Escreva uma mensagem antes de enviar.");
    }

    if (rawBody.length > AGENT_MESSAGE_MAX) {
      throw new DomainError("TEXT_TOO_LONG", `A mensagem passa de ${AGENT_MESSAGE_MAX} caracteres.`, { max: AGENT_MESSAGE_MAX });
    }

    // Selo obrigatório para transparência com o cliente final
    const textToSend = rawBody.startsWith(SUPPORT_PREFIX) ? rawBody : `${SUPPORT_PREFIX}${rawBody}`;
    const sanitized = sanitizeChatBody(textToSend);

    // Idempotência: verificar se mensagem idêntica foi salva nos últimos 60s
    const now = deps?.now ?? new Date();
    const oneMinuteAgo = new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS);

    const recent = await forTenant(ctx.tenant.id).chatMessage.findFirst({
      where: {
        contactId: parsed.contactId,
        body: sanitized,
        createdAt: { gte: oneMinuteAgo },
      },
      select: CONVERSATION_ITEM_SELECT,
    });

    if (recent) {
      return {
        message: toConversationItem(recent),
        noop: true,
      };
    }

    const bodyHash = createHash("sha256").update(sanitized).digest("hex").slice(0, 16);
    const dedupKey = parsed.clientMessageId
      ? `support-msg:${ctx.tenant.id}:${parsed.contactId}:${parsed.clientMessageId}`
      : `support-msg:${ctx.tenant.id}:${parsed.contactId}:${bodyHash}`;

    return runIdempotent(dedupKey, IDEMPOTENCY_WINDOW_MS, async () => {
      // Re-checagem atômica dentro do lock em memória
      const doubleCheck = await forTenant(ctx.tenant.id).chatMessage.findFirst({
        where: {
          contactId: parsed.contactId,
          body: sanitized,
          createdAt: { gte: oneMinuteAgo },
        },
        select: CONVERSATION_ITEM_SELECT,
      });
      if (doubleCheck) {
        return {
          message: toConversationItem(doubleCheck),
          noop: true,
        };
      }

      const outboundResult = await sendTextToContact({
        tenantId: ctx.tenant.id,
        contactId: parsed.contactId,
        text: sanitized,
        authorUserId: ctx.user.id,
        evolution: deps?.evolution,
      });

      if (outboundResult.outcome !== "SENT") {
        throw new DomainError(
          `SEND_FAILED_${outboundResult.outcome}`,
          "Não foi possível enviar a mensagem pelo WhatsApp da empresa.",
          { outcome: outboundResult.outcome },
        );
      }

      await recordAudit({
        tenantId: ctx.tenant.id,
        actor: { userId: ctx.user.id, role: "PLATFORM_ADMIN" },
        action: "support.whatsapp.message_sent",
        targetType: "contact",
        targetId: parsed.contactId,
        summary: "Enviou mensagem ao cliente como suporte InnoChat.",
        supportSessionId: ctx.supportSessionId,
        changes: { mensagem: { de: null, para: sanitized } },
      });

      // Carrega mensagem recém-salva
      const saved = await forTenant(ctx.tenant.id).chatMessage.findFirst({
        where: { id: outboundResult.message.id },
        select: CONVERSATION_ITEM_SELECT,
      });

      return {
        message: saved
          ? toConversationItem(saved)
          : {
              id: outboundResult.message.id,
              direction: "OUTBOUND",
              body: sanitized,
              createdAt: outboundResult.message.createdAt.toISOString(),
              instanceLabel: null,
              author: "AGENT",
              authorName: "Suporte InnoChat",
            },
        noop: false,
      };
    });
  });
}
