import { getPrisma } from "@/lib/db/prisma";
import { upsertErrorGroup } from "@/lib/db/error-queries";
import { APP_VERSION } from "@/lib/app-info";
import { prepareError, type RawErrorInput } from "@/core/error-monitor/prepare";
import { globalState } from "@/lib/global-state";
import { scheduleErrorAlertFlush } from "./alert";

/**
 * Captura de erros (Melhoria 1). Regra de ouro: capturar NUNCA derruba nem atrasa a requisição.
 *
 * - `captureError` é fire-and-forget: devolve na hora, qualquer falha vira um `console.warn` curto.
 * - Sem loop: o monitor não usa `logger.error` (que é um dos gatilhos da captura), só `console.warn`; e há um teto de
 *   gravações simultâneas, então um erro ao gravar erro não gera uma fila crescente.
 * - Sem avalanche: teto por minuto e um intervalo mínimo por assinatura (um bug em loop não vira milhares de linhas).
 *   O contador do grupo perde as ocorrências descartadas; o que importa é o grupo e o alerta.
 * - Orçamentos SEPARADOS por origem: o navegador (rota pública, qualquer um relata) tem teto próprio e pequeno de gravações
 *   por minuto e de gravações simultâneas; quem despeja relato falso nunca consome o orçamento do erro real do servidor.
 * - Cada grupo guarda no máximo `EVENTS_PER_GROUP` ocorrências (as mais recentes); a retenção de 30 dias fica na manutenção.
 */

const SAME_FINGERPRINT_MIN_GAP_MS = 2_000;
export const EVENTS_PER_GROUP = 50;

/**
 * Teto de grupos OPEN vindos do navegador. A rota é pública: quem varia a mensagem a cada envio cria um grupo novo por
 * relato. Acima do teto, erro NOVO do navegador entra num grupo único (fingerprint fixo) que só conta; erro que já tem
 * grupo segue normal.
 */
export const CLIENT_OPEN_GROUPS_CAP = 300;
export const CLIENT_OVERFLOW_FINGERPRINT = "client-overflow";
const CLIENT_OVERFLOW_MESSAGE = "Outros erros do navegador";

type Source = "SERVER" | "CLIENT";
export const BUDGETS: Record<Source, { maxInFlight: number; maxPerMinute: number }> = {
  SERVER: { maxInFlight: 5, maxPerMinute: 120 },
  CLIENT: { maxInFlight: 2, maxPerMinute: 30 },
};

// Em `globalThis` (ver `src/lib/global-state.ts`): os tetos precisam ser um só por processo, não um por bundle do Next.
const shared = globalState("error-monitor-capture", () => ({
  state: {
    SERVER: { inFlight: 0, windowStart: 0, windowCount: 0 },
    CLIENT: { inFlight: 0, windowStart: 0, windowCount: 0 },
  } as Record<Source, { inFlight: number; windowStart: number; windowCount: number }>,
  lastByFingerprint: new Map<string, number>(),
}));
const state = shared.state;
const lastByFingerprint = shared.lastByFingerprint;

function sourceOf(input: RawErrorInput): Source {
  return input.source === "CLIENT" ? "CLIENT" : "SERVER";
}

function allowedByThrottle(source: Source, fingerprint: string, now: number): boolean {
  const s = state[source];
  if (now - s.windowStart >= 60_000) {
    s.windowStart = now;
    s.windowCount = 0;
  }
  if (s.windowCount >= BUDGETS[source].maxPerMinute) return false;
  const key = `${source}:${fingerprint}`;
  const last = lastByFingerprint.get(key);
  if (last !== undefined && now - last < SAME_FINGERPRINT_MIN_GAP_MS) return false;
  s.windowCount += 1;
  lastByFingerprint.set(key, now);
  if (lastByFingerprint.size > 500) {
    for (const [k, at] of lastByFingerprint) if (now - at > 60_000) lastByFingerprint.delete(k);
  }
  return true;
}

/** Só para testes. */
export function __resetCaptureThrottleForTests() {
  for (const source of ["SERVER", "CLIENT"] as const) Object.assign(state[source], { inFlight: 0, windowStart: 0, windowCount: 0 });
  lastByFingerprint.clear();
}

export type RecordOutcome = { recorded: false; reason: "THROTTLED" | "BUSY" } | { recorded: true; groupId: string; status: string };

