import type { RescueLead, RescueLeadStatus } from "./service";
import { RESCUE_MSG_1_TEMPLATE, RESCUE_MSG_2_TEMPLATE, humanizeSince } from "./messages";

export type RescueSettings = {
  rescueWhatsappEnabled: boolean;
  rescueQuietHoursStart: number; // ex: 20
  rescueQuietHoursEnd: number;   // ex: 8
};

export type PlannedActionKind =
  | "SEND_MESSAGE_1"
  | "SEND_MESSAGE_2"
  | "DEFER_QUIET_HOURS"
  | "EXPIRE"
  | "SKIP_DISABLED"
  | "NOOP";

export type ActionPlan = {
  leadId: string;
  kind: PlannedActionKind;
  toStatus?: RescueLeadStatus;
  nextRunAt?: Date | null;
  messageText?: string;
  reason?: string;
};

export type LeadWithUser = RescueLead & {
  user?: {
    name?: string | null;
    createdAt?: Date;
    lastSeenAt?: Date | null;
  } | null;
};

/**
 * Checa se um instante (hora local em UTC ou conforme fuso) cai dentro das horas de silêncio.
 * Exemplo padrão: start = 20, end = 8.
 * Horas 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7 são quiet hours.
 * 8 a 19 são permitidas.
 */
export function isRescueQuietHour(date: Date, startHour: number, endHour: number): boolean {
  const hour = date.getHours(); // hora do ambiente
  if (startHour > endHour) {
    // Cruza a meia-noite (ex: 20h às 8h)
    return hour >= startHour || hour < endHour;
  }
  if (startHour < endHour) {
    // Mesmo dia (ex: 12h às 14h)
    return hour >= startHour && hour < endHour;
  }
  return false;
}

/**
 * Próximo instante válido logo após o fim da janela de silêncio.
 */
export function nextAllowedTimeAfterQuietHours(now: Date, endHour: number): Date {
  const next = new Date(now);
  if (now.getHours() >= endHour) {
    // O fim da quiet hour já foi hoje, então a próxima janela livre que abre em endHour é amanhã
    next.setDate(next.getDate() + 1);
  }
  next.setHours(endHour, 0, 0, 0);
  return next;
}

/**
 * Função PURA de planejamento.
 * Avalia cada lead frente às configurações e ao relógio atual, decidindo o que fazer.
 * Não faz I/O e pode ser testada exaustivamente com fixtures sem bater em banco.
 */
export function planNextActions(
  leads: LeadWithUser[],
  now: Date,
  settings: RescueSettings
): ActionPlan[] {
  if (!settings.rescueWhatsappEnabled) {
    return leads.map((l) => ({
      leadId: l.id,
      kind: "SKIP_DISABLED",
      reason: "rescueWhatsappEnabled is false",
    }));
  }

  const inQuietHours = isRescueQuietHour(
    now,
    settings.rescueQuietHoursStart,
    settings.rescueQuietHoursEnd
  );

  const plans: ActionPlan[] = [];

  for (const lead of leads) {
    // Se o usuário já logou ou se foi convertido/opted-out, é NOOP ou CONVERTED
    if (lead.user?.lastSeenAt || lead.status === "CONVERTED" || lead.status === "OPTED_OUT") {
      plans.push({
        leadId: lead.id,
        kind: "NOOP",
        reason: "User already active or lead finished",
      });
      continue;
    }

    if (inQuietHours) {
      const deferUntil = nextAllowedTimeAfterQuietHours(now, settings.rescueQuietHoursEnd);
      plans.push({
        leadId: lead.id,
        kind: "DEFER_QUIET_HOURS",
        nextRunAt: deferUntil,
        reason: "Within quiet hours",
      });
      continue;
    }

    const userName = lead.user?.name?.trim()?.split(" ")[0] || "olá";

    if (lead.status === "PENDING") {
      const createdAt = lead.user?.createdAt ?? lead.createdAt;
      const faltou = humanizeSince(createdAt, now);
      const text = RESCUE_MSG_1_TEMPLATE({ nome: userName, faltou });

      plans.push({
        leadId: lead.id,
        kind: "SEND_MESSAGE_1",
        toStatus: "MESSAGE_1_SENDING",
        messageText: text,
      });
      continue;
    }

    if (lead.status === "MESSAGE_1_SENT") {
      // Step 2 é devido quando now >= step2ScheduledAt
      if (lead.step2ScheduledAt && now.getTime() >= lead.step2ScheduledAt.getTime()) {
        const text = RESCUE_MSG_2_TEMPLATE({ nome: userName });
        plans.push({
          leadId: lead.id,
          kind: "SEND_MESSAGE_2",
          toStatus: "MESSAGE_2_SENDING",
          messageText: text,
        });
      } else {
        plans.push({
          leadId: lead.id,
          kind: "NOOP",
          reason: "Step 2 scheduled for later",
        });
      }
      continue;
    }

    if (lead.status === "MESSAGE_2_SENT") {
      // Se já mandou a msg 2 e já passou 48h sem resposta nem conversão, expira
      const sent2At = lead.step2SentAt?.getTime() ?? lead.updatedAt.getTime();
      const expiresAt = sent2At + 48 * 60 * 60 * 1000;
      if (now.getTime() >= expiresAt) {
        plans.push({
          leadId: lead.id,
          kind: "EXPIRE",
          toStatus: "EXPIRED",
          reason: "Expired without response after message 2",
        });
      } else {
        plans.push({
          leadId: lead.id,
          kind: "NOOP",
          reason: "Waiting response for message 2",
        });
      }
      continue;
    }

    plans.push({
      leadId: lead.id,
      kind: "NOOP",
      reason: `Status ${lead.status} has no pending action`,
    });
  }

  return plans;
}
