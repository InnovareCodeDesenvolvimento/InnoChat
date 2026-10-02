/**
 * Verificação em 2 etapas (TOTP) contra Postgres real: ativação com código, códigos de recuperação
 * de uso único (inclusive em disputa), login em 2 passos sem brecha (desafio assinado, uso único,
 * teto de erros), conta com 2FA recusada no caminho só-senha, desativar/regenerar com prova,
 * obrigatoriedade do admin e reset feito por outro admin.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/crypto";
import { __resetRateLimitsForTests } from "@/lib/rate-limit";
import { hashPassword } from "@/modules/auth/service";
import { totpCode, totpStepAt } from "@/modules/two-factor/totp";
import {
  adminResetTwoFactor,
  beginTwoFactorSetup,
  confirmTwoFactorSetup,
  consumeSecondFactor,
  disableTwoFactor,
  getTwoFactorStatus,
  regenerateRecoveryCodes,
} from "@/modules/two-factor/service";
import {
  __resetTwoFactorLoginStateForTests,
  completeTwoFactorLogin,
  loadVerifiedLoginUser,
  rejectIfTwoFactorEnabled,
  startPasswordLogin,
} from "@/modules/two-factor/login";
import { signGoogleToken } from "@/modules/google-auth/tokens";

const prisma = getPrisma();
const run = randomUUID().slice(0, 8);
const PASSWORD = "senha-longa-de-teste-123";
const createdUserIds: string[] = [];
const IP = "203.0.113.7";

async function newUser(label: string, extra: { isPlatformAdmin?: boolean; passwordHash?: string | null } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `it-2fa-${label}-${run}@example.com`,
      passwordHash: extra.passwordHash === undefined ? await hashPassword(PASSWORD) : extra.passwordHash,
      isPlatformAdmin: extra.isPlatformAdmin ?? false,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

/** Liga a 2FA do jeito de produção e devolve o segredo em claro (para gerar códigos) e os códigos de recuperação. */
async function enableTwoFactor(userId: string, nowMs = Date.now()) {
  const start = await beginTwoFactorSetup(userId);
  const { recoveryCodes } = await confirmTwoFactorSetup(userId, totpCode(start.secret, nowMs), nowMs);
  return { secret: start.secret, recoveryCodes };
}

beforeAll(() => {
  process.env.AUTH_SECRET ??= "test-secret-not-used-in-integration-tests";
});