/** Grava e devolve o resultado (usado nos testes e pela rota do navegador). Pode lançar: quem chama decide. */
export async function recordError(input: RawErrorInput, now: Date = new Date()): Promise<RecordOutcome> {
  const source = sourceOf(input);
  if (state[source].inFlight >= BUDGETS[source].maxInFlight) return { recorded: false, reason: "BUSY" };
  state[source].inFlight += 1;
  try {
    const prepared = prepareError({ ...input, version: input.version ?? APP_VERSION });
    if (!allowedByThrottle(source, prepared.fingerprint, now.getTime())) return { recorded: false, reason: "THROTTLED" };

    const overflow = prepared.source === "CLIENT" && (await clientGroupsAreFull(prepared.fingerprint));
    const group = await upsertErrorGroup({
      fingerprint: overflow ? CLIENT_OVERFLOW_FINGERPRINT : prepared.fingerprint,
      message: overflow ? CLIENT_OVERFLOW_MESSAGE : prepared.message,
      type: overflow ? "ClientOverflow" : prepared.type,
      source: prepared.source,
      route: overflow ? null : prepared.route,
      version: prepared.version,
      now,
    });

    // IGNORED só conta: não guarda ocorrência. O grupo "Outros erros do navegador" também só conta.
    if (group.status !== "IGNORED" && !overflow) {
      const prisma = getPrisma();
      await prisma.errorEvent.create({
        data: {
          groupId: group.id,
          occurredAt: now,
          version: prepared.version,
          route: prepared.route,
          stack: prepared.stack,
          userId: prepared.userId,
          tenantId: prepared.tenantId,
          context: prepared.context ? (prepared.context as object) : undefined,
        },
      });
      if (group.count > EVENTS_PER_GROUP && group.count % 10 === 0) await trimGroupEvents(group.id);
    }

    if (group.status === "OPEN" && group.alertedAt === null) scheduleErrorAlertFlush();
    return { recorded: true, groupId: group.id, status: group.status };
  } finally {
    state[source].inFlight -= 1;
  }
}

/** Verdadeiro quando este erro do navegador é NOVO e já existem `CLIENT_OPEN_GROUPS_CAP` grupos OPEN do navegador. */
async function clientGroupsAreFull(fingerprint: string): Promise<boolean> {
  const prisma = getPrisma();
  const existing = await prisma.errorGroup.findUnique({ where: { fingerprint }, select: { id: true } });
  if (existing) return false;
  const open = await prisma.errorGroup.count({ where: { source: "CLIENT", status: "OPEN", fingerprint: { not: CLIENT_OVERFLOW_FINGERPRINT } } });
  return open >= CLIENT_OPEN_GROUPS_CAP;
}

async function trimGroupEvents(groupId: string): Promise<void> {
  const prisma = getPrisma();
  const extra = await prisma.errorEvent.findMany({
    where: { groupId },
    orderBy: { occurredAt: "desc" },
    skip: EVENTS_PER_GROUP,
    take: 200,
    select: { id: true },
  });
  if (extra.length > 0) await prisma.errorEvent.deleteMany({ where: { id: { in: extra.map((e) => e.id) } } });
}

/** Fire-and-forget: nunca lança, nunca espera. */
export function captureError(input: RawErrorInput): void {
  try {
    void recordError(input).catch((error: unknown) => {
      console.warn("error-monitor: falha ao gravar o erro", error instanceof Error ? error.name : "unknown");
    });
  } catch {
    // Nada a fazer: o monitor jamais pode quebrar quem o chama.
  }
}

// ---------------------------------------------------------------------------------------------
// Pontos de entrada do servidor
// ---------------------------------------------------------------------------------------------

/** Erros de controle de fluxo do Next (redirect, notFound, render dinâmico) não são falhas. */
function isNextControlFlow(error: unknown): boolean {
  const digest = error && typeof error === "object" ? (error as { digest?: unknown }).digest : undefined;
  if (typeof digest !== "string") return false;
  return /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING|NEXT_PRERENDER)/.test(digest);
}

/** Usado por `onRequestError` do Next (instrumentation). Só o caminho da rota, nunca a query nem os headers. */
export function captureRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routePath: string; routeType: string },
): void {
  if (isNextControlFlow(error)) return;
  const digest = error && typeof error === "object" ? (error as { digest?: unknown }).digest : undefined;
  captureError({
    source: "SERVER",
    error,
    route: context.routePath || request.path,
    context: { method: request.method, routeType: context.routeType, ...(typeof digest === "string" ? { digest } : {}) },
  });
}

/** Usado pelo gancho do `logger.error`: o evento (nome fixo) vira o tipo, os campos já vêm redigidos. */
export function captureLoggedError(event: string, fields: Record<string, unknown> | undefined): void {
  const attached = fields && (fields.error ?? fields.err);
  const detail = typeof fields?.errorMessage === "string" ? fields.errorMessage : undefined;
  const { error: _e, err: _er, ...rest } = fields ?? {};
  void _e;
  void _er;
  captureError({
    source: "SERVER",
    type: "LoggedError",
    message: detail ? `${event}: ${detail}` : event,
    stack: attached instanceof Error ? attached.stack : undefined,
    context: rest,
  });
}
