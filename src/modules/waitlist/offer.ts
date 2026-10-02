import { addMinutes } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";
import { formatDayLabel, formatLeadLabel, formatLongDayLabel, formatTimeLabel } from "@/core/bot/format";
import { renderTemplate } from "@/core/bot/texts";
import { isInsideSendWindow, reminderFirstName } from "@/core/reminders/window";
import {
  WAITLIST_MAX_CANDIDATES_PER_TRIGGER,
  WAITLIST_OFFER_MINUTES,
  isoToDesiredDate,
} from "@/core/waitlist/match";
import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { sendTextToContact, type OutboundResult } from "@/modules/attendance/outbound";
import { isTenantBotAllowed } from "@/modules/bot-api/subscription-gate";
import { getMergedBotTexts } from "@/modules/bot-texts/service";
import type { EvolutionClient } from "@/modules/whatsapp/evolution-client";
import { eligibleProfessionalIds, findSlotForEntry, type TenantRules } from "./slots";

/**
 * Oferta de horário da lista de espera (melhoria 7). Quando um horário abre, o primeiro da fila
 * compatível recebe a oferta por WhatsApp, com prazo. A reserva da oferta é uma troca condicional
 * de status (`WAITING` -> `OFFERED` por `updateMany`): duas ofertas simultâneas disputam a mesma linha
 * e o índice único parcial impede o mesmo horário de ir a duas pessoas (P2002 vira "perdeu a vez").
 */

export type WaitlistDeps = { evolution?: EvolutionClient; now?: Date };

/** Horário que ficou livre: profissional e o intervalo `[from, to)` que a agenda liberou. */
export type FreedSlot = { professionalId: string; from: Date; to: Date };

let injectedDeps: WaitlistDeps = {};
/** Só para testes: injeta Evolution falsa e relógio nos gatilhos que rodam sem receber `deps`. */
export function setWaitlistDepsForTests(deps: WaitlistDeps): void {
  injectedDeps = deps;
}

function depsOf(deps?: WaitlistDeps): WaitlistDeps {
  return { ...injectedDeps, ...(deps ?? {}) };
}

type EntryRow = {
  id: string;
  contactId: string;
  serviceId: string;
  professionalId: string | null;
  desiredDate: Date;
  period: string;
  windowStartMin: number | null;
  windowEndMin: number | null;
};

type ReserveResult = "SENT" | "NOT_RESERVED" | "SEND_FAILED" | "NO_WHATSAPP" | "NO_PHONE" | "BUSY" | "RATE_LIMITED";

async function loadTenantRules(tenantId: string) {
  return getPrisma().tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { name: true, timezone: true, slotGranularityMin: true, minLeadTimeMin: true, maxHorizonDays: true },
  });
}

/** Devolve a entrada de `OFFERED` para `WAITING` (só se ainda for a NOSSA oferta), sem mexer na posição na fila. */
async function releaseOffer(tenantId: string, entryId: string, offeredAt: Date): Promise<void> {
  await forTenant(tenantId).waitlistEntry.updateMany({
    where: { id: entryId, status: "OFFERED", offeredAt },
    data: { status: "WAITING", offeredSlotStart: null, offeredProfessionalId: null, offeredAt: null, offerExpiresAt: null },
  });
}

function outcomeToResult(outcome: OutboundResult["outcome"]): ReserveResult {
  switch (outcome) {
    case "SENT":
      return "SENT";
    case "NO_WHATSAPP":
      return "NO_WHATSAPP";
    case "NO_PHONE":
      return "NO_PHONE";
    case "BUSY":
      return "BUSY";
    case "RATE_LIMITED":
      return "RATE_LIMITED";
    default:
      return "SEND_FAILED";
  }
}

