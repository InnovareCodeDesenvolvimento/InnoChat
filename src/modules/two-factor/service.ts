import bcrypt from "bcryptjs";
import QRCode from "qrcode";
import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { forgetSessionVersion } from "@/modules/auth/session-version";
import { loadEmailContext, sendMail, twoFactorChangedEmail, type TwoFactorChange } from "@/lib/email";
import { buildOtpauthUri, formatSecretForHumans, generateTotpSecret, matchTotpStep, normalizeTotpInput } from "./totp";
import { generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryInput, RECOVERY_CODE_COUNT } from "./recovery";

/**
 * Verificação em 2 etapas (TOTP). Estados do `User`:
 * - sem `totpSecretEnc`: desligada;
 * - `totpSecretEnc` e sem `totpEnabledAt`: cadastro iniciado (QR mostrado), NÃO vale no login;
 * - `totpEnabledAt`: ligada.
 * Regra efetiva de obrigatoriedade: `isPlatformAdmin || twoFactorRequired`.
 *
 * Nunca logar segredo, código digitado nem código de recuperação.
 */

export const TWO_FACTOR_ISSUER = "InnoChat";

const VERIFY_USER_LIMIT = 10;
const VERIFY_USER_WINDOW_MS = 15 * 60 * 1000;

/**
 * Avisa o dono da conta por e-mail quando a verificação em 2 etapas muda (ligou, desligou, admin redefiniu). Quem não
 * fez a mudança precisa saber na hora. Fire-and-forget: SMTP fora do ar ou lento nunca atrasa nem derruba a ação, e o
 * e-mail não leva segredo nenhum (só o fato e a data).
 */
export function notifyTwoFactorChange(userId: string, change: TwoFactorChange, at: Date = new Date()): Promise<void> {
  const task = (async () => {
    try {
      const user = await getPrisma().user.findUnique({ where: { id: userId }, select: { email: true } });
      if (!user) return;
      const whenBr = at.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });
      const mail = twoFactorChangedEmail({ change, whenBr, ctx: await loadEmailContext().catch(() => undefined) });
      await sendMail({ to: user.email, subject: mail.subject, html: mail.html, text: mail.text });
    } catch (error) {
      // `warn`, nunca `error`: não vira alerta do monitor por causa de um aviso que não saiu.
      logger.warn("two_factor.notice_failed", { change, errorName: error instanceof Error ? error.name : "unknown" });
    }
  })();
  return task;
}

export type TwoFactorStatus = {
  /** Ligada e valendo no login. */
  enabled: boolean;
  /** Obrigatória para este usuário (admin da plataforma ou exigência individual). */
  required: boolean;
  recoveryCodesLeft: number;
  /** Tem senha própria (conta só do Google não tem): decide se "desativar" aceita senha. */
  hasPassword: boolean;
};

export type TwoFactorSetupStart = { secret: string; secretFormatted: string; otpauthUri: string; qrDataUrl: string };

export function isTwoFactorRequired(user: { isPlatformAdmin: boolean; twoFactorRequired: boolean }): boolean {
  return user.isPlatformAdmin || user.twoFactorRequired;
}

/** Teto de tentativas de código por usuário (login, ativar, desativar, regenerar). Mesmo erro para todos. */
export function enforceSecondFactorRateLimit(userId: string): void {
  const limit = checkRateLimit(`2fa:user:${userId}`, VERIFY_USER_LIMIT, VERIFY_USER_WINDOW_MS);
  if (!limit.allowed) {
    logger.info("two_factor.rate_limited", { userId });
    throw new DomainError("TWO_FACTOR_RATE_LIMITED", "Muitas tentativas. Espere alguns minutos e tente de novo.");
  }
}

