"use server";

import { z } from "zod";
import { requireTenantMember } from "@/lib/auth/guards";
import { DomainError } from "@/lib/errors";
import { runAction, type Result } from "@/lib/result";
import { assertTenantCanWrite } from "@/modules/billing/service";
import { getConversation, type ConversationItem } from "@/modules/conversations/service";
import { closeAttendance, listAttendanceQueue, sendAgentMessage, type AttendanceQueueItem } from "./service";

/**
 * Atendimento humano pelo painel. OWNER e STAFF. Leituras (fila, conversa) funcionam com a conta
 * suspensa; enviar e encerrar exigem `assertTenantCanWrite`. Contrato em docs/contratos.md.
 */

const refSchema = z.object({ tenantSlug: z.string().min(1).max(100), contactId: z.string().min(1).max(120) });

export async function listAttendanceQueueAction(input: { tenantSlug: string }): Promise<Result<{ items: AttendanceQueueItem[]; waitingCount: number }>> {
  return runAction(async () => {
    const data = z.object({ tenantSlug: z.string().min(1).max(100) }).parse(input);
    const ctx = await requireTenantMember(data.tenantSlug);
    return listAttendanceQueue(ctx.tenant.id);
  });
}

export async function getAttendanceConversationAction(input: {
  tenantSlug: string;
  contactId: string;
  cursor?: string;
}): Promise<Result<{ items: ConversationItem[]; nextCursor: string | null }>> {
  return runAction(async () => {
    const data = refSchema.extend({ cursor: z.string().max(200).optional() }).parse(input);
    const ctx = await requireTenantMember(data.tenantSlug);
    return getConversation(ctx.tenant.id, data.contactId, data.cursor);
  });
}

export async function sendAgentMessageAction(input: {
  tenantSlug: string;
  contactId: string;
  text: string;
  /** uuid gerado no cliente; o MESMO no "Tentar de novo" (dedup no servidor). */
  clientMessageId?: string;
}): Promise<Result<{ message: ConversationItem }>> {
  return runAction(async () => {
    // Teto alto no schema: o erro de domínio TEXT_TOO_LONG (4096) é do serviço.
    const data = refSchema.extend({ text: z.string().max(20_000), clientMessageId: z.string().uuid().optional() }).parse(input);
    const ctx = await requireTenantMember(data.tenantSlug);
    await assertTenantCanWrite(ctx.tenant.id);
    if (!data.text.trim()) throw new DomainError("TEXT_EMPTY", "Escreva uma mensagem antes de enviar.");
    return sendAgentMessage({ tenantId: ctx.tenant.id, userId: ctx.user.id, contactId: data.contactId, text: data.text, clientMessageId: data.clientMessageId });
  });
}

export async function closeAttendanceAction(input: { tenantSlug: string; contactId: string }): Promise<Result<{ closed: true; clientNotified: boolean }>> {
  return runAction(async () => {
    const data = refSchema.parse(input);
    const ctx = await requireTenantMember(data.tenantSlug);
    await assertTenantCanWrite(ctx.tenant.id);
    return closeAttendance({ tenantId: ctx.tenant.id, contactId: data.contactId });
  });
}
