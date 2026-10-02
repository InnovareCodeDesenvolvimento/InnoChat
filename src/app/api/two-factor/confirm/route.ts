import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth/guards";
import { logger } from "@/lib/logger";
import { runAction, err } from "@/lib/result";
import { isSameOrigin, readBodyWithLimit } from "@/modules/error-monitor/client-report";
import { runWithSessionRefresh } from "@/modules/auth/session-refresh";
import { confirmTwoFactorSetup } from "@/modules/two-factor/service";

/**
 * `POST /api/two-factor/confirm` `{ code }`: confirma o cadastro da verificação em 2 etapas (primeiro código do app).
 *
 * POR QUE É UMA ROTA E NÃO UMA SERVER ACTION: ativar a 2FA incrementa `sessionVersion` (derruba as OUTRAS sessões) e a
 * sessão de quem ativou precisa ganhar um cookie novo (`sv` renovado). Uma Server Action que troca o cookie faz o Next
 * refazer a página na mesma resposta, e o `auth()` dessa renderização ainda lê o cookie ANTIGO (cabeçalho da requisição):
 * a sessão pareceria revogada e a pessoa cairia no /login com os códigos de recuperação (mostrados uma vez) perdidos.
 * Numa rota não há renderização de página: o cookie novo vai direto na resposta.
 *
 * Resposta: `Result<{ recoveryCodes }>` em JSON. 200 em sucesso; 401 sem sessão; 400 para erro de regra/validação;
 * 403 de outra origem. Nunca loga segredo nem código.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_BODY_BYTES = 1024;
const bodySchema = z.object({ code: z.string().trim().min(1).max(32) });

export async function POST(request: Request) {
  if (!isSameOrigin(request.headers.get("origin"), request.headers.get("host"))) {
    return NextResponse.json(err("FORBIDDEN_ORIGIN", "Origem não permitida."), { status: 403, headers: NO_STORE });
  }
  const raw = await readBodyWithLimit(request, MAX_BODY_BYTES).catch(() => null);

  const result = await runAction(async () => {
    const user = await requireSessionUser();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const { code } = bodySchema.parse(parsed);
    const confirmed = await confirmTwoFactorSetup(user.id, code);
    // As outras sessões já caíram (`sessionVersion`); esta ganha o `sv` novo no cookie desta resposta. Se a renovação
    // falhar, só esta sessão cai no próximo acesso: os códigos de recuperação saem do mesmo jeito.
    try {
      const { unstable_update } = await import("@/lib/auth");
      await runWithSessionRefresh(user.id, () => unstable_update({}));
    } catch (error) {
      logger.warn("two_factor.session_refresh_failed", { userId: user.id, errorName: error instanceof Error ? error.name : "unknown" });
    }
    return confirmed;
  });

  const status = result.ok ? 200 : result.error.code === "UNAUTHENTICATED" ? 401 : 400;
  return NextResponse.json(result, { status, headers: NO_STORE });
}
