import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { notFound, type InternalApiContext } from "./internal-auth";
import { digitsFromJid } from "@/core/bot/evolution-normalize";
import { logger } from "@/lib/logger";
import { computeTenantTeamOpening } from "@/modules/agenda/team-hours-loader";
import { getMergedBotTexts } from "@/modules/bot-texts/service";
import { logChatMessage, logOutboundTexts, sanitizeChatBody } from "@/modules/conversations/log";
import { getEvolutionClient } from "@/modules/whatsapp/evolution-client";
import { appendRecentOutbound } from "./claim";
import { ensureOpenHandoff } from "./handoff";
import { pushSandboxOutbox } from "./sandbox-outbox";
import { isTenantBotAllowed } from "./subscription-gate";

/** O aviso `TECH_ERROR` do release sai no máximo 1x neste intervalo por cliente (BUG-04). */
const TECH_ERROR_COOLDOWN_MS = 10 * 60 * 1000;
/** Só avisa quem escreveu há pouco: depois disso o aviso chegaria fora de contexto. */
const TECH_ERROR_MAX_INBOUND_AGE_MS = 5 * 60 * 1000;

/**
 * Carrega a `ChatSession` já validada como pertencente à instância resolvida pelo token
 * (docs/arquitetura.md §6.1 — "todo ID recebido é revalidado contra o tenant da instância").
 * `ChatSession` não tem `tenantId` próprio (ver
 * `.claude/agent-memory/vega/for_tenant_scope_limits.md`) — o escopo é por `whatsappInstanceId`.
 */
async function loadOwnedSession(ctx: InternalApiContext, sessionId: string) {
  const session = await getPrisma().chatSession.findUnique({ where: { id: sessionId } });
  if (!session || session.whatsappInstanceId !== ctx.instance.id) {
    notFound("Sessão não encontrada.");
  }
  return session;
}

export type UpdateSessionInput = {
  lockToken: string;
  version: number;
  state: string;
  context: unknown;
  invalidCount: number;
  outbound: string[];
  handoff: boolean;
  /** v2: o cliente pediu atendente (pausa `handoffResumeMinutes`). Sem isto, `handoff` é o fluxo v1 (LEGACY_FLOW). */
  handoffReason?: "CLIENT_REQUEST";
};

/**
 * `PUT /sessions/{id}` (docs/arquitetura.md §6.3): grava e libera a trava. `409 LOCK_LOST`
 * (mapeado pela rota) se a trava já venceu ou a versão não bate — nesse caso o n8n **não
 * envia** e encerra a execução, então esta função não grava NADA quando isso acontece.
 */
export async function updateSession(ctx: InternalApiContext, sessionId: string, input: UpdateSessionInput) {
  const session = await loadOwnedSession(ctx, sessionId);
  const now = new Date();

  const lockValid = session.lockToken === input.lockToken && !!session.lockedUntil && session.lockedUntil > now;
  const versionValid = session.version === input.version;
  if (!lockValid || !versionValid) {
    throw new DomainError("LOCK_LOST", "A trava da sessão venceu ou a versão está desatualizada.");
  }

  const prisma = getPrisma();
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });

  const recentOutbound = appendRecentOutbound(session.recentOutbound, input.outbound, now);
  const isClientRequest = input.handoff && input.handoffReason === "CLIENT_REQUEST";
  const pauseMin = isClientRequest ? tenant.handoffResumeMinutes : tenant.humanPauseMin;
  const humanUntil = input.handoff ? new Date(now.getTime() + pauseMin * 60_000) : session.humanUntil;
  // Lido ANTES da transação: `offHours` só é gravado no pedido novo, e a leitura não deve segurar a transação.
  const offHours = input.handoff ? !(await computeTenantTeamOpening(tenant, now)).openNow : false;

  // Sessão + pedido de atendente na MESMA transação: nunca fica HUMAN sem pedido (o sino não avisaria)
  // nem pedido sem a pausa correspondente.
  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.chatSession.update({
      where: { id: sessionId },
      data: {
        state: input.handoff ? "HUMAN" : input.state,
        context: input.context as object,
        invalidCount: input.invalidCount,
        version: { increment: 1 },
        lockToken: null,
        lockedUntil: null,
        recentOutbound,
        humanUntil,
      },
    });
    if (input.handoff) {
      await ensureOpenHandoff(tx, {
        tenantId: ctx.tenantId,
        whatsappInstanceId: ctx.instance.id,
        contactId: session.contactId,
        chatSessionId: sessionId,
        reason: isClientRequest ? "CLIENT_REQUEST" : "LEGACY_FLOW",
        offHours,
      });
    }
    return saved;
  });

  // Histórico de conversas: o n8n salva a sessão ANTES de enviar (LOCK_LOST já abortou acima, então
  // nada é registrado para mensagem que não vai sair). Serve também a instância sandbox — o desvio
  // para /sandbox/outbox acontece depois deste PUT, então o log já cobre a saída de teste.
  await logOutboundTexts({
    tenantId: ctx.tenantId,
    whatsappInstanceId: ctx.instance.id,
    contactId: session.contactId,
    texts: input.outbound,
  });

  return { version: updated.version };
}


