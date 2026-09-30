import { describe, expect, it } from "vitest";
import {
  attendanceBubbleLabel,
  canClose,
  canSend,
  counterState,
  initialTab,
  isLongWait,
  isNearBottom,
  restoresTextOnError,
  retryAfterSeconds,
  itemsForTab,
  longestWaitingId,
  MAX_MESSAGE_LENGTH,
  messagePreview,
  sendErrorMessage,
  statusLine,
  type AttendanceItem,
} from "./attendance-utils";

const NOW = new Date("2026-09-30T15:00:00.000Z");
function item(over: Partial<AttendanceItem> & { contactId: string }): AttendanceItem {
  return {
    contactName: over.contactId,
    handoffId: null,
    status: "WAITING",
    requestedAt: null,
    offHours: false,
    lastMessage: null,
    botPausedUntil: null,
    ...over,
  };
}

describe("fila", () => {
  const items = [
    item({ contactId: "a", requestedAt: "2026-09-30T14:55:00.000Z" }),
    item({ contactId: "b", requestedAt: "2026-09-30T14:10:00.000Z" }),
    item({
      contactId: "c",
      status: "IN_PROGRESS",
      lastMessage: { body: "oi", direction: "INBOUND", author: "CLIENT", createdAt: "2026-09-30T14:00:00.000Z" },
    }),
    item({
      contactId: "d",
      status: "IN_PROGRESS",
      lastMessage: { body: "ok", direction: "OUTBOUND", author: "AGENT", createdAt: "2026-09-30T14:30:00.000Z" },
    }),
  ];
  it("aguardando: quem espera há mais tempo primeiro", () => {
    expect(itemsForTab(items, "waiting").map((i) => i.contactId)).toEqual(["b", "a"]);
    expect(longestWaitingId(items)).toBe("b");
  });
  it("em atendimento: mais recente primeiro", () => {
    expect(itemsForTab(items, "active").map((i) => i.contactId)).toEqual(["d", "c"]);
  });
  it("aba inicial segue o contato selecionado ou a fila", () => {
    expect(initialTab(items, "c")).toBe("active");
    expect(initialTab(items, null)).toBe("waiting");
    expect(initialTab([items[2]], null)).toBe("active");
    expect(initialTab([], null)).toBe("waiting");
  });
  it("espera longa a partir de 10 min", () => {
    expect(isLongWait(items[1], NOW)).toBe(true);
    expect(isLongWait(items[0], NOW)).toBe(false);
    expect(isLongWait(items[2], NOW)).toBe(false);
  });
  it("prévia indica quem falou e comprime quebras de linha", () => {
    expect(messagePreview(items[3])).toBe("Você: ok");
    expect(messagePreview(items[0])).toBe("Sem mensagens recentes");
    const bot = item({ contactId: "z", lastMessage: { body: "a\n\nb", direction: "OUTBOUND", author: "BOT", createdAt: NOW.toISOString() } });
    expect(messagePreview(bot)).toBe("Bot: a b");
  });
});

describe("status do topo", () => {
  it("aguardando, pausado e bot ativo", () => {
    expect(statusLine({ status: "WAITING", botPausedUntil: null }, "America/Sao_Paulo", NOW).text).toBe("Aguardando atendente");
    expect(statusLine({ status: "IN_PROGRESS", botPausedUntil: "2026-09-30T16:30:00.000Z" }, "America/Sao_Paulo", NOW).text).toBe(
      "Em atendimento: bot pausado até 13:30",
    );
    expect(statusLine({ status: "RECENT", botPausedUntil: "2026-09-30T14:00:00.000Z" }, "America/Sao_Paulo", NOW).text).toBe("Bot ativo");
  });
  it("encerrar só quando há o que devolver ao bot", () => {
    expect(canClose({ status: "WAITING", botPausedUntil: null }, NOW)).toBe(true);
    expect(canClose({ status: "RECENT", botPausedUntil: null }, NOW)).toBe(false);
    expect(canClose({ status: "RECENT", botPausedUntil: "2026-09-30T16:00:00.000Z" }, NOW)).toBe(true);
  });
});

