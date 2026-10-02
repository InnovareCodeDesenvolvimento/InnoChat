import NextAuth, { CredentialsSignin } from "next-auth";
import type { NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { cookies } from "next/headers";
import { verifyCredentials } from "@/modules/auth/service";
import { completeTwoFactorLogin, loadVerifiedLoginUser, rejectIfTwoFactorEnabled } from "@/modules/two-factor/login";
import { getGoogleRuntimeCredentials } from "@/modules/google-auth/config";
import { GOOGLE_INVITE_COOKIE } from "@/modules/google-auth/invite-cookie";
import { resolveGoogleSignIn } from "@/modules/google-auth/signin";
import { loadGoogleLoginUser, userIdForGoogleSub } from "@/modules/google-auth/session";
import { verifyGoogleToken } from "@/modules/google-auth/tokens";
import { setGoogleSignupCookie } from "@/modules/google-auth/signup-cookie";
import { isDomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";
import { getTrustedPublicBaseUrlCached } from "@/lib/public-url";
import { forgetSessionVersion, isSessionVersionCurrent, readSessionVersion } from "@/modules/auth/session-version";
import { isSessionRefreshAllowed } from "@/modules/auth/session-refresh";

/**
 * Auth.js v5 — Credentials (e-mail + senha) e, quando ligado em Admin > Configurações, Google;
 * sessão JWT.
 *
 * Sem `PrismaAdapter`: o schema (Cronos, docs/arquitetura.md §5) não tem
 * `Account`/`Session`/`VerificationToken` (os models que o adapter padrão do
 * Auth.js espera) e a sessão é JWT. O vínculo com o Google é `User.googleSub`, gerido por
 * `src/modules/google-auth/` — não pelo adapter. `AuthToken` (verificação de e-mail, redefinição
 * de senha, convite) é modelo próprio, gerido por `src/modules/auth/service.ts`.
 *
 * FORMA LAZY (`NextAuth(async (req) => config)`): o Client ID/Secret do Google moram no banco
 * (`PlatformSettings`, secret cifrado), não em env var — então a configuração é montada a cada
 * requisição, com cache de 30 s em `getGoogleRuntimeCredentials`. O provedor Google só entra se
 * ligado com ID e secret que decifram; o login por senha nunca depende disso (falha do banco na
 * leitura => só credenciais).
 *
 * URL BASE (revisão do Órion I3 — host header poisoning): o `redirect_uri` do Google
 * (`<base>/api/auth/callback/google`), os cookies `__Secure-` e os redirects do Auth.js saem da
 * origem da requisição, que vem de `Host`/`x-forwarded-*` (forjável). `pinAuthUrlToTrustedBase`
 * fixa `process.env.AUTH_URL` na `PlatformSettings.publicBaseUrl` (gravada pelo admin) ANTES de
 * o Auth.js ler o ambiente: o `next-auth` reescreve a origem da requisição para `AUTH_URL`
 * (`reqWithEnvURL`) e usa `AUTH_URL` em `signIn()`/`signOut()` de Server Action
 * (`createActionURL`). Mesmo valor para todas as requisições (é uma configuração global), então
 * mutar o ambiente não tem corrida. Sem `publicBaseUrl` (só na instalação) não há base confiável:
 * cai no comportamento de `trustHost` + cabeçalhos do proxy. Um `AUTH_URL` já definido pelo
 * operador no processo (dev/E2E em porta diferente) tem prioridade e nunca é sobrescrito.
 *
 * SESSÃO (I1): JWT com `maxAge` de 30 dias e renovação a cada 24 h de uso (`updateAge`); além
 * do prazo, o `sv` do token é conferido contra `User.sessionVersion` (cache de 5 s) para derrubar
 * sessões quando o vínculo Google/reset de senha/"sair de todos" acontece — ver
 * `src/modules/auth/session-version.ts`.
 *
 * `authorize()` NUNCA toca Prisma diretamente: chama os services — mesma regra das server actions
 * (docs/arquitetura.md §10: "app → modules → core").
 */

/** Conta criada só pelo Google tentou entrar com senha (`loginAction` lê `err.code`). */
export class GoogleAccountSignin extends CredentialsSignin {
  code = "google_account";
}

/** Segundo fator do login: `code` identifica o motivo (`loginAction`/`verifyTwoFactorLoginAction` leem). */
export class TwoFactorSignin extends CredentialsSignin {
  constructor(public code: "challenge_invalid" | "code_invalid" | "rate_limited") {
    super();
  }
}

const OPERATOR_AUTH_URL = process.env.AUTH_URL;
export const SESSION_MAX_AGE_S = 30 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_S = 24 * 60 * 60;

/** Fixa `AUTH_URL` na base pública confiável. Devolve `true` se há uma base fixada. */
async function pinAuthUrlToTrustedBase(): Promise<boolean> {
  if (OPERATOR_AUTH_URL) return true;
  let base: string | null = null;
  try {
    base = await getTrustedPublicBaseUrlCached();
  } catch (error) {
    logger.error("auth.trusted_base.read_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
  }
  if (base) process.env.AUTH_URL = base;
  else delete process.env.AUTH_URL;
  return base !== null;
}

async function buildConfig(): Promise<NextAuthConfig> {
  const [google, pinned] = await Promise.all([getGoogleRuntimeCredentials(), pinAuthUrlToTrustedBase()]);

  return {
    session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_S, updateAge: SESSION_UPDATE_AGE_S },
    // Só na janela de instalação (sem `publicBaseUrl`): Auth.js v5 recusa requisições atrás de um
    // proxy reverso que ele não reconhece (Easypanel/Traefik) — "problem with the server
    // configuration". Com a base fixada em `AUTH_URL` a origem já não vem do cabeçalho e o Auth.js
    // dispensa o flag.
    ...(pinned ? {} : { trustHost: true }),
    pages: {
      signIn: "/login",
      // Erros do fluxo OAuth (AccessDenied etc.) voltam para o login como `?error=...`.
      error: "/login",
    },
    providers: [
      Credentials({
        credentials: {
          email: { label: "E-mail", type: "email" },
          password: { label: "Senha", type: "password" },
        },
        async authorize(credentials) {
          const ip = await clientIp();
          try {
            const user = await verifyCredentials({
              email: String(credentials?.email ?? ""),
              password: String(credentials?.password ?? ""),
              ip,
            });
            // Rota pública: conta com 2FA ligada NUNCA abre sessão só com a senha (o login normal
            // passa por `two-factor`, abaixo).
            if (user && (await rejectIfTwoFactorEnabled(user.id))) return null;
            return user;
          } catch (error) {
            if (isDomainError(error) && error.code === "GOOGLE_ONLY_ACCOUNT") throw new GoogleAccountSignin();
            throw error;
          }
        },
      }),
      // Sessão para quem acabou de provar a senha em `loginAction` (conta SEM 2FA): a prova assinada
      // de 60 s nasce e é consumida na mesma action; evita conferir (e contar no rate limit) a senha duas vezes.
      Credentials({
        id: "verified-login",
        credentials: { proof: { label: "Prova", type: "text" } },
        async authorize(credentials) {
          return loadVerifiedLoginUser(String(credentials?.proof ?? ""));
        },
      }),
      // Segundo fator do login por senha: desafio assinado (emitido só depois da senha certa) + código
      // do app ou de recuperação. Ver `src/modules/two-factor/login.ts`.
      Credentials({
        id: "two-factor",
        credentials: { challenge: { label: "Desafio", type: "text" }, code: { label: "Código", type: "text" } },
        async authorize(credentials) {
          const ip = await clientIp();
          try {
            return await completeTwoFactorLogin({
              challenge: String(credentials?.challenge ?? ""),
              code: String(credentials?.code ?? ""),
              ip,
            });
          } catch (error) {
            if (isDomainError(error)) {
              if (error.code === "TWO_FACTOR_CODE_INVALID") throw new TwoFactorSignin("code_invalid");
              if (error.code === "TWO_FACTOR_RATE_LIMITED") throw new TwoFactorSignin("rate_limited");
              if (error.code === "TWO_FACTOR_CHALLENGE_INVALID") throw new TwoFactorSignin("challenge_invalid");
            }
            throw error;
          }
        },
      }),
      // Abre a sessão logo depois do cadastro pelo Google. O único "credencial" aceito é uma prova
      // assinada de 60 s que o servidor gera na própria action (`completeGoogleSignUpAction`) —
      // nunca sai para o cliente. Sem a prova válida, não autentica ninguém.
      Credentials({
        id: "google-signup",
        credentials: { proof: { label: "Prova", type: "text" } },
        async authorize(credentials) {
          try {
            const claims = verifyGoogleToken<{ userId: string }>("google-login", String(credentials?.proof ?? ""));
            return await loadGoogleLoginUser(claims.userId);
          } catch {
            return null;
          }
        },
      }),
      ...(google
        ? [
            Google({
              clientId: google.clientId,
              clientSecret: google.clientSecret,
              // O padrão do Auth.js para este provedor é SÓ `pkce` (verificado: sem `state` na URL de
              // autorização). Liga `state` + `nonce` explicitamente — não remova.
              checks: ["pkce", "state", "nonce"],
            }),
          ]
        : []),
    ],
    callbacks: {
      async signIn({ account, profile }) {
        if (account?.provider !== "google") return true;

        // Convite de equipe: cookie posto por `startGoogleInviteSignInAction`. Lido e apagado.
        let inviteToken: string | null = null;
        try {
          const jar = await cookies();
          inviteToken = jar.get(GOOGLE_INVITE_COOKIE)?.value ?? null;
          if (inviteToken) jar.delete(GOOGLE_INVITE_COOKIE);
        } catch {
          inviteToken = null;
        }

        const outcome = await resolveGoogleSignIn(
          {
            sub: account.providerAccountId,
            email: typeof profile?.email === "string" ? profile.email : null,
            emailVerified: profile?.email_verified === true,
            name: typeof profile?.name === "string" ? profile.name : null,
          },
          { inviteToken },
        );
        if (outcome.kind === "deny") return false; // -> /login?error=AccessDenied
        if (outcome.kind === "signup") {
          // Token na URL + cookie httpOnly com o hash dele: a tela só abre no navegador que fez o login (S1).
          await setGoogleSignupCookie(outcome.token);
          return `/cadastro/google?t=${encodeURIComponent(outcome.token)}`;
        }
        return true;
      },
      async jwt({ token, user, account, trigger }) {
        if (account?.provider === "google") {
          // `user.id` do provedor é o `sub` do Google — o id do NOSSO usuário sai do vínculo.
          const userId = await userIdForGoogleSub(account.providerAccountId);
          if (!userId) {
            logger.error("google_auth.jwt.user_not_found", {});
            return null;
          }
          token.userId = userId;
        } else if (user) {
          token.userId = user.id;
        }
        if (!token.userId) return token;

        // Renovação deliberada do `sv` (ativar a 2FA derruba as outras sessões e mantém esta). Só vale dentro do escopo
        // aberto pela Server Action (`runWithSessionRefresh`); `update` vindo do navegador não passa daqui.
        if (trigger === "update" && isSessionRefreshAllowed(token.userId as string)) {
          forgetSessionVersion(token.userId as string);
          const fresh = await readSessionVersion(token.userId as string, { fresh: true });
          if (fresh === null) return null;
          token.sv = fresh;
          return token;
        }

        // Login novo: grava a versão ATUAL (leitura fresca). Leituras seguintes: confere contra o
        // banco (cache de 5 s); versão diferente ou usuário removido => sessão inválida.
        if (user || account) {
          forgetSessionVersion(token.userId);
          const sv = await readSessionVersion(token.userId, { fresh: true });
          if (sv === null) return null;
          token.sv = sv;
          return token;
        }
        const current = await readSessionVersion(token.userId);
        if (current === null || !isSessionVersionCurrent(token.sv, current)) return null;
        return token;
      },
      async session({ session, token }) {
        if (session.user && token.userId) {
          session.user.id = token.userId as string;
        }
        return session;
      },
    },
  };
}

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth(async () => buildConfig());