export async function getTwoFactorStatus(userId: string): Promise<TwoFactorStatus> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpEnabledAt: true, isPlatformAdmin: true, twoFactorRequired: true, passwordHash: true },
  });
  if (!user) throw new DomainError("NOT_FOUND", "Usuário não encontrado.");
  const enabled = user.totpEnabledAt !== null;
  const recoveryCodesLeft = enabled ? await prisma.twoFactorRecoveryCode.count({ where: { userId, usedAt: null } }) : 0;
  return { enabled, required: isTwoFactorRequired(user), recoveryCodesLeft, hasPassword: user.passwordHash !== null };
}

/** Começa (ou recomeça) o cadastro: segredo novo, ainda pendente. Recusa se já está ligada. */
export async function beginTwoFactorSetup(userId: string): Promise<TwoFactorSetupStart> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, totpEnabledAt: true } });
  if (!user) throw new DomainError("NOT_FOUND", "Usuário não encontrado.");
  if (user.totpEnabledAt) throw new DomainError("TWO_FACTOR_ALREADY_ENABLED", "A verificação em 2 etapas já está ativa.");

  const secret = generateTotpSecret();
  // `totpEnabledAt: null` no where: nunca sobrescreve o segredo de uma 2FA que ligou no meio.
  const { count } = await prisma.user.updateMany({
    where: { id: userId, totpEnabledAt: null },
    data: { totpSecretEnc: encryptSecret(secret), totpLastUsedStep: null },
  });
  if (count !== 1) throw new DomainError("TWO_FACTOR_ALREADY_ENABLED", "A verificação em 2 etapas já está ativa.");

  const otpauthUri = buildOtpauthUri({ issuer: TWO_FACTOR_ISSUER, account: user.email, secretBase32: secret });
  const qrDataUrl = await QRCode.toDataURL(otpauthUri, { margin: 1, width: 224, errorCorrectionLevel: "M" });
  logger.info("two_factor.setup_started", { userId });
  return { secret, secretFormatted: formatSecretForHumans(secret), otpauthUri, qrDataUrl };
}

function recoveryRows(userId: string, codes: string[]) {
  return codes.map((c) => ({ userId, codeHash: hashRecoveryCode(normalizeRecoveryInput(c)!) }));
}

/**
 * Confirma o cadastro com o primeiro código, liga a 2FA e gera os códigos de recuperação (devolvidos
 * UMA vez, em claro; no banco só o hash). Tudo numa transação.
 */
export async function confirmTwoFactorSetup(userId: string, code: string, nowMs = Date.now()): Promise<{ recoveryCodes: string[] }> {
  enforceSecondFactorRateLimit(userId);
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { totpSecretEnc: true, totpEnabledAt: true } });
  if (!user) throw new DomainError("NOT_FOUND", "Usuário não encontrado.");
  if (user.totpEnabledAt) throw new DomainError("TWO_FACTOR_ALREADY_ENABLED", "A verificação em 2 etapas já está ativa.");
  if (!user.totpSecretEnc) throw new DomainError("TWO_FACTOR_SETUP_NOT_STARTED", "Comece pela leitura do QR code.");

  const secret = decryptSecret(user.totpSecretEnc);
  if (!secret) {
    logger.error("two_factor.secret_undecryptable", { userId });
    throw new DomainError("TWO_FACTOR_SETUP_NOT_STARTED", "Não deu para ler o cadastro pendente. Comece de novo.");
  }
  const step = matchTotpStep(secret, code, null, nowMs);
  if (step === null) throw new DomainError("TWO_FACTOR_CODE_INVALID", "Código errado ou vencido. Confira o número no app e tente de novo.");

  const recoveryCodes = generateRecoveryCodes();
  await prisma.$transaction(async (tx) => {
    // Condicional: duas confirmações simultâneas não ligam (nem geram códigos) duas vezes.
    const { count } = await tx.user.updateMany({
      where: { id: userId, totpEnabledAt: null, totpSecretEnc: user.totpSecretEnc },
      // `sessionVersion` + 1: derruba as OUTRAS sessões (uma sessão roubada antes da 2FA não sobrevive a ela). Quem
      // ativou segue logado: a Server Action renova o `sv` do JWT dela (`src/modules/auth/session-refresh.ts`).
      data: { totpEnabledAt: new Date(nowMs), totpLastUsedStep: step, sessionVersion: { increment: 1 } },
    });
    if (count !== 1) throw new DomainError("TWO_FACTOR_ALREADY_ENABLED", "A verificação em 2 etapas já está ativa.");
    await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
    await tx.twoFactorRecoveryCode.createMany({ data: recoveryRows(userId, recoveryCodes) });
  });
  forgetSessionVersion(userId);
  logger.info("two_factor.enabled", { userId });
  void notifyTwoFactorChange(userId, "ENABLED");
  return { recoveryCodes };
}

