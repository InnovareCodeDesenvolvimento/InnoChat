"use server";

import { z } from "zod";
import { requireTenantMember } from "@/lib/auth/guards";
import { DomainError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { runAction, type Result } from "@/lib/result";
import { getBillingContact, updateBillingContact, type BillingContactView } from "./contact";

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

const updateSchema = z
  .object({
    billingEmail: z.string().max(255).nullable().optional(),
    billingWhatsapp: z.string().max(30).nullable().optional(),
    optOut: z.boolean().optional(),
  })
  .strict();

const UPDATE_LIMIT = 10;
const UPDATE_WINDOW_MS = 60 * 60 * 1000;

/** Só OWNER escreve. Erros: `FORBIDDEN`, `INVALID_PAYLOAD`, `INVALID_EMAIL`, `INVALID_PHONE`, `RATE_LIMITED` (10 por hora). */
export async function updateBillingContactAction(tenantSlug: string, input: unknown): Promise<Result<BillingContactView>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug, ["OWNER"]);
    const limit = checkRateLimit(`billing-contact:${tenant.id}`, UPDATE_LIMIT, UPDATE_WINDOW_MS);
    if (!limit.allowed) {
      throw new DomainError("RATE_LIMITED", "Muitas alterações seguidas. Tente de novo daqui a alguns minutos.", { retryAfterMs: limit.retryAfterMs });
    }
    const data = updateSchema.parse(input ?? {});
    return updateBillingContact(tenant.id, data);
  });
}
