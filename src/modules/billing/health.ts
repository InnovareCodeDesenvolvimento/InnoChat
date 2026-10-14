import { getPrisma } from "@/lib/db/prisma";
import {
  BILLING_NOTICE_STUCK_AFTER_MINUTES,
  BILLING_TICK_DOWN_AFTER_MINUTES,
  EMAIL_FAILING_MIN_ATTEMPTS,
  EMAIL_FAILING_NO_SUCCESS_WINDOW_MINUTES,
  evaluateBillingHealth,
  type BillingHealthReport,
  type BillingPlatformWhatsapp,
} from "@/core/billing/billing-health";
import { NOTICE_MAX_ATTEMPTS } from "@/core/billing/dunning-policy";

/**
 * Mede a saúde da cobrança no banco (só contagens e datas, nada de dado pessoal) e entrega ao avaliador puro
 * (`core/billing/billing-health.ts`). Usado por `GET /api/health/billing`, pelo sino, pela tela Saúde e pelo e-mail ao admin.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Aviso "vencido e preso": estava na hora de sair (`nextAttemptAt` passou há mais que o limite) e continua esperando.
 * PENDING nunca enviado, ou FAILED com nova tentativa permitida. Fora de janela de horário ou com o canal fora do ar o
 * aviso é adiado para o futuro, então não conta. `notBefore`/`expiresAt`/tentativas espelham o claim do despachante.
 * Compartilhada com o sino do Admin.
 */
export function stuckNoticesWhere(now: Date, channel?: "EMAIL" | "WHATSAPP") {
  return {
    ...(channel ? { channel } : {}),
    status: { in: ["PENDING", "FAILED"] },
    nextAttemptAt: { lt: new Date(now.getTime() - BILLING_NOTICE_STUCK_AFTER_MINUTES * MINUTE_MS) },
    notBefore: { lte: now },
    expiresAt: { gt: now },
    attempts: { lt: NOTICE_MAX_ATTEMPTS },
  };
}

export async function loadBillingHealth(now: Date = new Date()): Promise<BillingHealthReport> {
  const prisma = getPrisma();
  const downLimit = new Date(now.getTime() - BILLING_TICK_DOWN_AFTER_MINUTES * MINUTE_MS);

  const [settings, connection, stuckEmailNotices, stuckWhatsappNotices, failedLast24h, failingEmailNotices, olderTenant] = await Promise.all([
    prisma.platformSettings.findUnique({
      where: { id: 1 },
      select: { lastBillingTickAt: true, lastBillingTickResult: true, platformWhatsappEnabled: true },
    }),
    prisma.platformWhatsappConnection.findFirst({ where: { role: "ACTIVE", purpose: "BILLING" }, select: { status: true } }),
    prisma.billingNotice.count({ where: stuckNoticesWhere(now, "EMAIL") }),
    prisma.billingNotice.count({ where: stuckNoticesWhere(now, "WHATSAPP") }),
    prisma.billingNotice.count({ where: { status: "FAILED", updatedAt: { gte: new Date(now.getTime() - DAY_MS) } } }),
    prisma.billingNotice.count({
      where: {
        channel: "EMAIL",
        status: "FAILED",
        attempts: { gte: EMAIL_FAILING_MIN_ATTEMPTS, lt: NOTICE_MAX_ATTEMPTS },
        expiresAt: { gt: now },
        updatedAt: { gte: new Date(now.getTime() - DAY_MS) },
      },
    }),
    prisma.tenant.count({ where: { createdAt: { lt: downLimit } } }),
  ]);

  let emailFailingInSequence = false;
  if (failingEmailNotices > 0) {
    const sentRecently = await prisma.billingNotice.count({
      where: { channel: "EMAIL", status: "SENT", sentAt: { gte: new Date(now.getTime() - EMAIL_FAILING_NO_SUCCESS_WINDOW_MINUTES * MINUTE_MS) } },
    });
    emailFailingInSequence = sentRecently === 0;
  }

  let platformWhatsapp: BillingPlatformWhatsapp = "disabled";
  if (settings?.platformWhatsappEnabled) {
    platformWhatsapp = !connection ? "missing" : connection.status === "CONNECTED" ? "connected" : "disconnected";
  }

  return evaluateBillingHealth({
    now,
    lastTickAt: settings?.lastBillingTickAt ?? null,
    lastTickResult: settings?.lastBillingTickResult ?? null,
    hasTenantOlderThanDownLimit: olderTenant > 0,
    stuckEmailNotices,
    stuckWhatsappNotices,
    failedLast24h,
    emailFailingInSequence,
    platformWhatsapp,
  });
}