beforeEach(() => {
  __resetRateLimitsForTests();
  __resetTwoFactorLoginStateForTests();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe("ativação", () => {
  it("segredo fica cifrado e pendente até confirmar; confirmar liga e gera 10 códigos só com hash", async () => {
    const user = await newUser("ativar");
    const start = await beginTwoFactorSetup(user.id);
    expect(start.qrDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(start.otpauthUri).toContain("otpauth://totp/InnoChat:");

    const pending = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(pending.totpSecretEnc).not.toBeNull();
    expect(pending.totpSecretEnc).not.toContain(start.secret);
    expect(decryptSecret(pending.totpSecretEnc!)).toBe(start.secret);
    expect(pending.totpEnabledAt).toBeNull();
    // Pendente NÃO vale no login.
    expect(await rejectIfTwoFactorEnabled(user.id)).toBe(false);
    expect(await consumeSecondFactor(user.id, totpCode(start.secret))).toBeNull();

    const { recoveryCodes } = await confirmTwoFactorSetup(user.id, totpCode(start.secret));
    expect(recoveryCodes).toHaveLength(10);
    const rows = await prisma.twoFactorRecoveryCode.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(10);
    for (const c of recoveryCodes) expect(rows.some((r) => r.codeHash === c || r.codeHash.includes(c))).toBe(false);
    expect(await getTwoFactorStatus(user.id)).toMatchObject({ enabled: true, required: false, recoveryCodesLeft: 10, hasPassword: true });
  });

  it("código errado não liga; ligada não começa de novo; o código de confirmação não serve de novo no login", async () => {
    const user = await newUser("errado");
    const start = await beginTwoFactorSetup(user.id);
    const wrong = totpCode(start.secret, Date.now() + 5 * 60_000); // passo longe da janela
    await expect(confirmTwoFactorSetup(user.id, wrong)).rejects.toMatchObject({ code: "TWO_FACTOR_CODE_INVALID" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpEnabledAt).toBeNull();

    const nowMs = Date.now();
    await confirmTwoFactorSetup(user.id, totpCode(start.secret, nowMs), nowMs);
    await expect(beginTwoFactorSetup(user.id)).rejects.toMatchObject({ code: "TWO_FACTOR_ALREADY_ENABLED" });
    // Anti-replay: o código usado para ativar já foi consumido.
    expect(await consumeSecondFactor(user.id, totpCode(start.secret, nowMs), nowMs)).toBeNull();
  });

  it("duas confirmações simultâneas ligam uma vez só", async () => {
    const user = await newUser("corrida-ativar");
    const start = await beginTwoFactorSetup(user.id);
    const code = totpCode(start.secret);
    const results = await Promise.allSettled([confirmTwoFactorSetup(user.id, code), confirmTwoFactorSetup(user.id, code)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.twoFactorRecoveryCode.count({ where: { userId: user.id } })).toBe(10);
  });
});

describe("segundo fator: anti-replay e códigos de recuperação", () => {
  it("o mesmo código do app não entra duas vezes, nem em disputa", async () => {
    const user = await newUser("replay");
    const nowMs = Date.now();
    const { secret } = await enableTwoFactor(user.id, nowMs - 60_000);
    const code = totpCode(secret, nowMs);
    const [a, b] = await Promise.all([consumeSecondFactor(user.id, code, nowMs), consumeSecondFactor(user.id, code, nowMs)]);
    expect([a, b].filter((r) => r === "totp")).toHaveLength(1);
    expect(await consumeSecondFactor(user.id, code, nowMs)).toBeNull();
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).totpLastUsedStep).toBe(totpStepAt(nowMs));
  });

  it("código de recuperação vale uma vez, mesmo com duas requisições juntas", async () => {
    const user = await newUser("recovery");
    const { recoveryCodes } = await enableTwoFactor(user.id);
    const code = recoveryCodes[0]!;
    const [a, b] = await Promise.all([consumeSecondFactor(user.id, code), consumeSecondFactor(user.id, code.toUpperCase())]);
    expect([a, b].filter((r) => r === "recovery")).toHaveLength(1);
    expect(await consumeSecondFactor(user.id, code)).toBeNull();
    expect((await getTwoFactorStatus(user.id)).recoveryCodesLeft).toBe(9);
  });
});

describe("login em 2 passos", () => {
  it("sem 2FA: senha certa devolve a prova de sessão; senha errada, nada", async () => {
    const user = await newUser("login-simples");
    expect(await startPasswordLogin({ email: user.email, password: "errada", ip: IP })).toBeNull();
    const outcome = await startPasswordLogin({ email: user.email, password: PASSWORD, ip: IP });
    expect(outcome?.kind).toBe("session");
    if (outcome?.kind !== "session") return;
    expect(await loadVerifiedLoginUser(outcome.proof)).toMatchObject({ id: user.id });
    // A prova não serve como desafio nem o contrário (finalidades separadas).
    await expect(completeTwoFactorLogin({ challenge: outcome.proof, code: "123456", ip: IP })).rejects.toMatchObject({ code: "TWO_FACTOR_CHALLENGE_INVALID" });
  });

  it("com 2FA: senha certa só dá desafio; a prova de sessão é recusada; só o código abre", async () => {
    const user = await newUser("login-2fa");
    const nowMs = Date.now();
    const { secret } = await enableTwoFactor(user.id, nowMs - 60_000);

    expect(await rejectIfTwoFactorEnabled(user.id)).toBe(true); // rota pública de senha pura recusa
    const outcome = await startPasswordLogin({ email: user.email, password: PASSWORD, ip: IP });
    expect(outcome?.kind).toBe("challenge");
    if (outcome?.kind !== "challenge") return;

    // Prova forjada para conta COM 2FA: o provedor `verified-login` recusa.
    const forged = signGoogleToken("login-verified", { userId: user.id }, 60_000);
    expect(await loadVerifiedLoginUser(forged)).toBeNull();

    const logged = await completeTwoFactorLogin({ challenge: outcome.challenge, code: totpCode(secret, nowMs), ip: IP }, nowMs);
    expect(logged).toMatchObject({ id: user.id, email: user.email });
  });

  it("desafio é de uso único: depois de entrar, reusar com outro código válido é recusado", async () => {
    const user = await newUser("login-uso-unico");
    const { secret, recoveryCodes } = await enableTwoFactor(user.id, Date.now() - 60_000);
    const outcome = await startPasswordLogin({ email: user.email, password: PASSWORD, ip: IP });
    if (outcome?.kind !== "challenge") throw new Error("esperava desafio");
    await completeTwoFactorLogin({ challenge: outcome.challenge, code: totpCode(secret), ip: IP });
    await expect(completeTwoFactorLogin({ challenge: outcome.challenge, code: recoveryCodes[0]!, ip: IP })).rejects.toMatchObject({
      code: "TWO_FACTOR_CHALLENGE_INVALID",
    });
  });

  it("5 erros esgotam o desafio, mesmo que o 6º código esteja certo", async () => {
    const user = await newUser("login-forca-bruta");
    const { secret } = await enableTwoFactor(user.id, Date.now() - 60_000);
    const outcome = await startPasswordLogin({ email: user.email, password: PASSWORD, ip: IP });
    if (outcome?.kind !== "challenge") throw new Error("esperava desafio");
    for (let i = 0; i < 5; i++) {
      await expect(completeTwoFactorLogin({ challenge: outcome.challenge, code: "000000", ip: IP })).rejects.toMatchObject({ code: "TWO_FACTOR_CODE_INVALID" });
    }
    await expect(completeTwoFactorLogin({ challenge: outcome.challenge, code: totpCode(secret), ip: IP })).rejects.toMatchObject({
      code: "TWO_FACTOR_CHALLENGE_INVALID",
    });
  });

  it("teto por usuário vale mesmo com desafios novos a cada tentativa", async () => {
    const user = await newUser("login-teto-usuario");
    await enableTwoFactor(user.id, Date.now() - 60_000);
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      __resetTwoFactorLoginStateForTests(); // desafios novos: só o limite por usuário segura
      // Desafio assinado direto: o teto de senha por e-mail (8/15 min) cortaria o laço antes.
      const challenge = signGoogleToken("two-factor-challenge", { userId: user.id, sv: 0 }, 60_000);
      try {
        await completeTwoFactorLogin({ challenge, code: "000000", ip: `198.51.100.${i + 1}` });
      } catch (error) {
        limited = (error as { code?: string }).code === "TWO_FACTOR_RATE_LIMITED";
      }
    }
    expect(limited).toBe(true);
  });

  it("desafio vencido, adulterado ou de senha trocada é recusado", async () => {
    const user = await newUser("login-invalido");
    const { secret } = await enableTwoFactor(user.id, Date.now() - 60_000);
    const outcome = await startPasswordLogin({ email: user.email, password: PASSWORD, ip: IP });
    if (outcome?.kind !== "challenge") throw new Error("esperava desafio");

    await expect(completeTwoFactorLogin({ challenge: outcome.challenge + "x", code: totpCode(secret), ip: IP })).rejects.toMatchObject({
      code: "TWO_FACTOR_CHALLENGE_INVALID",
    });
    await expect(
      completeTwoFactorLogin({ challenge: outcome.challenge, code: totpCode(secret), ip: IP }, Date.now() + 6 * 60_000),
    ).rejects.toMatchObject({ code: "TWO_FACTOR_CHALLENGE_INVALID" });

    await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 1 } } });
    await expect(completeTwoFactorLogin({ challenge: outcome.challenge, code: totpCode(secret), ip: IP })).rejects.toMatchObject({
      code: "TWO_FACTOR_CHALLENGE_INVALID",
    });
  });
});

