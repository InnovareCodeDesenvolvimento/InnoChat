import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { handlePlatformWhatsappWebhook } from "@/modules/platform-whatsapp/webhook";

/**
 * Webhook da Evolution para a instância do WhatsApp da plataforma (cobrança). NUNCA o n8n: o `syncN8n`
 * só reaponta `WhatsappInstance` de empresa. Token errado 401, conexão aposentada 410, o resto 200.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // corpo vazio ou inválido: tratado como evento desconhecido (200)
  }
  try {
    const result = await handlePlatformWhatsappWebhook(token, body);
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    logger.error("platform_whatsapp.webhook_unexpected", { errorMessage: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: { code: "INTERNAL", message: "Erro ao processar o evento." } }, { status: 500 });
  }
}
