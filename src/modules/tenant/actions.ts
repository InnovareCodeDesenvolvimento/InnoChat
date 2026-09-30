"use server";

import { z } from "zod";
import { requireTenantMember } from "@/lib/auth/guards";
import { DomainError } from "@/lib/errors";
import { runAction, type Result } from "@/lib/result";
import { assertTenantCanWrite } from "@/modules/billing/service";
import { getBotRules, updateBotRules, updateTenantDocument, updateTenantTheme, type BotRules } from "./service";

const PANEL_THEMES = ["INDIGO_CLINICO", "AMBAR_ESTUDIO", "VERDE_SLATE"] as const;

const updateThemeSchema = z.object({
  theme: z.enum(PANEL_THEMES),
});

const updateDocumentSchema = z.object({
  document: z.string().min(1, "Informe o CPF ou CNPJ."),
});

/**
 * Troca o tema visual do painel (docs/arquitetura.md §5 — "só os 3 temas prontos"). Restrito a
 * `OWNER`: é decisão de identidade da empresa, não operação do dia a dia.
 */
export async function updateTenantThemeAction(tenantSlug: string, input: unknown): Promise<Result<{ theme: string }>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug, ["OWNER"]);
    await assertTenantCanWrite(tenant.id);
    const data = updateThemeSchema.parse(input);
    const updated = await updateTenantTheme(tenant.id, data.theme);
    return { theme: updated.theme };
  });
}

/**
 * Cadastra/atualiza o CPF/CNPJ da empresa (docs/contratos.md, seção Cobrança — CONTRATO NOVO
 * para a Lyra: a tela de Configurações precisa de um campo para chamar esta action antes da
 * empresa conseguir gerar Pix). Restrito a `OWNER`, mesma régua do tema visual: é dado de
 * identidade/fiscal da empresa, não operação do dia a dia.
 */
export async function updateTenantDocumentAction(tenantSlug: string, input: unknown): Promise<Result<{ document: string }>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug, ["OWNER"]);
    await assertTenantCanWrite(tenant.id);
    const data = updateDocumentSchema.parse(input);
    const updated = await updateTenantDocument(tenant.id, data.document);
    return { document: updated.document! };
  });
}

const botRulesSchema = z.object({
  maxFutureAppointmentsPerContact: z.number().int().min(0).max(20),
  slotGranularityMin: z.union([z.literal(15), z.literal(30)]),
  handoffResumeMinutes: z.number().int().min(30).max(1440).multipleOf(15),
  // Opcional: omitido = não altera (compatível com quem ainda não envia o campo).
  notifyClientOnStaffChanges: z.boolean().optional(),
});

/** Regras do bot da empresa (limite por cliente, grade 15/30, retomada do atendente). Leitura: qualquer membro; escrita (abaixo): só `OWNER`. */
export async function getBotRulesAction(tenantSlug: string): Promise<Result<BotRules>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    return getBotRules(tenant.id);
  });
}

export async function updateBotRulesAction(tenantSlug: string, input: unknown): Promise<Result<BotRules>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug, ["OWNER"]);
    await assertTenantCanWrite(tenant.id);
    const parsed = botRulesSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = String(issue?.path[0] ?? "");
      throw new DomainError("INVALID_PAYLOAD", "Valor inválido nas regras do bot.", { field });
    }
    return updateBotRules(tenant.id, parsed.data);
  });
}
