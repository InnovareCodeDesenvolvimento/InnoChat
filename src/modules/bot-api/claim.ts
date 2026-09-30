import { createHash, randomUUID } from "node:crypto";
import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import type { InboundIgnoreReason } from "@/lib/db/types";
import { normalizeEvolutionMessage, resolveSenderIdentity, digitsFromJid, type NormalizedMessage } from "@/core/bot/evolution-normalize";
import { formatInTimeZone } from "date-fns-tz";
import { lastBookableISO } from "./booking-bot";
import { normalizeText } from "@/core/bot/engine/normalize";
import { firstNameForGreeting, formatLeadLabel, formatWhenLabel } from "@/core/bot/format";
import { computeTenantTeamOpening } from "@/modules/agenda/team-hours-loader";
import { getMergedBotTexts } from "@/modules/bot-texts/service";
import { closeOpenHandoff, findOpenHandoff, markHandoffAnswered } from "./handoff";
import { contactHasBusinessRelation, logChatMessage } from "@/modules/conversations/log";
import { isTenantBotAllowed } from "./subscription-gate";
import type { InternalApiContext } from "./internal-auth";

const LEASE_MS = 20_000;
const STALE_MS = 5 * 60 * 1000;
const ECHO_WINDOW_MS = 2 * 60 * 1000;
const RECENT_OUTBOUND_MAX = 20;
/** `session.previous` só existe se a sessão expirou há no máximo isto (spec §2.7). */
const PREVIOUS_MAX_IDLE_MS = 24 * 60 * 60 * 1000;

/**
 * "menu" ou "0" (normalizados) — os únicos textos que devolvem o cliente ao bot durante o atendente.
 * `normalizeText` corta a entrada em 4000 caracteres antes de qualquer regex (Órion I1).
 */
function isMenuCommand(content: NormalizedMessage["content"]): boolean {
  if (content.type !== "text") return false;
  const t = normalizeText(content.text);
  return t === "menu" || t === "0";
}

export type ClaimProcessResult = {
  action: "process";
  inboundEventId: string;
  instance: { name: string; sandbox: boolean };
  to: string;
  message: { type: "text"; text: string } | { type: "media" };
  contact: { id: string; name: string | null; pushName: string | null };
  session: {
    id: string;
    state: string;
    context: unknown;
    invalidCount: number;
    version: number;
    lockToken: string;
    expired: boolean;
  };
  tenant: { name: string; askProfessional: boolean; timezone: string };
  texts: Record<string, string>;
};

export type ResumedFromHuman = "CLIENT_MENU" | "TIMEOUT";

/** Resposta `process` com `X-InnoChat-Flow: 2` (docs/bot-v2-plano.md §3.4, bloco B-2). */
export type ClaimProcessResultV2 = Omit<ClaimProcessResult, "contact" | "session" | "tenant"> & {
  flow: 2;
  contact: ClaimProcessResult["contact"] & { firstName: string | null };
  session: ClaimProcessResult["session"] & {
    previous: { state: string; context: unknown; idleMin: number } | null;
    resumedFromHuman: ResumedFromHuman | null;
  };
  tenant: ClaimProcessResult["tenant"] & {
    today: string;
    nowLocal: string;
    openNow: boolean;
    teamNextOpenLabel: string | null;
    handoffUntilLabel: string;
    changeLeadLabel: string;
    lastBookableDate: string;
    slotGranularityMin: number;
  };
};

export type ClaimResult =
  | ClaimProcessResult
  | ClaimProcessResultV2
  | { action: "busy"; retryAfterMs: number }
  | { action: "ignore"; reason: InboundIgnoreReason | "UNSUPPORTED_EVENT" | "GROUP" };

/**
 * `upsert` do Prisma não é atômico: duas execuções do MESMO cliente chegando juntas na 1ª mensagem
 * disputam o INSERT e a perdedora leva P2002. Uma nova tentativa já encontra a linha e só atualiza.
 */
