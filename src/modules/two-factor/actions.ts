"use server";

import { z } from "zod";
import { requirePlatformAdmin, requireSessionUser } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db/prisma";
import { runAction, type Result } from "@/lib/result";
import { auditContextForUser } from "@/modules/audit/actors";
import { platformAdminActor, recordAudit } from "@/modules/audit/record";
import {
  adminResetTwoFactor,
  beginTwoFactorSetup,
  disableTwoFactor,
  getTwoFactorStatus,
  listCompanyTwoFactor,
  listOtherAdminsTwoFactor,
  type TwoFactorMemberRow,
  regenerateRecoveryCodes,
  type TwoFactorSetupStart,
  type TwoFactorStatus,
} from "./service";

/** Server Actions da verificação em 2 etapas. O id do usuário SEMPRE vem da sessão. */

const proofSchema = z
  .object({ password: z.string().max(200).optional(), code: z.string().trim().max(32).optional() })
  .refine((v) => !!v.password || !!v.code, { message: "Informe sua senha ou um código." });
const idSchema = z.object({ userId: z.string().trim().min(1).max(64) });

export async function getMyTwoFactorStatusAction(): Promise<Result<TwoFactorStatus>> {
  return runAction(async () => getTwoFactorStatus((await requireSessionUser()).id));
}

export async function beginTwoFactorSetupAction(): Promise<Result<TwoFactorSetupStart>> {
  return runAction(async () => beginTwoFactorSetup((await requireSessionUser()).id));
}

// Confirmar a ativação NÃO é Server Action: troca o cookie de sessão e uma action refaria a página com o cookie antigo
// (ver `src/app/api/two-factor/confirm/route.ts`).

export async function disableTwoFactorAction(input: unknown): Promise<Result<{ disabled: true }>> {
  return runAction(async () => {
    const user = await requireSessionUser();
    const proof = proofSchema.parse(input);
    const before = await getPrisma().user.findUnique({ where: { id: user.id }, select: { totpEnabledAt: true } });
    await disableTwoFactor(user.id, proof);
    if (before?.totpEnabledAt) {
      const ctx = await auditContextForUser(user.id);
      await recordAudit({ ...ctx, action: "two_factor.disabled", targetType: "user", targetId: user.id, summary: "Desativou a verificação em 2 etapas da própria conta." });
    }
    return { disabled: true as const };
  });
}

export async function regenerateRecoveryCodesAction(input: unknown): Promise<Result<{ recoveryCodes: string[] }>> {
  return runAction(async () => {
    const user = await requireSessionUser();
    const generated = await regenerateRecoveryCodes(user.id, proofSchema.parse(input));
    const ctx = await auditContextForUser(user.id);
    await recordAudit({ ...ctx, action: "two_factor.recovery_codes_regenerated", targetType: "user", targetId: user.id, summary: "Gerou novos códigos de recuperação da verificação em 2 etapas." });
    return generated;
  });
}

/** Admin da plataforma: zera a 2FA de outro usuário (perdeu o celular). Derruba as sessões dele. */
export async function adminResetTwoFactorAction(input: unknown): Promise<Result<{ reset: true }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const { userId } = idSchema.parse(input);
    const target = await getPrisma().user.findUnique({ where: { id: userId }, select: { email: true } });
    await adminResetTwoFactor(admin.id, userId);
    // Fica na empresa do usuário (quando ele tem uma só), para o dono ver que a equipe da plataforma mexeu.
    const targetContext = await auditContextForUser(userId);
    await recordAudit({
      tenantId: targetContext.tenantId,
      actor: platformAdminActor(admin.id),
      action: "two_factor.reset_by_admin",
      targetType: "user",
      targetId: userId,
      summary: `A equipe da plataforma zerou a verificação em 2 etapas de ${target?.email ?? "um usuário"}.`,
    });
    return { reset: true as const };
  });
}

export async function listCompanyTwoFactorAction(tenantId: string): Promise<Result<TwoFactorMemberRow[]>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return listCompanyTwoFactor(z.string().trim().min(1).max(64).parse(tenantId));
  });
}

export async function listOtherAdminsTwoFactorAction(): Promise<Result<TwoFactorMemberRow[]>> {
  return runAction(async () => listOtherAdminsTwoFactor((await requirePlatformAdmin()).id));
}