describe("compositor", () => {
  it("contador só perto do limite e marca excesso", () => {
    expect(counterState(10).visible).toBe(false);
    expect(counterState(3700).visible).toBe(true);
    expect(counterState(MAX_MESSAGE_LENGTH).over).toBe(false);
    expect(counterState(MAX_MESSAGE_LENGTH + 1).over).toBe(true);
    expect(counterState(4000).text).toBe("4.000 / 4.096");
  });
  it("canSend recusa vazio, só espaços e acima do limite", () => {
    expect(canSend("")).toBe(false);
    expect(canSend("  \n ")).toBe(false);
    expect(canSend("oi")).toBe(true);
    expect(canSend("a".repeat(MAX_MESSAGE_LENGTH + 1))).toBe(false);
  });
  it("cada erro do contrato tem mensagem própria", () => {
    const codes = [
      "WHATSAPP_NOT_CONNECTED",
      "CONTACT_HAS_NO_PHONE",
      "TEXT_EMPTY",
      "TEXT_TOO_LONG",
      "RATE_LIMITED",
      "TENANT_SUSPENDED",
      "CONVERSATION_BUSY",
      "SEND_FAILED",
    ];
    expect(new Set(codes.map(sendErrorMessage)).size).toBe(codes.length);
    expect(sendErrorMessage("QUALQUER")).toMatch(/Não foi possível/);
    expect(restoresTextOnError("RATE_LIMITED")).toBe(false);
    expect(restoresTextOnError("WHATSAPP_NOT_CONNECTED")).toBe(false);
    for (const code of ["CONTACT_HAS_NO_PHONE", "TENANT_SUSPENDED", "TEXT_TOO_LONG", "CONVERSATION_BUSY", "SEND_FAILED"]) {
      expect(restoresTextOnError(code), code).toBe(true);
    }
  });
  it("CONVERSATION_BUSY e SEND_FAILED avisam que o texto continua no campo", () => {
    expect(sendErrorMessage("CONVERSATION_BUSY")).toMatch(/continua no campo/);
    expect(sendErrorMessage("SEND_FAILED")).toMatch(/continua no campo/);
  });
  it("RATE_LIMITED usa retryAfterMs quando o servidor manda", () => {
    expect(retryAfterSeconds({ retryAfterMs: 12_300 })).toBe(13);
    expect(retryAfterSeconds({ retryAfterMs: 200 })).toBe(1);
    expect(retryAfterSeconds({})).toBeNull();
    expect(retryAfterSeconds(undefined)).toBeNull();
    expect(sendErrorMessage("RATE_LIMITED", { retryAfterMs: 8000 })).toMatch(/em 8 segundos/);
    expect(sendErrorMessage("RATE_LIMITED", { retryAfterMs: 1000 })).toMatch(/em 1 segundo\./);
    expect(sendErrorMessage("RATE_LIMITED")).toMatch(/alguns segundos/);
  });
  it("rótulo acessível do balão", () => {
    expect(attendanceBubbleLabel({ author: "AGENT", authorName: "Maria", local: undefined }, "14:32")).toBe("Atendente Maria, 14:32");
    expect(attendanceBubbleLabel({ author: "AGENT", authorName: "Atendente", local: undefined }, "14:32")).toBe("Atendente, 14:32");
    expect(attendanceBubbleLabel({ author: "BOT", authorName: null, local: undefined }, "14:32")).toBe("Bot, 14:32");
    expect(attendanceBubbleLabel({ author: "AGENT", authorName: null, local: "failed" }, "14:32")).toBe("Atendente, 14:32, não enviada");
  });
  it("perto do fim", () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 480, clientHeight: 500 })).toBe(true);
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 500 })).toBe(false);
  });
});