export type SecondFactorKind = "totp" | "recovery";

/**
 * Consome UM segundo fator (código do app OU código de recuperação) de uma conta com 2FA ligada.
 * Atômico: o TOTP só vale se o passo for maior que `totpLastUsedStep` (UPDATE condicional, anti-replay
 * mesmo com requisições simultâneas); o código de recuperação só vale se `usedAt` ainda é nulo.
 * Devolve o tipo usado ou `null` (errado/já usado). Não aplica rate limit: quem chama aplica.
 */
export async function consumeSecondFactor(userId: string, input: string, nowMs = Date.now()): Promise<SecondFactorKind | null> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { totpSecretEnc: true, totpEnabledAt: true, totpLastUsedStep: true },
  });
  if (!user?.totpSecretEnc || !user.totpEnabledAt) return null;

  if (normalizeTotpInput(input) !== null) {
    const secret = decryptSecret(user.totpSecretEnc);
    if (!secret) {
      logger.error("two_factor.secret_undecryptable", { userId });
      return null;
    }
    const step = matchTotpStep(secret, input, user.totpLastUsedStep, nowMs);
    if (step === null) return null;
    const { count } = await prisma.user.updateMany({
      where: { id: userId, totpEnabledAt: { not: null }, OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }] },
      data: { totpLastUsedStep: step },
    });
    return count === 1 ? "totp" : null;
  }

  const normalized = normalizeRecoveryInput(input);
  if (!normalized) return null;
  const { count } = await prisma.twoFactorRecoveryCode.updateMany({
    where: { userId, codeHash: hashRecoveryCode(normalized), usedAt: null },
    data: { usedAt: new Date(nowMs) },
  });
  if (count === 1) logger.info("two_factor.recovery_code_used", { userId });
  return count === 1 ? "recovery" : null;
}

/** Prova de que quem pede é o dono da conta: senha atual OU um código. Lança se não bater. */
async function requireProof(userId: string, proof: { password?: string; code?: string }): Promise<void> {
  enforceSecondFactorRateLimit(userId);
  const password = proof.password ?? "";
  const code = proof.code ?? "";
  if (password) {
    const user = await getPrisma().user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (user?.passwordHash && (await bcrypt.compare(password, user.passwordHash))) return;
    throw new DomainError("TWO_FACTOR_PROOF_INVALID", "Senha incorreta.");
  }
  if (code) {
    if ((await consumeSecondFactor(userId, code)) !== null) return;
    throw new DomainError("TWO_FACTOR_CODE_INVALID", "Código errado, vencido ou já usado.");
  }
  throw new DomainError("TWO_FACTOR_PROOF_INVALID", "Informe sua senha ou um código para continuar.");
}

/** Desliga a 2FA (some segredo e códigos). Obrigatória para o usuário: recusa. Exige senha ou código. */
export async function disableTwoFactor(userId: string, proof: { password?: string; code?: string }): Promise<void> {
  const user = await getPrisma().user.findUnique({
    where: { id: userId },
    select: { totpEnabledAt: true, isPlatformAdmin: true, twoFactorRequired: true },
  });
  if (!user) throw new DomainError("NOT_FOUND", "Usuário não encontrado.");
  if (isTwoFactorRequired(user)) {
    throw new DomainError("TWO_FACTOR_REQUIRED", "Nesta conta a verificação em 2 etapas é obrigatória e não pode ser desativada.");
  }
  if (!user.totpEnabledAt) return;
  await requireProof(userId, proof);
  await clearTwoFactor(userId);
  logger.info("two_factor.disabled", { userId });
  void notifyTwoFactorChange(userId, "DISABLED");
}