/**
 * `POST /sessions/{id}/release` (docs/arquitetura.md §6.3): libera sem gravar, chamado pelo
 * caminho de erro do workflow. **Sempre idempotente** — mesmo se a trava já não existir mais
 * (venceu, ou já foi liberada), devolve `200` sem erro; só falha (404) se a sessão não for desta
 * instância.
 *
 * Rede de segurança (spec §3.11, BUG-04): se a trava liberada ERA a da execução que morreu, o
 * cliente ficou sem resposta — avisa com `TECH_ERROR`, no máximo 1x a cada 10 min. A liberação da
 * trava e o registro do eco (hash em `recentOutbound`) são UMA escrita condicionada ao `lockToken`:
 * duas chamadas simultâneas nunca avisam duas vezes, e o `fromMe` do nosso próprio envio não pausa
 * o bot. Falha no envio nunca vira 5xx: `notified: false`.
 */
export async function releaseSession(ctx: InternalApiContext, sessionId: string, lockToken: string, opts: { notify?: boolean } = {}) {
  const session = await loadOwnedSession(ctx, sessionId);

  if (session.lockToken !== lockToken) {
    // Já foi liberada, ou a trava é de outra execução (venceu e outra pegou) — idempotente por
    // design: não é erro do chamador, é exatamente o cenário que este endpoint existe para
    // cobrir sem risco.
    return { released: true as const, notified: false };
  }

  const prisma = getPrisma();
  const now = new Date();
  const plan = opts.notify === false ? null : await planTechErrorNotice(ctx, session, now);

  const freed = await prisma.chatSession.updateMany({
    where: { id: sessionId, lockToken },
    data: {
      lockToken: null,
      lockedUntil: null,
      ...(plan ? { recentOutbound: appendRecentOutbound(session.recentOutbound, [plan.text], now) } : {}),
    },
  });
  // Outra chamada de release com o mesmo token venceu a corrida: ela cuida do aviso.
  if (!plan || freed.count === 0) return { released: true as const, notified: false };

  const notified = await sendTechError(ctx, session, plan.text, plan.waJid);
  return { released: true as const, notified };
}

/** Decide se o aviso cabe: devolve o texto e o destino, ou `null` (sem aviso). Só leituras. */
async function planTechErrorNotice(
  ctx: InternalApiContext,
  session: { id: string; contactId: string; state: string; lastInboundAt: Date },
  now: Date,
): Promise<{ text: string; waJid: string } | null> {
  if (session.state === "HUMAN") return null;
  if (now.getTime() - session.lastInboundAt.getTime() > TECH_ERROR_MAX_INBOUND_AGE_MS) return null;

  const prisma = getPrisma();
  const contact = await prisma.contact.findFirst({ where: { id: session.contactId, tenantId: ctx.tenantId }, select: { waJid: true, botPausedUntil: true } });
  if (!contact) return null;
  if (contact.botPausedUntil && contact.botPausedUntil > now) return null;
  if (!(await isTenantBotAllowed(ctx.tenantId))) return null;

  const text = (await getMergedBotTexts(ctx.tenantId, 2)).TECH_ERROR;
  // O `recentOutbound` é podado em 2 min: a janela de 10 min vem do histórico. O corpo é comparado
  // como foi gravado (`sanitizeChatBody`), senão um texto editado com espaços nunca bateria.
  const body = sanitizeChatBody(text);
  const recent = await prisma.chatMessage.findFirst({
    where: {
      tenantId: ctx.tenantId,
      contactId: session.contactId,
      whatsappInstanceId: ctx.instance.id,
      direction: "OUTBOUND",
      body,
      createdAt: { gt: new Date(now.getTime() - TECH_ERROR_COOLDOWN_MS) },
    },
    select: { id: true },
  });
  if (recent) return null;

  return { text, waJid: contact.waJid };
}

/** Envia o aviso (outbox na instância sandbox, Evolution nas demais) e o registra no histórico. */
async function sendTechError(
  ctx: InternalApiContext,
  session: { id: string; contactId: string },
  text: string,
  waJid: string,
): Promise<boolean> {
  try {
    let providerMessageId: string | null = null;
    if (ctx.instance.sandbox) {
      pushSandboxOutbox(ctx, session.id, [text]);
    } else {
      const evolution = await getEvolutionClient();
      ({ messageId: providerMessageId } = await evolution.sendText(ctx.instance.instanceName, digitsFromJid(waJid), text));
    }
    await logChatMessage({
      tenantId: ctx.tenantId,
      whatsappInstanceId: ctx.instance.id,
      contactId: session.contactId,
      direction: "OUTBOUND",
      body: text,
      providerMessageId,
    });
    logger.info("session.release.tech_error_sent", { tenantId: ctx.tenantId, sessionId: session.id, sandbox: ctx.instance.sandbox });
    return true;
  } catch (error) {
    // Nunca o corpo da mensagem nem `error.message` (a Evolution pode ecoar o texto).
    logger.warn("session.release.tech_error_failed", {
      tenantId: ctx.tenantId,
      sessionId: session.id,
      errorName: error instanceof Error ? error.constructor?.name || error.name : "unknown",
    });
    return false;
  }
}
