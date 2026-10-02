import { NextResponse } from "next/server";

import { logger } from "@/lib/logger";
import { unavailableBillingHealth } from "@/core/billing/billing-health";
import { loadBillingHealth } from "@/modules/billing/health";
import { notifyAdminBillingDown } from "@/modules/billing/health-alert";

/**
 * `GET /api/health/billing` (F7, docs/regua-de-cobranca.md): saúde da cobrança para o monitor EXTERNO (UptimeRobot).
 * Público de propósito (o monitor não tem login) e SEM dado pessoal: só status, datas e contagens agregadas.
 *
 * - 200 para `ok` e `degraded` (WhatsApp de cobrança caído é só aviso).
 * - 503 para `down`: rotina parada há mais de 3 h, avisos de e-mail vencidos e presos, ou e-mails falhando em sequência.
 * - Nunca vaza erro interno: se o banco não responde, devolve 503 com motivo genérico e loga o detalhe.
 * - `force-dynamic` + `no-store`: sempre medição ao vivo, nunca pré-renderizada no build (que roda sem banco).
 *
 * Quando o status é `down`, aproveita a consulta do monitor (a cada 5 min) para avisar o admin por e-mail, no máximo uma
 * vez a cada 6 h (`notifyAdminBillingDown`). É um gatilho que não depende do n8n.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

export async function GET() {
  try {
    const report = await loadBillingHealth(new Date());
    if (report.status === "down") {
      // Sem `await`: o SMTP pode levar segundos e o monitor tem prazo curto. `notifyAdminBillingDown` nunca lança.
      void notifyAdminBillingDown(report, new Date());
    }
    return NextResponse.json(report, { status: report.status === "down" ? 503 : 200, headers: NO_STORE });
  } catch (error) {
    logger.error("health.billing.unavailable", { errorName: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json(unavailableBillingHealth(), { status: 503, headers: NO_STORE });
  }
}