describe("desativar, regenerar, obrigatoriedade e reset", () => {
  it("desativar exige prova (senha ou código); depois limpa tudo", async () => {
    const user = await newUser("desativar");
    const { secret } = await enableTwoFactor(user.id, Date.now() - 60_000);
    await expect(disableTwoFactor(user.id, {})).rejects.toMatchObject({ code: "TWO_FACTOR_PROOF_INVALID" });
    await expect(disableTwoFactor(user.id, { password: "errada" })).rejects.toMatchObject({ code: "TWO_FACTOR_PROOF_INVALID" });
    expect((await getTwoFactorStatus(user.id)).enabled).toBe(true);

    await disableTwoFactor(user.id, { code: totpCode(secret) });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after).toMatchObject({ totpSecretEnc: null, totpEnabledAt: null, totpLastUsedStep: null });
    expect(await prisma.twoFactorRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
  });

  it("desativar com a senha também vale; conta sem senha só aceita código", async () => {
    const user = await newUser("desativar-senha");
    await enableTwoFactor(user.id);
    await disableTwoFactor(user.id, { password: PASSWORD });
    expect((await getTwoFactorStatus(user.id)).enabled).toBe(false);

    const google = await newUser("somente-google", { passwordHash: null });
    const { secret } = await enableTwoFactor(google.id, Date.now() - 60_000);
    expect((await getTwoFactorStatus(google.id)).hasPassword).toBe(false);
    await expect(disableTwoFactor(google.id, { password: PASSWORD })).rejects.toMatchObject({ code: "TWO_FACTOR_PROOF_INVALID" });
    await disableTwoFactor(google.id, { code: totpCode(secret) });
    expect((await getTwoFactorStatus(google.id)).enabled).toBe(false);
  });

  it("regenerar troca os 10 códigos (os antigos deixam de valer) e exige prova", async () => {
    const user = await newUser("regenerar");
    const { recoveryCodes: old } = await enableTwoFactor(user.id);
    await expect(regenerateRecoveryCodes(user.id, { password: "errada" })).rejects.toMatchObject({ code: "TWO_FACTOR_PROOF_INVALID" });
    const { recoveryCodes } = await regenerateRecoveryCodes(user.id, { password: PASSWORD });
    expect(recoveryCodes).toHaveLength(10);
    expect(await prisma.twoFactorRecoveryCode.count({ where: { userId: user.id } })).toBe(10);
    expect(await consumeSecondFactor(user.id, old[0]!)).toBeNull();
    expect(await consumeSecondFactor(user.id, recoveryCodes[0]!)).toBe("recovery");
  });

  it("admin da plataforma e usuário com exigência individual não desativam", async () => {
    const admin = await newUser("admin-obrigatoria", { isPlatformAdmin: true });
    await enableTwoFactor(admin.id);
    expect((await getTwoFactorStatus(admin.id)).required).toBe(true);
    await expect(disableTwoFactor(admin.id, { password: PASSWORD })).rejects.toMatchObject({ code: "TWO_FACTOR_REQUIRED" });

    const owner = await newUser("exigido");
    await prisma.user.update({ where: { id: owner.id }, data: { twoFactorRequired: true } });
    await enableTwoFactor(owner.id);
    await expect(disableTwoFactor(owner.id, { password: PASSWORD })).rejects.toMatchObject({ code: "TWO_FACTOR_REQUIRED" });
  });

  it("reset pelo admin zera a 2FA e derruba as sessões; não vale para si mesmo", async () => {
    const admin = await newUser("admin-reset", { isPlatformAdmin: true });
    const target = await newUser("alvo-reset");
    await enableTwoFactor(target.id);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });

    await expect(adminResetTwoFactor(admin.id, admin.id)).rejects.toMatchObject({ code: "TWO_FACTOR_RESET_SELF" });
    await adminResetTwoFactor(admin.id, target.id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(after).toMatchObject({ totpSecretEnc: null, totpEnabledAt: null, totpLastUsedStep: null });
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    expect(await prisma.twoFactorRecoveryCode.count({ where: { userId: target.id } })).toBe(0);
    // Sem 2FA, o login volta a ser só senha.
    expect((await startPasswordLogin({ email: target.email, password: PASSWORD, ip: IP }))?.kind).toBe("session");
  });
});
