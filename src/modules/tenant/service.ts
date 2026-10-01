import { getPrisma } from "@/lib/db/prisma";
import type { PanelTheme } from "@/lib/db/types";
import { DomainError } from "@/lib/errors";
import { validateCpfCnpj } from "@/core/billing";

/**
 * `Tenant` não está em `TENANT_SCOPED_MODELS` (é o próprio tenant, não tem coluna `tenantId` —
 * ver src/lib/db/tenant-scope.ts) — por isso usa `getPrisma()` direto, não `forTenant()`.
 * Só é seguro porque `tenantId` chega aqui já validado por `requireTenantMember()` na camada
 * de Server Action (o usuário da sessão precisa ter `Membership` nesse tenant).
 */
export async function updateTenantTheme(tenantId: string, theme: PanelTheme) {
  return getPrisma().tenant.update({
    where: { id: tenantId },
    data: { theme },
    select: { id: true, slug: true, theme: true },
  });
}

/**
 * CPF/CNPJ da empresa (docs/contratos.md, seção Cobrança) — o Mercado Pago exige este dado
 * (`payer.identification`) para criar a cobrança Pix da assinatura (ver
 * `src/modules/billing/mercadopago.ts`). Sempre valida o dígito verificador antes de gravar
 * (nunca confia em "tem 11/14 dígitos" — ver `src/core/billing/document.ts`), porque um
 * documento com dígito errado passaria batido aqui e só quebraria na hora de gerar o Pix, com
 * um erro bem menos claro.
 */
export async function updateTenantDocument(tenantId: string, rawDocument: string) {
  const validated = validateCpfCnpj(rawDocument);
  if (!validated.valid) {
    throw new DomainError("INVALID_DOCUMENT", "CPF ou CNPJ inválido. Confira os dígitos.");
  }
  return getPrisma().tenant.update({
    where: { id: tenantId },
    data: { document: validated.digits },
    select: { id: true, slug: true, document: true },
  });
}

export type BotRules = {
  maxFutureAppointmentsPerContact: number;
  slotGranularityMin: 15 | 30;
  handoffResumeMinutes: number;
  /** Só leitura: janela em que o bot fica quieto após a equipe responder pelo WhatsApp. */
  humanPauseMin: number;
  /** Avisa o cliente no WhatsApp quando a equipe cria/remarca/cancela pelo painel. */
  notifyClientOnStaffChanges: boolean;
};

const BOT_RULES_SELECT = {
  maxFutureAppointmentsPerContact: true,
  slotGranularityMin: true,
  handoffResumeMinutes: true,
  humanPauseMin: true,
  notifyClientOnStaffChanges: true,
} as const;

function toBotRules(row: { maxFutureAppointmentsPerContact: number; slotGranularityMin: number; handoffResumeMinutes: number; humanPauseMin: number; notifyClientOnStaffChanges: boolean }): BotRules {
  return { ...row, slotGranularityMin: row.slotGranularityMin === 15 ? 15 : 30 };
}

export async function getBotRules(tenantId: string): Promise<BotRules> {
  const row = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId }, select: BOT_RULES_SELECT });
  return toBotRules(row);
}

/** Os limites (0..20, 15|30, 30..1440 múltiplo de 15) também têm CHECK no banco; a validação de entrada é da action. */
export async function updateBotRules(
  tenantId: string,
  input: { maxFutureAppointmentsPerContact: number; slotGranularityMin: 15 | 30; handoffResumeMinutes: number; notifyClientOnStaffChanges?: boolean },
): Promise<BotRules> {
  const row = await getPrisma().tenant.update({
    where: { id: tenantId },
    data: {
      maxFutureAppointmentsPerContact: input.maxFutureAppointmentsPerContact,
      slotGranularityMin: input.slotGranularityMin,
      handoffResumeMinutes: input.handoffResumeMinutes,
      ...(input.notifyClientOnStaffChanges !== undefined ? { notifyClientOnStaffChanges: input.notifyClientOnStaffChanges } : {}),
    },
    select: BOT_RULES_SELECT,
  });
  return toBotRules(row);
}