/** Reserva o horário para a entrada e manda a oferta. Falhou o envio, devolve a entrada à fila. */
async function reserveAndSend(params: {
  tenantId: string;
  tenant: { name: string; timezone: string };
  entry: EntryRow;
  slot: { professionalId: string; startsAt: Date };
  now: Date;
  evolution?: EvolutionClient;
}): Promise<ReserveResult> {
  const { tenantId, entry, slot, now } = params;
  const db = forTenant(tenantId);
  const expiresAt = addMinutes(now, WAITLIST_OFFER_MINUTES);

  try {
    const reserved = await db.waitlistEntry.updateMany({
      where: { id: entry.id, status: "WAITING" },
      data: {
        status: "OFFERED",
        offeredSlotStart: slot.startsAt,
        offeredProfessionalId: slot.professionalId,
        offeredAt: now,
        offerExpiresAt: expiresAt,
      },
    });
    if (reserved.count === 0) return "NOT_RESERVED"; // outra rodada, o cliente ou o painel levou a vez
  } catch (error) {
    // Índice único parcial: este horário já está oferecido a outra pessoa.
    if (isUniqueViolation(error)) return "NOT_RESERVED";
    throw error;
  }

  try {
    const [row, texts] = await Promise.all([
      db.waitlistEntry.findFirstOrThrow({
        where: { id: entry.id },
        include: {
          contact: { select: { name: true, pushName: true } },
          service: { select: { name: true } },
          offeredProfessional: { select: { name: true } },
        },
      }),
      getMergedBotTexts(tenantId, 2),
    ]);
    const text = renderTemplate(texts.WAITLIST_OFFER, {
      nome: reminderFirstName(row.contact.name, row.contact.pushName),
      empresa: params.tenant.name,
      servico: row.service.name,
      profissional: row.offeredProfessional?.name ?? "a equipe",
      data: formatDayLabel(slot.startsAt, params.tenant.timezone),
      data_longa: formatLongDayLabel(slot.startsAt, params.tenant.timezone),
      hora: formatTimeLabel(slot.startsAt, params.tenant.timezone),
      prazo: formatLeadLabel(WAITLIST_OFFER_MINUTES),
    });
    const sent = await sendTextToContact({ tenantId, contactId: entry.contactId, text, evolution: params.evolution });
    if (sent.outcome === "SENT") {
      logger.info("waitlist.offer_sent", { tenantId, entryId: entry.id });
      return "SENT";
    }
    logger.warn("waitlist.offer_not_sent", { tenantId, entryId: entry.id, outcome: sent.outcome });
    await releaseOffer(tenantId, entry.id, now);
    return outcomeToResult(sent.outcome);
  } catch (error) {
    await releaseOffer(tenantId, entry.id, now).catch(() => undefined);
    logger.error("waitlist.offer_failed", { tenantId, entryId: entry.id, errorName: error instanceof Error ? error.name : "unknown" });
    return "SEND_FAILED";
  }
}

/** Dias (locais) que o intervalo liberado toca: no máximo dois. */
function localDaysTouched(from: Date, to: Date, timezone: string): string[] {
  const first = formatInTimeZone(from, timezone, "yyyy-MM-dd");
  const last = formatInTimeZone(new Date(Math.max(from.getTime(), to.getTime() - 1)), timezone, "yyyy-MM-dd");
  return first === last ? [first] : [first, last];
}

export type OfferSummary = { offeredEntryId: string | null; tried: number; deferredQuietHours?: boolean };

/**
 * Um horário abriu: acha o primeiro da fila compatível (serviço, profissional, dia, janela e duração
 * que cabe) e oferece. Quem não pode receber agora (bot pausado, atendente na conversa, WhatsApp
 * fora) é pulado sem perder a vez. Nunca lança por falha de envio.
 */
