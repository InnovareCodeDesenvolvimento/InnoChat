import { describe, expect, it } from "vitest";
import {
  isRescueQuietHour,
  nextAllowedTimeAfterQuietHours,
  planNextActions,
  type LeadWithUser,
  type RescueSettings,
} from "@/modules/rescue/planner";

describe("rescue/planner (planNextActions)", () => {
  const defaultSettings: RescueSettings = {
    rescueWhatsappEnabled: true,
    rescueQuietHoursStart: 20,
    rescueQuietHoursEnd: 8,
  };

  it("isRescueQuietHour detecta horário permitido e de silêncio cruzando meia-noite", () => {
    // 20h às 8h
    const night = new Date("2026-10-14T21:00:00");
    night.setHours(21);
    expect(isRescueQuietHour(night, 20, 8)).toBe(true);

    const earlyMorning = new Date("2026-10-14T05:00:00");
    earlyMorning.setHours(5);
    expect(isRescueQuietHour(earlyMorning, 20, 8)).toBe(true);

    const daytime = new Date("2026-10-14T14:00:00");
    daytime.setHours(14);
    expect(isRescueQuietHour(daytime, 20, 8)).toBe(false);

    const boundaryEnd = new Date("2026-10-14T08:00:00");
    boundaryEnd.setHours(8);
    expect(isRescueQuietHour(boundaryEnd, 20, 8)).toBe(false);
  });

  it("nextAllowedTimeAfterQuietHours calcula o próximo horário de liberação", () => {
    const night = new Date("2026-10-14T22:30:00");
    night.setHours(22, 30, 0, 0);
    const next = nextAllowedTimeAfterQuietHours(night, 8);
    expect(next.getHours()).toBe(8);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(15);
  });

  it("se rescueWhatsappEnabled for false, pula todos os leads com SKIP_DISABLED", () => {
    const disabledSettings: RescueSettings = { ...defaultSettings, rescueWhatsappEnabled: false };
    const leads: LeadWithUser[] = [
      {
        id: "lead-1",
        userId: "user-1",
        tenantId: "tenant-1",
        phoneE164: "558499998888",
        status: "PENDING",
        step1ScheduledAt: new Date("2026-10-14T10:00:00"),
        createdAt: new Date("2026-10-13T10:00:00"),
        updatedAt: new Date("2026-10-13T10:00:00"),
        attempts: 0,
        step1SentAt: null,
        step2ScheduledAt: null,
        step2SentAt: null,
        nextRunAt: new Date("2026-10-14T10:00:00"),
        lastErrorCode: null,
        optedOutAt: null,
        convertedAt: null,
        respondedAt: null,
        platformConnectionId: null,
        senderPhoneE164: null,
        providerMessageId1: null,
        providerMessageId2: null,
      },
    ];

    const now = new Date("2026-10-14T12:00:00");
    const plans = planNextActions(leads, now, disabledSettings);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.kind).toBe("SKIP_DISABLED");
  });

  it("se estiver dentro das quiet hours, adia a ação com DEFER_QUIET_HOURS", () => {
    const leads: LeadWithUser[] = [
      {
        id: "lead-1",
        userId: "user-1",
        tenantId: "tenant-1",
        phoneE164: "558499998888",
        status: "PENDING",
        step1ScheduledAt: new Date("2026-10-14T21:00:00"),
        createdAt: new Date("2026-10-13T21:00:00"),
        updatedAt: new Date("2026-10-13T21:00:00"),
        attempts: 0,
        step1SentAt: null,
        step2ScheduledAt: null,
        step2SentAt: null,
        nextRunAt: new Date("2026-10-14T21:00:00"),
        lastErrorCode: null,
        optedOutAt: null,
        convertedAt: null,
        respondedAt: null,
        platformConnectionId: null,
        senderPhoneE164: null,
        providerMessageId1: null,
        providerMessageId2: null,
      },
    ];

    const quietNow = new Date("2026-10-14T22:00:00");
    quietNow.setHours(22);
    const plans = planNextActions(leads, quietNow, defaultSettings);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.kind).toBe("DEFER_QUIET_HOURS");
    expect(plans[0]?.nextRunAt?.getHours()).toBe(8);
  });

  it("planeja SEND_MESSAGE_1 para lead PENDING em horário permitido", () => {
    const leads: LeadWithUser[] = [
      {
        id: "lead-1",
        userId: "user-1",
        tenantId: "tenant-1",
        phoneE164: "558499998888",
        status: "PENDING",
        step1ScheduledAt: new Date("2026-10-14T10:00:00"),
        createdAt: new Date("2026-10-13T10:00:00"),
        updatedAt: new Date("2026-10-13T10:00:00"),
        attempts: 0,
        step1SentAt: null,
        step2ScheduledAt: new Date("2026-10-17T10:00:00"),
        step2SentAt: null,
        nextRunAt: new Date("2026-10-14T10:00:00"),
        lastErrorCode: null,
        optedOutAt: null,
        convertedAt: null,
        respondedAt: null,
        platformConnectionId: null,
        senderPhoneE164: null,
        providerMessageId1: null,
        providerMessageId2: null,
        user: {
          name: "Lucas Silva",
          createdAt: new Date("2026-10-13T10:00:00"),
          lastSeenAt: null,
        },
      },
    ];

    const dayNow = new Date("2026-10-14T14:00:00");
    dayNow.setHours(14);
    const plans = planNextActions(leads, dayNow, defaultSettings);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.kind).toBe("SEND_MESSAGE_1");
    expect(plans[0]?.toStatus).toBe("MESSAGE_1_SENDING");
    expect(plans[0]?.messageText).toContain("Lucas");
    expect(plans[0]?.messageText).toContain("SAIR");
  });

  it("planeja SEND_MESSAGE_2 para MESSAGE_1_SENT quando step2ScheduledAt venceu", () => {
    const leads: LeadWithUser[] = [
      {
        id: "lead-2",
        userId: "user-2",
        tenantId: "tenant-2",
        phoneE164: "5584988887777",
        status: "MESSAGE_1_SENT",
        step1ScheduledAt: new Date("2026-10-10T10:00:00"),
        step1SentAt: new Date("2026-10-10T10:05:00"),
        step2ScheduledAt: new Date("2026-10-14T10:00:00"),
        step2SentAt: null,
        nextRunAt: new Date("2026-10-14T10:00:00"),
        createdAt: new Date("2026-10-09T10:00:00"),
        updatedAt: new Date("2026-10-10T10:05:00"),
        attempts: 0,
        lastErrorCode: null,
        optedOutAt: null,
        convertedAt: null,
        respondedAt: null,
        platformConnectionId: null,
        senderPhoneE164: null,
        providerMessageId1: "msg-1",
        providerMessageId2: null,
        user: {
          name: "Juliana Santos",
          lastSeenAt: null,
        },
      },
    ];

    const dayNow = new Date("2026-10-14T15:00:00");
    dayNow.setHours(15);
    const plans = planNextActions(leads, dayNow, defaultSettings);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.kind).toBe("SEND_MESSAGE_2");
    expect(plans[0]?.toStatus).toBe("MESSAGE_2_SENDING");
    expect(plans[0]?.messageText).toContain("Juliana");
    expect(plans[0]?.messageText).toContain("SIM");
  });

  it("ignora (NOOP) se o usuário já fez login (lastSeenAt != null)", () => {
    const leads: LeadWithUser[] = [
      {
        id: "lead-3",
        userId: "user-3",
        tenantId: "tenant-3",
        phoneE164: "558499998888",
        status: "PENDING",
        step1ScheduledAt: new Date("2026-10-14T10:00:00"),
        createdAt: new Date("2026-10-13T10:00:00"),
        updatedAt: new Date("2026-10-13T10:00:00"),
        attempts: 0,
        step1SentAt: null,
        step2ScheduledAt: null,
        step2SentAt: null,
        nextRunAt: new Date("2026-10-14T10:00:00"),
        lastErrorCode: null,
        optedOutAt: null,
        convertedAt: null,
        respondedAt: null,
        platformConnectionId: null,
        senderPhoneE164: null,
        providerMessageId1: null,
        providerMessageId2: null,
        user: {
          name: "Renato",
          lastSeenAt: new Date("2026-10-14T11:00:00"),
        },
      },
    ];

    const dayNow = new Date("2026-10-14T14:00:00");
    dayNow.setHours(14);
    const plans = planNextActions(leads, dayNow, defaultSettings);

    expect(plans).toHaveLength(1);
    expect(plans[0]?.kind).toBe("NOOP");
  });
});
