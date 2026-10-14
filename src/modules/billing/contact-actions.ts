"use server";

import { z } from "zod";
import { requirePlatformAdmin, requireTenantMember } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { runAction, type Result } from "@/lib/result";
import { maskPhone } from "@/core/platform-whatsapp/rules";
import { memberActor, platformAdminActor, recordAudit } from "@/modules/audit/record";
import { getBillingContact, updateBillingContact, type BillingContactView } from "./contact";
import { assertBillingWhatsappReachable } from "./contact-whatsapp-check";

/**
 * Contato de cobrança da empresa (tela Assinatura). Contrato em docs/contratos.md ("Régua de cobrança").
 * Sem `assertTenantCanWrite`: a tela de Assinatura funciona com a conta suspensa.
 */

/** OWNER e STAFF leem. */
export async function getBillingContactAction(tenantSlug: string): Promise<Result<BillingContactView>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    return getBillingContact(tenant.id);
  });
}

/** Admin: lê o contato de cobrança de uma empresa (para o cartão editável da tela da empresa). */
export async function getBillingContactAsAdminAction(tenantId: string): Promise<Result<BillingContactView>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getBillingContact(tenantId);
  });
}

const updateSchema = z
  .object({
    billingEmail: z.string().max(255).nullable().optional(),
    billingWhatsapp: z.string().max(30).nullable().optional(),
    optOut: z.boolean().optional(),
    /** "Salvar mesmo assim": pula a conferência de "esse número tem WhatsApp?". */
    skipWhatsappCheck: z.boolean().optional(),
  })
  .strict();

const UPDATE_LIMIT = 10;
const UPDATE_WINDOW_MS = 60 * 60 * 1000;

/** Só OWNER escreve. Erros: `FORBIDDEN`, `INVALID_PAYLOAD`, `INVALID_EMAIL`, `INVALID_PHONE`, `NO_WHATSAPP` (número novo sem WhatsApp; repetir com `skipWhatsappCheck: true`), `RATE_LIMITED` (10 por hora). */
export async function updateBillingContactAction(tenantSlug: string, input: unknown): Promise<Result<BillingContactView>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug, ["OWNER"]);
    const { tenant } = ctx;
    const limit = checkRateLimit(`billing-contact:${tenant.id}`, UPDATE_LIMIT, UPDATE_WINDOW_MS);
    if (!limit.allowed) {
      throw new DomainError("RATE_LIMITED", "Muitas alterações seguidas. Tente de novo daqui a alguns minutos.", { retryAfterMs: limit.retryAfterMs });
    }
    const { skipWhatsappCheck, ...data } = updateSchema.parse(input ?? {});
    const before = await getBillingContact(tenant.id);
    await assertBillingWhatsappReachable(tenant.id, data.billingWhatsapp, skipWhatsappCheck);
    const updated = await updateBillingContact(tenant.id, data);
    // E-mail e telefone são dados pessoais: o histórico diz QUE mudaram, nunca o valor.
    const changes: Record<string, { de: unknown; para: unknown }> = {};
    if (before.billingEmail !== updated.billingEmail) changes["email_de_cobranca"] = { de: before.billingEmail ? "informado" : "vazio", para: updated.billingEmail ? "informado" : "vazio" };
    if (before.billingWhatsappE164 !== updated.billingWhatsappE164) changes["whatsapp_de_cobranca"] = { de: before.billingWhatsappE164 ? "informado" : "vazio", para: updated.billingWhatsappE164 ? "informado" : "vazio" };
    if (before.optedOut !== updated.optedOut) changes["nao_receber_whatsapp"] = { de: before.optedOut, para: updated.optedOut };
    if (Object.keys(changes).length > 0) {
      await recordAudit({
        tenantId: tenant.id,
        actor: memberActor(ctx),
        action: "settings.billing_contact_changed",
        targetType: "tenant",
        targetId: tenant.id,
        summary: "Mudou o contato de cobrança da empresa.",
        changes,
        supportSessionId: ctx.supportSessionId ?? null,
      });
    }
    return updated;
  });
}

/**
 * Admin da plataforma corrige o contato de cobrança de uma empresa (dono digitou o número errado e não achou onde
 * trocar). Mesmo contrato e mesmos erros da ação do dono, sem o limite por hora (quem chama é o admin). A auditoria
 * guarda o número MASCARADO (nunca inteiro) e aparece só na área "empresas" do histórico, que é da plataforma.
 */
export async function updateBillingContactAsAdminAction(tenantSlug: string, input: unknown): Promise<Result<BillingContactView>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const tenant = await getPrisma().tenant.findUnique({ where: { slug: tenantSlug }, select: { id: true, name: true } });
    if (!tenant) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
    const { skipWhatsappCheck, ...data } = updateSchema.parse(input ?? {});
    const before = await getBillingContact(tenant.id);
    await assertBillingWhatsappReachable(tenant.id, data.billingWhatsapp, skipWhatsappCheck);
    const updated = await updateBillingContact(tenant.id, data);
    const mask = (value: string | null) => (value ? (maskPhone(value) ?? "informado") : "vazio");
    const changes: Record<string, { de: unknown; para: unknown }> = {};
    if (before.billingEmail !== updated.billingEmail) changes["email_de_cobranca"] = { de: before.billingEmail ? "informado" : "vazio", para: updated.billingEmail ? "informado" : "vazio" };
    if (before.billingWhatsappE164 !== updated.billingWhatsappE164) changes["whatsapp_de_cobranca"] = { de: mask(before.billingWhatsappE164), para: mask(updated.billingWhatsappE164) };
    if (before.optedOut !== updated.optedOut) changes["nao_receber_whatsapp"] = { de: before.optedOut, para: updated.optedOut };
    if (Object.keys(changes).length > 0) {
      await recordAudit({
        tenantId: tenant.id,
        actor: platformAdminActor(admin.id),
        action: "company.billing_contact_changed",
        targetType: "tenant",
        targetId: tenant.id,
        summary: updated.billingWhatsappE164 !== before.billingWhatsappE164 ? `Corrigiu o contato de cobrança de ${tenant.name} (WhatsApp ${mask(updated.billingWhatsappE164)}).` : `Corrigiu o contato de cobrança de ${tenant.name}.`,
        changes,
      });
    }
    return updated;
  });
}
