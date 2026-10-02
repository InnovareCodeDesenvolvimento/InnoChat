"use server";

import { z } from "zod";
import { requirePlatformAdmin, requireSessionUser } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
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
    await disableTwoFactor(user.id, proofSchema.parse(input));
    return { disabled: true as const };
  });
}

export async function regenerateRecoveryCodesAction(input: unknown): Promise<Result<{ recoveryCodes: string[] }>> {
  return runAction(async () => {
    const user = await requireSessionUser();
    return regenerateRecoveryCodes(user.id, proofSchema.parse(input));
  });
}

/** Admin da plataforma: zera a 2FA de outro usuário (perdeu o celular). Derruba as sessões dele. */
export async function adminResetTwoFactorAction(input: unknown): Promise<Result<{ reset: true }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const { userId } = idSchema.parse(input);
    await adminResetTwoFactor(admin.id, userId);
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