/** Gera 10 códigos novos (os antigos deixam de valer). Exige senha ou código. */
export async function regenerateRecoveryCodes(userId: string, proof: { password?: string; code?: string }): Promise<{ recoveryCodes: string[] }> {
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } });
  if (!user?.totpEnabledAt) throw new DomainError("TWO_FACTOR_NOT_ENABLED", "Ative a verificação em 2 etapas primeiro.");
  await requireProof(userId, proof);
  const recoveryCodes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
  await prisma.$transaction([
    prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
    prisma.twoFactorRecoveryCode.createMany({ data: recoveryRows(userId, recoveryCodes) }),
  ]);
  logger.info("two_factor.recovery_codes_regenerated", { userId });
  return { recoveryCodes };
}

async function clearTwoFactor(userId: string, options: { bumpSession?: boolean } = {}): Promise<void> {
  const prisma = getPrisma();
  await prisma.$transaction([
    prisma.twoFactorRecoveryCode.deleteMany({ where: { userId } }),
    prisma.user.update({
      where: { id: userId },
      data: {
        totpSecretEnc: null,
        totpEnabledAt: null,
        totpLastUsedStep: null,
        ...(options.bumpSession ? { sessionVersion: { increment: 1 } } : {}),
      },
    }),
  ]);
  if (options.bumpSession) forgetSessionVersion(userId);
}

/**
 * Reset feito por um admin da plataforma (a pessoa perdeu o celular e os códigos). Zera a 2FA e
 * derruba as sessões abertas dela (`sessionVersion`). Não vale para o próprio admin: ele usa a tela
 * Minha conta.
 */
export async function adminResetTwoFactor(adminId: string, targetUserId: string): Promise<void> {
  if (adminId === targetUserId) {
    throw new DomainError("TWO_FACTOR_RESET_SELF", "Para a sua própria conta, use a tela Minha conta.");
  }
  const target = await getPrisma().user.findUnique({ where: { id: targetUserId }, select: { id: true } });
  if (!target) throw new DomainError("NOT_FOUND", "Usuário não encontrado.");
  await clearTwoFactor(targetUserId, { bumpSession: true });
  logger.info("two_factor.reset_by_admin", { adminId, targetUserId });
  void notifyTwoFactorChange(targetUserId, "RESET_BY_ADMIN");
}

export type TwoFactorMemberRow = { userId: string; email: string; name: string | null; roleLabel: string; enabled: boolean };

const ROLE_LABEL: Record<string, string> = { OWNER: "Dono", STAFF: "Equipe" };

/** Quem é da empresa e se a 2FA está ligada (para o admin resetar). Limitado: nunca devolve "todos". */
export async function listCompanyTwoFactor(tenantId: string): Promise<TwoFactorMemberRow[]> {
  const memberships = await getPrisma().membership.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { role: true, user: { select: { id: true, email: true, name: true, totpEnabledAt: true } } },
  });
  return memberships.map((m) => ({
    userId: m.user.id,
    email: m.user.email,
    name: m.user.name,
    roleLabel: ROLE_LABEL[m.role] ?? m.role,
    enabled: m.user.totpEnabledAt !== null,
  }));
}

/** Os OUTROS administradores da plataforma (o próprio admin usa a tela Minha conta). */
export async function listOtherAdminsTwoFactor(adminId: string): Promise<TwoFactorMemberRow[]> {
  const admins = await getPrisma().user.findMany({
    where: { isPlatformAdmin: true, id: { not: adminId } },
    orderBy: { createdAt: "asc" },
    take: 50,
    select: { id: true, email: true, name: true, totpEnabledAt: true },
  });
  return admins.map((u) => ({ userId: u.id, email: u.email, name: u.name, roleLabel: "Admin da plataforma", enabled: u.totpEnabledAt !== null }));
}
