import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { signGoogleToken, verifyGoogleToken } from "@/modules/google-auth/tokens";
import { verifyCredentials, type AuthorizedUser } from "@/modules/auth/service";
import { consumeSecondFactor, enforceSecondFactorRateLimit } from "./service";

/**
 * Login por senha com segundo fator, sem brecha: a sessão do Auth.js só nasce depois do 2º fator.
 *
 * Três caminhos, todos passando por provedores Credentials do Auth.js em `src/lib/auth.ts`:
 *
 * 1. `startPasswordLogin` (chamado por `loginAction`) confere e-mail + senha (com o rate limit de
 *    sempre) e olha se a conta tem 2FA LIGADA:
 *    - sem 2FA: devolve uma prova de 60 s ("login-verified") que `loginAction` entrega ao provedor
 *      `verified-login`. A prova nasce e é consumida na mesma action; nunca vai para o navegador;
 *    - com 2FA: devolve um desafio assinado de 5 min ("two-factor-challenge") que vai para a tela
 *      do código. O desafio prova só "a senha estava certa"; não abre sessão sozinho.
 * 2. `completeTwoFactorLogin` (provedor `two-factor`) troca desafio + código por usuário. Desafio de
 *    uso único (`usedChallenges`), com no máximo `MAX_FAILS_PER_CHALLENGE` erros e preso à
 *    `sessionVersion` do momento (trocar a senha invalida desafios abertos).
 * 3. O provedor `credentials` (rota pública `/api/auth/callback/credentials`, que qualquer um pode
 *    chamar direto) RECUSA contas com 2FA ligada via `rejectIfTwoFactorEnabled`: sem isso daria para
 *    pular o 2º fator indo direto na rota.
 *
 * O estado dos desafios fica em memória (um único processo, mesma premissa de `rate-limit.ts`).
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const PROOF_TTL_MS = 60 * 1000;
const MAX_FAILS_PER_CHALLENGE = 5;
const IP_LIMIT = 30;
const IP_WINDOW_MS = 5 * 60 * 1000;

type ChallengeState = { fails: number; expiresAtMs: number; done: boolean; inFlight: boolean };
const challenges = new Map<string, ChallengeState>();

function sweepChallenges(nowMs: number) {
  if (challenges.size < 500) return;
  for (const [jti, s] of challenges) if (s.expiresAtMs <= nowMs) challenges.delete(jti);
}

export type PasswordLoginOutcome = { kind: "session"; proof: string } | { kind: "challenge"; challenge: string };

export async function startPasswordLogin(input: { email: string; password: string; ip: string }, nowMs = Date.now()): Promise<PasswordLoginOutcome | null> {
  const user = await verifyCredentials(input);
  if (!user) return null;
  const row = await getPrisma().user.findUnique({ where: { id: user.id }, select: { totpEnabledAt: true, sessionVersion: true } });
  if (!row) return null;
  if (row.totpEnabledAt) {
    return { kind: "challenge", challenge: signGoogleToken("two-factor-challenge", { userId: user.id, sv: row.sessionVersion }, CHALLENGE_TTL_MS, nowMs) };
  }
  return { kind: "session", proof: signGoogleToken("login-verified", { userId: user.id }, PROOF_TTL_MS, nowMs) };
}

/** Provedor `verified-login`: troca a prova de senha (conta SEM 2FA) por usuário. */
export async function loadVerifiedLoginUser(proof: string): Promise<AuthorizedUser | null> {
  let userId: string;
  try {
    userId = verifyGoogleToken<{ userId: string }>("login-verified", proof).userId;
  } catch {
    return null;
  }
  const user = await getPrisma().user.findUnique({ where: { id: userId } });
  // Se a 2FA foi ligada entre a senha e aqui, não entra sem o código.
  if (!user || user.totpEnabledAt) return null;
  return { id: user.id, email: user.email, name: user.name ?? null };
}

/** Provedor `credentials` direto: conta com 2FA ligada nunca abre sessão só com a senha. */
export async function rejectIfTwoFactorEnabled(userId: string): Promise<boolean> {
  const row = await getPrisma().user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } });
  return row?.totpEnabledAt != null;
}

/**
 * Provedor `two-factor`. Lança `DomainError`: `TWO_FACTOR_CHALLENGE_INVALID` (vencido, usado, forjado
 * ou esgotado: voltar para a senha), `TWO_FACTOR_CODE_INVALID` (errou o código) ou
 * `TWO_FACTOR_RATE_LIMITED`.
 */
export async function completeTwoFactorLogin(input: { challenge: string; code: string; ip: string }, nowMs = Date.now()): Promise<AuthorizedUser> {
  const invalid = () => new DomainError("TWO_FACTOR_CHALLENGE_INVALID", "A verificação expirou. Entre com a senha de novo.");

  let claims: { userId: string; sv: number; jti: string; exp: number };
  try {
    claims = verifyGoogleToken<{ userId: string; sv: number }>("two-factor-challenge", input.challenge, nowMs);
  } catch {
    throw invalid();
  }

  const ipLimit = checkRateLimit(`2fa:ip:${input.ip}`, IP_LIMIT, IP_WINDOW_MS);
  if (!ipLimit.allowed) {
    logger.info("two_factor.login.rate_limited", { reason: "ip" });
    throw new DomainError("TWO_FACTOR_RATE_LIMITED", "Muitas tentativas. Espere alguns minutos e tente de novo.");
  }

  sweepChallenges(nowMs);
  let state = challenges.get(claims.jti);
  if (!state) {
    state = { fails: 0, expiresAtMs: claims.exp * 1000, done: false, inFlight: false };
    challenges.set(claims.jti, state);
  }
  if (state.done || state.inFlight || state.fails >= MAX_FAILS_PER_CHALLENGE) throw invalid();

  enforceSecondFactorRateLimit(claims.userId);

  const user = await getPrisma().user.findUnique({ where: { id: claims.userId } });
  if (!user || !user.totpEnabledAt || user.sessionVersion !== claims.sv) throw invalid();

  // `inFlight` fecha a janela entre conferir e consumir: duas requisições com o mesmo desafio não
  // passam juntas (o consumo do código em si também é atômico no banco).
  state.inFlight = true;
  try {
    const kind = await consumeSecondFactor(user.id, input.code, nowMs);
    if (kind === null) {
      state.fails += 1;
      logger.info("two_factor.login.failed", { userId: user.id });
      throw new DomainError("TWO_FACTOR_CODE_INVALID", "Código errado, vencido ou já usado.");
    }
    state.done = true;
    logger.info("two_factor.login.ok", { userId: user.id, method: kind });
  } finally {
    state.inFlight = false;
  }
  return { id: user.id, email: user.email, name: user.name ?? null };
}

/** Só para testes. */
export function __resetTwoFactorLoginStateForTests() {
  challenges.clear();
}
