import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { signUpWithGoogle } from "@/modules/signup/service";
import { verifyGoogleToken } from "./tokens";

/**
 * Cadastro de empresa depois do Google (`/cadastro/google?t=...`).
 *
 * USO ÚNICO: o token é amarrado ao `sub` do Google. Depois do cadastro o `googleSub` existe em
 * `User`, então repetir o mesmo token (F5, reenvio, token vazado) cai em `ALREADY_REGISTERED` — a
 * tela manda entrar com o Google, e NÃO abre sessão a partir do token (senão um token vazado
 * viraria senha por 10 min). Sem tabela de `jti`: a unicidade de `googleSub`/`email` no banco é a
 * trava, inclusive contra duas requisições simultâneas.
 */

type SignupClaims = { email: string; name: string; sub: string };

async function assertNotRegistered(claims: SignupClaims): Promise<void> {
  const existing = await getPrisma().user.findFirst({
    where: { OR: [{ googleSub: claims.sub }, { email: claims.email }] },
    select: { id: true },
  });
  if (existing) {
    throw new DomainError("ALREADY_REGISTERED", "Já existe uma conta com este e-mail. Volte e entre com o Google.");
  }
}

function readClaims(token: string): SignupClaims {
  const claims = verifyGoogleToken<SignupClaims>("google-signup", token);
  if (!claims.email || !claims.sub) throw new DomainError("TOKEN_INVALID", "Link inválido. Entre com o Google de novo.");
  return { email: claims.email, name: claims.name ?? "", sub: claims.sub };
}

export async function getGoogleSignUpPrefill(token: string): Promise<{ email: string; name: string }> {
  const claims = readClaims(token);
  await assertNotRegistered(claims);
  return { email: claims.email, name: claims.name };
}

export async function completeGoogleSignUp(input: {
  token: string;
  tenantName: string;
  document: string;
  planCode?: string;
  termsVersion: string;
}): Promise<{ userId: string; tenantSlug: string }> {
  const claims = readClaims(input.token);
  await assertNotRegistered(claims);

  try {
    const result = await signUpWithGoogle({
      email: claims.email,
      googleSub: claims.sub,
      // O Google às vezes não manda nome; cai para a parte local do e-mail (o usuário edita em "Minha conta").
      ownerName: claims.name.trim().length >= 2 ? claims.name : claims.email.split("@")[0]!.slice(0, 80),
      companyName: input.tenantName,
      document: input.document,
      termsVersion: input.termsVersion,
      planCode: input.planCode,
    });
    logger.info("google_auth.signup.completed", { userId: result.userId });
    return { userId: result.userId, tenantSlug: result.tenantSlug };
  } catch (error) {
    // Corrida com outro cadastro do mesmo Google/e-mail: a unicidade do banco é a trava final.
    if (isUniqueViolation(error)) {
      throw new DomainError("ALREADY_REGISTERED", "Já existe uma conta com este e-mail. Volte e entre com o Google.");
    }
    throw error;
  }
}
