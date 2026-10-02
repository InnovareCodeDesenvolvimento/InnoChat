/**
 * Monitor de cobrança (F7, docs/regua-de-cobranca.md §2.5 e §4): decide se a cobrança está `ok`, `degraded` ou `down`.
 * PURO (sem I/O): recebe os números já medidos e devolve o veredito. Quem mede é `src/modules/billing/health.ts`.
 *
 * O veredito alimenta quatro lugares com a MESMA regra: `GET /api/health/billing` (monitor externo), o sino do Admin,
 * a tela Saúde e o e-mail ao admin quando vira `down`.
 */

/** O billing/tick roda de hora em hora (n8n). Passou disso sem rodar = parado (`down`, HTTP 503). */
export const BILLING_TICK_DOWN_AFTER_MINUTES = 180;

/** A tela Saúde e o sino já marcavam "atrasado" a partir de 2 h: é o selo "atenção", antes do "parado". */
export const BILLING_TICK_WARN_AFTER_MINUTES = 120;

/** Aviso vencido (PENDING, ou FAILED com nova tentativa) cuja hora de enviar passou há mais que isto = preso. */
export const BILLING_NOTICE_STUCK_AFTER_MINUTES = 120;

/** Um aviso de e-mail que já falhou nesta quantidade de rodadas seguidas conta como "e-mail falhando em sequência". */
export const EMAIL_FAILING_MIN_ATTEMPTS = 3;

/** ...desde que nenhum e-mail de cobrança tenha saído nesta janela (um destinatário ruim sozinho não derruba o monitor). */
export const EMAIL_FAILING_NO_SUCCESS_WINDOW_MINUTES = 180;

/** O e-mail ao admin sai no máximo uma vez a cada isto, enquanto o status continuar `down`. */
export const BILLING_DOWN_ALERT_INTERVAL_HOURS = 6;

export type BillingHealthStatus = "ok" | "degraded" | "down";
export type BillingPlatformWhatsapp = "connected" | "disconnected" | "missing" | "disabled";

/** Códigos curtos do motivo (seguros para expor: nenhum dado pessoal). */
export type BillingHealthReason =
  | "TICK_STALE"
  | "TICK_NEVER_RAN"
  | "NOTICES_STUCK_EMAIL"
  | "EMAIL_FAILING_IN_SEQUENCE"
  | "TICK_DEADLINE_REACHED"
  | "TICK_LOCK_TIMED_OUT"
  | "NOTICES_STUCK_WHATSAPP"
  | "EMAIL_FAILED_LAST_ROUND"
  | "PLATFORM_WHATSAPP_DOWN"
  | "HEALTH_UNAVAILABLE";

export type BillingHealthInput = {
  now: Date;
  lastTickAt: Date | null;
  /** JSON gravado pelo tick (`BillingTickSummary`). Lido com cuidado: pode vir nulo ou de versão antiga. */
  lastTickResult: unknown;
  /** Só para "nunca rodou": existe empresa criada há mais que o limite? Sem empresa, não há o que cobrar. */
  hasTenantOlderThanDownLimit: boolean;
  /** Avisos vencidos presos por canal. */
  stuckEmailNotices: number;
  stuckWhatsappNotices: number;
  failedLast24h: number;
  /** Algum aviso de e-mail falhou em rodadas seguidas e nenhum e-mail saiu na janela. */
  emailFailingInSequence: boolean;
  platformWhatsapp: BillingPlatformWhatsapp;
};

export type BillingHealthReport = {
  status: BillingHealthStatus;
  lastTickAt: string | null;
  minutesSinceLastTick: number | null;
  lastTickResult: { sent: number; failed: number; skippedByLock?: true; deadlineReached?: true } | null;
  pendingOverdue: number;
  failedLast24h: number;
  emailFailing: boolean;
  platformWhatsapp: BillingPlatformWhatsapp;
  reasons: BillingHealthReason[];
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function flag(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

/** Lê o resumo do tick sem confiar no formato (JSON livre no banco). Nunca devolve texto, só números e marcas. */
export function readTickResult(raw: unknown): { sent: number; failed: number; skippedByLock?: true; deadlineReached?: true; lockTimedOut?: true; emailsFailed: number } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return {
    sent: count(r.noticesSent),
    failed: count(r.noticesFailed),
    emailsFailed: count(r.emailsFailed),
    ...(flag(r, "skippedByLock") ? { skippedByLock: true as const } : {}),
    ...(flag(r, "deadlineReached") ? { deadlineReached: true as const } : {}),
    ...(flag(r, "lockTimedOut") ? { lockTimedOut: true as const } : {}),
  };
}

export function evaluateBillingHealth(input: BillingHealthInput): BillingHealthReport {
  const tick = readTickResult(input.lastTickResult);
  const minutesSinceLastTick = input.lastTickAt ? Math.max(0, Math.floor((input.now.getTime() - input.lastTickAt.getTime()) / 60_000)) : null;

  const down: BillingHealthReason[] = [];
  const warn: BillingHealthReason[] = [];

  if (minutesSinceLastTick === null) {
    if (input.hasTenantOlderThanDownLimit) down.push("TICK_NEVER_RAN");
  } else if (minutesSinceLastTick > BILLING_TICK_DOWN_AFTER_MINUTES) {
    down.push("TICK_STALE");
  }
  if (input.stuckEmailNotices > 0) down.push("NOTICES_STUCK_EMAIL");
  if (input.emailFailingInSequence) down.push("EMAIL_FAILING_IN_SEQUENCE");

  if (tick?.deadlineReached) warn.push("TICK_DEADLINE_REACHED");
  if (tick?.lockTimedOut) warn.push("TICK_LOCK_TIMED_OUT");
  if (input.stuckWhatsappNotices > 0) warn.push("NOTICES_STUCK_WHATSAPP");
  if ((tick?.emailsFailed ?? 0) > 0 && !input.emailFailingInSequence) warn.push("EMAIL_FAILED_LAST_ROUND");
  if (input.platformWhatsapp === "disconnected" || input.platformWhatsapp === "missing") warn.push("PLATFORM_WHATSAPP_DOWN");

  const status: BillingHealthStatus = down.length > 0 ? "down" : warn.length > 0 ? "degraded" : "ok";

  return {
    status,
    lastTickAt: input.lastTickAt?.toISOString() ?? null,
    minutesSinceLastTick,
    lastTickResult: tick
      ? { sent: tick.sent, failed: tick.failed, ...(tick.skippedByLock ? { skippedByLock: true as const } : {}), ...(tick.deadlineReached ? { deadlineReached: true as const } : {}) }
      : null,
    pendingOverdue: input.stuckEmailNotices + input.stuckWhatsappNotices,
    failedLast24h: input.failedLast24h,
    emailFailing: input.emailFailingInSequence || (tick?.emailsFailed ?? 0) > 0,
    platformWhatsapp: input.platformWhatsapp,
    reasons: [...down, ...warn],
  };
}

/** Relatório seguro para quando nem o banco responde: o monitor externo precisa de um 503 claro. */
export function unavailableBillingHealth(): BillingHealthReport {
  return {
    status: "down",
    lastTickAt: null,
    minutesSinceLastTick: null,
    lastTickResult: null,
    pendingOverdue: 0,
    failedLast24h: 0,
    emailFailing: false,
    platformWhatsapp: "disabled",
    reasons: ["HEALTH_UNAVAILABLE"],
  };
}