async function upsertOnce<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return run();
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function isRecentOutboundEcho(recentOutbound: unknown, content: NormalizedMessage["content"], now: Date): boolean {
  if (content.type !== "text") return false;
  if (!Array.isArray(recentOutbound)) return false;
  const hash = sha256Hex(content.text);
  return recentOutbound.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as { hash?: unknown; at?: unknown };
    if (e.hash !== hash || typeof e.at !== "string") return false;
    const at = new Date(e.at).getTime();
    return Number.isFinite(at) && now.getTime() - at <= ECHO_WINDOW_MS;
  });
}

/** Mantém só as saídas dos últimos `ECHO_WINDOW_MS`, cortado por tamanho — usado por `session.ts` ao salvar `outbound`. */
export function appendRecentOutbound(recentOutbound: unknown, texts: string[], now: Date): { hash: string; at: string }[] {
  const previous = Array.isArray(recentOutbound) ? (recentOutbound as { hash?: unknown; at?: unknown }[]) : [];
  const kept = previous
    .filter((e) => typeof e.hash === "string" && typeof e.at === "string" && now.getTime() - new Date(e.at as string).getTime() <= ECHO_WINDOW_MS)
    .map((e) => ({ hash: e.hash as string, at: e.at as string }));
  const added = texts.map((t) => ({ hash: sha256Hex(t), at: now.toISOString() }));
  return [...kept, ...added].slice(-RECENT_OUTBOUND_MAX);
}

/**
 * `POST /messages/claim` (docs/arquitetura.md §6.2): normaliza o payload da Evolution,
 * deduplica, resolve o remetente (inclusive `@lid`), adquire a trava (lease de 20s) da sessão,
 * avalia expiração/modo humano/eco/assinatura, e devolve tudo que o n8n precisa para decidir o
 * próximo passo. NUNCA lança para payload irreconhecível — sempre `ignore`.
 */
