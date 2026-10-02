import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { tryGetPublicBaseUrl } from "@/lib/public-url";
import { completeGoogleConnection } from "@/modules/backup/service";

/**
 * `GET /api/admin/backup/google/callback`: volta do consentimento do Google ("Conectar com Google",
 * Admin > Backup). Chega pelo NAVEGADOR, redirecionado pelo Google, então o cookie de sessão vem junto.
 * Duas provas de quem iniciou: a sessão do admin logado E o `state` assinado, de uso único e com prazo
 * de 10 minutos, que tem de ser da mesma pessoa. Sem as duas, nada é gravado (um link forjado não pode
 * ligar a conta Google de um atacante ao backup).
 *
 * SEMPRE redireciona para /admin/backup (`?google=conectado` ou `?google=erro&motivo=<codigo>`), nunca
 * devolve JSON: quem chama é o navegador navegando, e um erro JSON vira tela em branco. O `motivo` é um
 * código curto que a tela traduz; nunca vai mensagem crua do Google, código de autorização ou token.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = ((await tryGetPublicBaseUrl().catch(() => null)) ?? url.origin).replace(/\/+$/, "");
  const back = (query: string) => NextResponse.redirect(`${base}/admin/backup?${query}`);

  try {
    const session = await auth();
    const outcome = await completeGoogleConnection({
      state: url.searchParams.get("state"),
      code: url.searchParams.get("code"),
      googleError: url.searchParams.get("error"),
      sessionUserId: session?.user?.id ?? null,
    });
    return outcome.ok ? back("google=conectado") : back(`google=erro&motivo=${encodeURIComponent(outcome.reason)}`);
  } catch (error) {
    logger.error("backup.oauth.callback_unexpected", { errorName: error instanceof Error ? error.name : "unknown" });
    return back("google=erro&motivo=desconhecido");
  }
}