export async function offerFreedSlot(
  tenantId: string,
  freed: FreedSlot,
  options: { excludeEntryIds?: string[]; deps?: WaitlistDeps } = {},
): Promise<OfferSummary> {
  const deps = depsOf(options.deps);
  const now = deps.now ?? new Date();
  const summary: OfferSummary = { offeredEntryId: null, tried: 0 };

  if (!(await isTenantBotAllowed(tenantId))) return summary;
  const tenant = await loadTenantRules(tenantId);
  // Janela de silêncio (a mesma do lembrete: 08h às 21h no fuso da empresa). Fora dela a oferta automática não sai e a
  // fila espera: quando a janela abre, `offerToWaitingInOpenWindow` (no tick) oferece o que ainda estiver livre e futuro.
  if (!isInsideSendWindow(now, tenant.timezone)) {
    logger.info("waitlist.offer_deferred_quiet_hours", { tenantId });
    summary.deferredQuietHours = true;
    await markQuietDeferral(tenantId);
    return summary;
  }
  const days = localDaysTouched(freed.from, freed.to, tenant.timezone).map(isoToDesiredDate);

  const db = forTenant(tenantId);
  const candidates = await db.waitlistEntry.findMany({
    where: {
      status: "WAITING",
      desiredDate: { in: days },
      OR: [{ professionalId: null }, { professionalId: freed.professionalId }],
      ...(options.excludeEntryIds?.length ? { id: { notIn: options.excludeEntryIds } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 100,
    include: {
      service: { select: { active: true, durationMin: true, bufferAfterMin: true } },
      contact: {
        select: {
          botPausedUntil: true,
          chatSessions: { where: { humanUntil: { gt: now } }, select: { id: true } },
          waitlistEntries: { where: { status: "OFFERED", offerExpiresAt: { gt: now } }, select: { id: true } },
        },
      },
    },
  });
  if (candidates.length === 0) return summary;

  const linkedCache = new Map<string, boolean>();
  async function professionalDoesService(serviceId: string): Promise<boolean> {
    const cached = linkedCache.get(serviceId);
    if (cached !== undefined) return cached;
    const ids = await eligibleProfessionalIds(tenantId, serviceId);
    const ok = ids.includes(freed.professionalId);
    linkedCache.set(serviceId, ok);
    return ok;
  }

  for (const entry of candidates) {
    if (summary.tried >= WAITLIST_MAX_CANDIDATES_PER_TRIGGER) break;
    if (!entry.service.active) continue;
    const { contact } = entry;
    if ((contact.botPausedUntil && contact.botPausedUntil > now) || contact.chatSessions.length > 0) continue;
    if (contact.waitlistEntries.length > 0) continue; // já tem uma oferta aberta: espera a resposta
    if (!(await professionalDoesService(entry.serviceId))) continue;

    const slot = await findSlotForEntry({
      tenantId,
      tenant: tenant as TenantRules,
      entry,
      service: entry.service,
      candidateProfessionalIds: [freed.professionalId],
      freed: { from: freed.from, to: freed.to },
      now,
    });
    if (!slot) continue;

    summary.tried += 1;
    const result = await reserveAndSend({ tenantId, tenant, entry, slot, now, evolution: deps.evolution });
    if (result === "SENT") {
      summary.offeredEntryId = entry.id;
      return summary;
    }
    if (result === "NO_WHATSAPP") return summary; // sem número conectado ninguém da fila recebe
  }
  return summary;
}

type AutoCandidate = {
  contact: { botPausedUntil: Date | null; chatSessions: { id: string }[]; waitlistEntries: { id: string }[] };
};

/** Quem não pode receber uma oferta AUTOMÁTICA agora (bot pausado, atendente na conversa, oferta já aberta) é pulado sem perder a vez. */
function skipForAutoOffer(entry: AutoCandidate, now: Date): boolean {
  const { contact } = entry;
  if (contact.botPausedUntil && contact.botPausedUntil > now) return true;
  if (contact.chatSessions.length > 0) return true;
  return contact.waitlistEntries.length > 0;
}

const WINDOW_SCAN_TENANTS = 200;
const WINDOW_SCAN_ENTRIES_PER_TENANT = 50;

/**
 * Marca "esta empresa liberou horário na janela de silêncio e a oferta ficou para depois". Uma linha por empresa em
 * `ProviderEvent` (estado auxiliar global, sem tabela nova); o tick consome a marca quando a janela abre. `createMany` com
 * `skipDuplicates` torna a marcação idempotente e livre de corrida.
 */
const DEFERRAL_PROVIDER = "waitlist-deferred";

async function markQuietDeferral(tenantId: string): Promise<void> {
  try {
    await getPrisma().providerEvent.createMany({ data: [{ provider: DEFERRAL_PROVIDER, providerEventId: tenantId, payload: {} }], skipDuplicates: true });
  } catch (error) {
    logger.error("waitlist.deferral_mark_failed", { tenantId, errorName: error instanceof Error ? error.name : "unknown" });
  }
}

export type WindowOfferSummary = { tenantsScanned: number; offered: number };

/**
 * Tick: recupera as ofertas adiadas pela janela de silêncio. Só olha empresas com a marca de adiamento
 * (`markQuietDeferral`) e só quando a janela de envio está ABERTA nelas (08h às 21h locais); então oferece a quem ficou
 * esperando os horários que ainda estão livres e futuros, em ordem de chegada. A marca é tomada ANTES de varrer (uma
 * rodada concorrente não duplica; um adiamento novo durante a varredura cria outra marca). Cada pessoa recebe no máximo
 * uma oferta por rodada e o mesmo horário nunca vai a duas pessoas (a oferta em aberto segura o horário e o índice único
 * do banco confirma). Não mexe em quem está em atendimento humano ou com o bot pausado.
 */
export async function offerToWaitingInOpenWindow(now: Date = new Date(), deps?: WaitlistDeps): Promise<WindowOfferSummary> {
  const d = depsOf(deps);
  const clock = d.now ?? now;
  const summary: WindowOfferSummary = { tenantsScanned: 0, offered: 0 };
  const prisma = getPrisma();

  const marks = await prisma.providerEvent.findMany({
    where: { provider: DEFERRAL_PROVIDER },
    orderBy: { createdAt: "asc" },
    take: WINDOW_SCAN_TENANTS,
    select: { id: true, providerEventId: true },
  });

  for (const mark of marks) {
    const tenantId = mark.providerEventId;
    try {
      const tenant = await loadTenantRules(tenantId).catch(() => null);
      if (!tenant) {
        await prisma.providerEvent.deleteMany({ where: { id: mark.id } }); // empresa apagada
        continue;
      }
      if (!isInsideSendWindow(clock, tenant.timezone)) continue; // a marca fica para quando a janela abrir
      // Toma a marca: só quem apagou a linha varre.
      const claimed = await prisma.providerEvent.deleteMany({ where: { id: mark.id } });
      if (claimed.count === 0) continue;
      summary.tenantsScanned += 1;
      if (!(await isTenantBotAllowed(tenantId))) continue;

      const today = isoToDesiredDate(formatInTimeZone(clock, tenant.timezone, "yyyy-MM-dd"));
      const entries = await forTenant(tenantId).waitlistEntry.findMany({
        where: { status: "WAITING", desiredDate: { gte: today } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: WINDOW_SCAN_ENTRIES_PER_TENANT,
        include: {
          service: { select: { active: true, durationMin: true, bufferAfterMin: true } },
          contact: {
            select: {
              botPausedUntil: true,
              chatSessions: { where: { humanUntil: { gt: clock } }, select: { id: true } },
              waitlistEntries: { where: { status: "OFFERED", offerExpiresAt: { gt: clock } }, select: { id: true } },
            },
          },
        },
      });

      let tried = 0;
      for (const entry of entries) {
        if (tried >= WAITLIST_MAX_CANDIDATES_PER_TRIGGER) break;
        if (!entry.service.active || skipForAutoOffer(entry, clock)) continue;
        const professionalIds = entry.professionalId ? [entry.professionalId] : await eligibleProfessionalIds(tenantId, entry.serviceId);
        if (professionalIds.length === 0) continue;
        const slot = await findSlotForEntry({
          tenantId,
          tenant: tenant as TenantRules,
          entry,
          service: entry.service,
          candidateProfessionalIds: professionalIds,
          freed: null,
          now: clock,
        });
        if (!slot) continue;
        tried += 1;
        const result = await reserveAndSend({ tenantId, tenant, entry, slot, now: clock, evolution: d.evolution });
        if (result === "SENT") summary.offered += 1;
        else if (result === "NO_WHATSAPP" || result === "SEND_FAILED") {
          await markQuietDeferral(tenantId); // sem canal agora: a marca volta e a próxima rodada tenta de novo
          break;
        }
      }
    } catch (error) {
      logger.error("waitlist.window_offer_failed", { tenantId, errorName: error instanceof Error ? error.name : "unknown" });
    }
  }
  return summary;
}

/** O horário da oferta que acabou (recusada, vencida ou removida) volta a ser "livre" para a fila. */
export async function passOfferedSlotToNext(
  tenantId: string,
  released: { entryId: string; professionalId: string | null; slotStart: Date | null; serviceId: string },
  deps?: WaitlistDeps,
): Promise<OfferSummary> {
  if (!released.professionalId || !released.slotStart) return { offeredEntryId: null, tried: 0 };
  const service = await forTenant(tenantId).service.findFirst({
    where: { id: released.serviceId },
    select: { durationMin: true, bufferAfterMin: true },
  });
  if (!service) return { offeredEntryId: null, tried: 0 };
  return offerFreedSlot(
    tenantId,
    {
      professionalId: released.professionalId,
      from: released.slotStart,
      to: addMinutes(released.slotStart, service.durationMin + service.bufferAfterMin),
    },
    { excludeEntryIds: [released.entryId], deps },
  );
}

/**
 * "Oferecer encaixe" manual do painel: procura o primeiro horário livre que cabe no pedido daquela
 * pessoa (dia, janela, profissional, duração) e manda a oferta agora, fora da ordem da fila.
 */
export async function offerEntryManually(tenantId: string, entryId: string, deps?: WaitlistDeps): Promise<{ slotStart: Date; professionalId: string }> {
  const d = depsOf(deps);
  const now = d.now ?? new Date();
  const db = forTenant(tenantId);

  const entry = await db.waitlistEntry.findFirst({ where: { id: entryId }, include: { service: true } });
  if (!entry) throw new DomainError("NOT_FOUND", "Essa pessoa não está mais na lista de espera.");
  if (entry.status !== "WAITING") {
    throw new DomainError("INVALID_STATE", entry.status === "OFFERED" ? "Esse cliente já recebeu uma oferta e está decidindo." : "Esse pedido não está mais na lista.");
  }
  if (!entry.service.active) throw new DomainError("RULE_VIOLATION", "O serviço está desativado.", { rule: "INACTIVE" });

  const tenant = await loadTenantRules(tenantId);
  const professionalIds = entry.professionalId ? [entry.professionalId] : await eligibleProfessionalIds(tenantId, entry.serviceId);
  const slot = await findSlotForEntry({
    tenantId,
    tenant: tenant as TenantRules,
    entry,
    service: entry.service,
    candidateProfessionalIds: professionalIds,
    freed: null,
    now,
  });
  if (!slot) {
    throw new DomainError("NO_SLOT", "Não há horário livre que caiba no pedido dessa pessoa. Quando abrir um, ela é avisada sozinha.");
  }

  const result = await reserveAndSend({ tenantId, tenant, entry, slot, now, evolution: d.evolution });
  switch (result) {
    case "SENT":
      return { slotStart: slot.startsAt, professionalId: slot.professionalId };
    case "NOT_RESERVED":
      throw new DomainError("SLOT_TAKEN", "Esse horário acabou de ser oferecido a outra pessoa. Tente de novo.");
    case "NO_WHATSAPP":
      throw new DomainError("NO_WHATSAPP", "Não há número de WhatsApp conectado para enviar a oferta.");
    case "NO_PHONE":
      throw new DomainError("NO_PHONE", "Esse cliente não tem telefone de WhatsApp cadastrado.");
    case "BUSY":
      throw new DomainError("BUSY", "O cliente está conversando com o bot agora. Tente de novo em instantes.");
    case "RATE_LIMITED":
      throw new DomainError("RATE_LIMITED", "Muitas mensagens para esse cliente em pouco tempo. Tente mais tarde.");
    default:
      throw new DomainError("SEND_FAILED", "Não consegui enviar a mensagem pelo WhatsApp. Tente de novo.");
  }
}

// ── Gatilho a partir da agenda ──────────────────────────────────────────────

const pending = new Set<Promise<unknown>>();

/**
 * Chamado pela agenda quando um horário abre (cancelamento, remarcação). Não bloqueia a resposta de
 * quem cancelou: roda em segundo plano e nunca lança. Os testes esperam com `drainWaitlistTriggers`.
 */
export function scheduleOfferForFreedSlot(tenantId: string, freed: FreedSlot): void {
  const task = offerFreedSlot(tenantId, freed).catch((error) => {
    logger.error("waitlist.trigger_failed", { tenantId, errorName: error instanceof Error ? error.name : "unknown" });
  });
  pending.add(task);
  void task.finally(() => pending.delete(task));
}

/** Executa uma tarefa de lista de espera em segundo plano (mesmo registro de `scheduleOfferForFreedSlot`). */
export function runInBackground(label: string, tenantId: string, task: () => Promise<unknown>): void {
  const promise = task().catch((error) => {
    logger.error("waitlist.background_failed", { tenantId, label, errorName: error instanceof Error ? error.name : "unknown" });
  });
  pending.add(promise);
  void promise.finally(() => pending.delete(promise));
}

export async function drainWaitlistTriggers(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled(Array.from(pending));
}