export async function claimMessage(ctx: InternalApiContext, rawPayload: unknown, opts: { flow?: 1 | 2 } = {}): Promise<ClaimResult> {
  const flow = opts.flow ?? 1;
  const prisma = getPrisma();
  const now = new Date();

  const normalized = normalizeEvolutionMessage(rawPayload);
  if (normalized.kind === "unsupported") {
    return { action: "ignore", reason: normalized.reason };
  }

  // Dedupe (docs/arquitetura.md §2 regra 1) — caminho rápido; a constraint única no banco é o
  // backstop final contra corrida (ver isUniqueViolation abaixo).
  const existing = await prisma.inboundEvent.findUnique({
    where: { whatsappInstanceId_providerMessageId: { whatsappInstanceId: ctx.instance.id, providerMessageId: normalized.providerMessageId } },
  });
  if (existing) {
    return { action: "ignore", reason: "DUPLICATE" };
  }

  const identity = resolveSenderIdentity(normalized);
  let contact = identity.waJid
    ? await prisma.contact.findFirst({ where: { tenantId: ctx.tenantId, waJid: identity.waJid } })
    : await prisma.contact.findFirst({ where: { tenantId: ctx.tenantId, lid: identity.lid ?? undefined } });

  if (!identity.waJid && !contact) {
    return recordSimpleIgnore(ctx, normalized.providerMessageId, "UNRESOLVABLE_SENDER");
  }

  // Mensagem enviada PELO dono do número (fromMe) para alguém que NUNCA falou com o número é conversa
  // pessoal: não cria Contato, sessão nem histórico. (Motivo registrado como FROM_ME_ECHO — "saída
  // nossa, nada a processar"; não existe um motivo próprio e o enum não muda sem migration.)
  if (normalized.fromMe && !contact) {
    return recordSimpleIgnore(ctx, normalized.providerMessageId, "FROM_ME_ECHO");
  }

  const waJid = identity.waJid ?? contact!.waJid;
  contact = await upsertOnce(() =>
    prisma.contact.upsert({
      where: { tenantId_waJid: { tenantId: ctx.tenantId, waJid } },
      update: {
        ...(normalized.pushName ? { pushName: normalized.pushName } : {}),
        ...(identity.lid ? { lid: identity.lid } : {}),
      },
      create: { tenantId: ctx.tenantId, waJid, lid: identity.lid, pushName: normalized.pushName },
    }),
  );

  // Sessão + trava (lease de 20s, docs/arquitetura.md §2 regra 2). `update: {}` no upsert é
  // proposital: não toca `lastInboundAt` numa sessão já existente, para podermos comparar contra
  // o valor ANTERIOR (detectar expiração) antes de gravar o novo abaixo.
  const contactId = contact.id;
  const session = await upsertOnce(() =>
    prisma.chatSession.upsert({
      where: { whatsappInstanceId_contactId: { whatsappInstanceId: ctx.instance.id, contactId } },
      update: {},
      create: { whatsappInstanceId: ctx.instance.id, contactId, state: "MAIN_MENU", lastInboundAt: now },
    }),
  );

  const lockToken = randomUUID();
  const leaseResult = await prisma.chatSession.updateMany({
    where: { id: session.id, OR: [{ lockToken: null }, { lockedUntil: { lt: now } }] },
    data: { lockToken, lockedUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (leaseResult.count === 0) {
    // Trava de outra execução — nada foi gravado (docs/arquitetura.md §2 regra 2).
    return { action: "busy", retryAfterMs: 1500 };
  }

  const locked = await prisma.chatSession.findUniqueOrThrow({ where: { id: session.id } });
  const stateBefore = locked.state;
  // Captura fora do closure: `normalized` é `NormalizedMessage` neste ponto (já retornamos para
  // `unsupported` acima), mas o TypeScript não propaga esse estreitamento para dentro de uma
  // `function` aninhada — capturar o campo primitivo evita o erro sem precisar de asserção.
  const providerMessageId = normalized.providerMessageId;

  // Histórico de conversas (90 dias): grava TODA mensagem de texto/mídia do cliente que passou
  // pela trava — inclusive as que o bot vai ignorar (pausado, modo humano, assinatura suspensa) —
  // e as que a própria empresa digitou no celular (fromMe que não é eco do bot). Dedup por
  // providerMessageId; falha aqui nunca derruba o claim (`logChatMessage` não lança).
  const chatBody = normalized.content.type === "text" ? normalized.content.text : normalized.content.label;
  if (!normalized.fromMe) {
    await logChatMessage({
      tenantId: ctx.tenantId,
      whatsappInstanceId: ctx.instance.id,
      contactId: contact.id,
      direction: "INBOUND",
      body: chatBody,
      providerMessageId,
    });
  } else if (
    !isRecentOutboundEcho(locked.recentOutbound, normalized.content, now) &&
    (await contactHasBusinessRelation(ctx.tenantId, contact.id))
  ) {
    await logChatMessage({
      tenantId: ctx.tenantId,
      whatsappInstanceId: ctx.instance.id,
      contactId: contact.id,
      direction: "OUTBOUND",
      body: chatBody,
      providerMessageId,
    });
  }

  async function finishIgnore(reason: InboundIgnoreReason): Promise<ClaimResult> {
    try {
      await prisma.$transaction([
        prisma.chatSession.update({ where: { id: session.id }, data: { lockToken: null, lockedUntil: null } }),
        prisma.inboundEvent.create({
          data: {
            whatsappInstanceId: ctx.instance.id,
            providerMessageId,
            outcome: "IGNORE",
            reason,
            stateBefore,
            stateAfter: stateBefore,
          },
        }),
      ]);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Corrida rara: outra execução para o MESMO providerMessageId já gravou o InboundEvent
      // entre o dedupe rápido e agora. Libera a trava que acabamos de adquirir e devolve
      // DUPLICATE — nunca deixa a sessão travada por isso.
      await prisma.chatSession.update({ where: { id: session.id }, data: { lockToken: null, lockedUntil: null } });
      return { action: "ignore", reason: "DUPLICATE" };
    }
    return { action: "ignore", reason };
  }

  if (contact.botPausedUntil && contact.botPausedUntil > now) {
    return finishIgnore("BOT_PAUSED");
  }

  // Atendente pedido pelo cliente (spec §3.10): só há pedido aberto em sessões que o v2 (ou o v1 via
  // LEGACY_FLOW) colocou em HUMAN; lido só quando importa (estado HUMAN ou fromMe).
  const openHandoff = locked.state === "HUMAN" || normalized.fromMe ? await findOpenHandoff(session.id) : null;
  let resumedFromHuman: ResumedFromHuman | null = null;

  // Regra 3: a equipe respondeu pelo celular (fromMe que não é eco do bot) com pedido aberto →
  // estende a pausa da SESSÃO (não do contato) e marca a 1ª resposta. Vem ANTES do teste de HUMAN_MODE.
  if (normalized.fromMe && openHandoff && !isRecentOutboundEcho(locked.recentOutbound, normalized.content, now)) {
    const pause = await prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { humanPauseMin: true } });
    const extendedUntil = new Date(now.getTime() + pause.humanPauseMin * 60_000);
    try {
      await prisma.$transaction(async (tx) => {
        await tx.chatSession.update({ where: { id: session.id }, data: { state: "HUMAN", humanUntil: extendedUntil, lockToken: null, lockedUntil: null } });
        await markHandoffAnswered(tx, openHandoff.id, now);
        await tx.inboundEvent.create({
          data: { whatsappInstanceId: ctx.instance.id, providerMessageId, outcome: "IGNORE", reason: "HUMAN_TOOK_OVER", stateBefore, stateAfter: "HUMAN" },
        });
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await prisma.chatSession.update({ where: { id: session.id }, data: { lockToken: null, lockedUntil: null } });
      return { action: "ignore", reason: "DUPLICATE" };
    }
    return { action: "ignore", reason: "HUMAN_TOOK_OVER" };
  }

  if (locked.state === "HUMAN" && locked.humanUntil && locked.humanUntil > now) {
    // Regra 1: "menu"/"0" do cliente encerra um pedido feito por ele (CLIENT_REQUEST) e devolve o bot
    // na mesma mensagem. Qualquer outra coisa — e qualquer pedido LEGACY_FLOW — segue ignorada.
    if (!normalized.fromMe && openHandoff?.reason === "CLIENT_REQUEST" && isMenuCommand(normalized.content)) {
      resumedFromHuman = "CLIENT_MENU";
    } else {
      return finishIgnore("HUMAN_MODE");
    }
  } else if (locked.state === "HUMAN" && openHandoff && !normalized.fromMe) {
    // Regra 2: o prazo do atendente venceu sem "menu": a próxima mensagem já é de sessão nova.
    resumedFromHuman = "TIMEOUT";
  }

  if (normalized.fromMe) {
    if (isRecentOutboundEcho(locked.recentOutbound, normalized.content, now)) {
      return finishIgnore("FROM_ME_ECHO");
    }

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
    const humanUntil = new Date(now.getTime() + tenant.humanPauseMin * 60_000);
    try {
      await prisma.$transaction([
        prisma.chatSession.update({
          where: { id: session.id },
          data: { state: "HUMAN", humanUntil, lockToken: null, lockedUntil: null },
        }),
        prisma.contact.update({ where: { id: contact.id }, data: { botPausedUntil: humanUntil } }),
        prisma.inboundEvent.create({
          data: {
            whatsappInstanceId: ctx.instance.id,
            providerMessageId,
            outcome: "IGNORE",
            reason: "HUMAN_TOOK_OVER",
            stateBefore,
            stateAfter: "HUMAN",
          },
        }),
      ]);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await prisma.chatSession.update({ where: { id: session.id }, data: { lockToken: null, lockedUntil: null } });
      return { action: "ignore", reason: "DUPLICATE" };
    }
    return { action: "ignore", reason: "HUMAN_TOOK_OVER" };
  }

  if (!(await isTenantBotAllowed(ctx.tenantId))) {
    return finishIgnore("TENANT_SUSPENDED");
  }

  if (now.getTime() - normalized.timestampMs > STALE_MS) {
    return finishIgnore("STALE");
  }

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
  const resumed = resumedFromHuman !== null;
  const idleMs = now.getTime() - locked.lastInboundAt.getTime();
  // Quem volta do atendente entra como sessão nova por decisão do painel, não por inatividade.
  const expired = resumed ? false : idleMs > tenant.sessionTimeoutMin * 60_000;
  const resets = expired || resumed;

  const effectiveState = resets ? "MAIN_MENU" : locked.state;
  const effectiveContext = resets ? {} : locked.context;
  const effectiveInvalidCount = resets ? 0 : locked.invalidCount;

  let inboundEventId: string;
  try {
    const created = await prisma.$transaction(async (tx) => {
      await tx.chatSession.update({
        where: { id: session.id },
        data: {
          lastInboundAt: now,
          ...(resets ? { state: "MAIN_MENU", context: {}, invalidCount: 0 } : {}),
          ...(resumed ? { humanUntil: null } : {}),
        },
      });
      if (resumedFromHuman) await closeOpenHandoff(tx, session.id, resumedFromHuman, now);
      return tx.inboundEvent.create({
        data: {
          whatsappInstanceId: ctx.instance.id,
          providerMessageId,
          outcome: "PROCESS",
          stateBefore,
          stateAfter: effectiveState,
        },
      });
    });
    inboundEventId = created.id;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await prisma.chatSession.update({ where: { id: session.id }, data: { lockToken: null, lockedUntil: null } });
    return { action: "ignore", reason: "DUPLICATE" };
  }

  const base: ClaimProcessResult = {
    action: "process",
    inboundEventId,
    instance: { name: ctx.instance.instanceName, sandbox: ctx.instance.sandbox },
    to: digitsFromJid(waJid),
    message: normalized.content.type === "text" ? { type: "text", text: normalized.content.text } : { type: "media" },
    contact: { id: contact.id, name: contact.name, pushName: contact.pushName },
    session: {
      id: session.id,
      state: effectiveState,
      context: effectiveContext,
      invalidCount: effectiveInvalidCount,
      version: locked.version,
      lockToken,
      expired,
    },
    tenant: { name: tenant.name, askProfessional: tenant.askProfessional, timezone: tenant.timezone },
    texts: {},
  };

  if (flow !== 2) {
    return { ...base, texts: await getMergedBotTexts(ctx.tenantId) };
  }

  const [texts, opening] = await Promise.all([getMergedBotTexts(ctx.tenantId, 2), computeTenantTeamOpening(tenant, now)]);
  const todayISO = formatInTimeZone(now, tenant.timezone, "yyyy-MM-dd");
  const previous =
    expired && idleMs <= PREVIOUS_MAX_IDLE_MS && locked.state !== "HUMAN"
      ? { state: locked.state, context: locked.context, idleMin: Math.floor(idleMs / 60_000) }
      : null;

  return {
    ...base,
    flow: 2,
    contact: { ...base.contact, firstName: firstNameForGreeting(contact.name, contact.pushName) },
    session: { ...base.session, previous, resumedFromHuman },
    tenant: {
      ...base.tenant,
      today: todayISO,
      nowLocal: formatInTimeZone(now, tenant.timezone, "HH:mm"),
      openNow: opening.openNow,
      teamNextOpenLabel: opening.nextOpenAt ? formatWhenLabel(opening.nextOpenAt, now, tenant.timezone) : null,
      handoffUntilLabel: formatWhenLabel(new Date(now.getTime() + tenant.handoffResumeMinutes * 60_000), now, tenant.timezone),
      changeLeadLabel: formatLeadLabel(tenant.cancelMinLeadMin),
      lastBookableDate: lastBookableISO(todayISO, tenant.maxHorizonDays),
      slotGranularityMin: tenant.slotGranularityMin,
    },
    texts,
  };
}

/**
 * Caminho de `UNRESOLVABLE_SENDER`: acontece ANTES de existir um `Contact`/`ChatSession` (não há
 * o que resolver), então só tenta registrar o `InboundEvent` de auditoria — sem trava para
 * liberar. Dedupe da própria corrida cai em `P2002` e é absorvido silenciosamente (o resultado
 * para o n8n é o mesmo `ignore` de qualquer forma).
 */
async function recordSimpleIgnore(ctx: InternalApiContext, providerMessageId: string, reason: InboundIgnoreReason): Promise<ClaimResult> {
  try {
    await getPrisma().inboundEvent.create({
      data: { whatsappInstanceId: ctx.instance.id, providerMessageId, outcome: "IGNORE", reason },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  return { action: "ignore", reason };
}
