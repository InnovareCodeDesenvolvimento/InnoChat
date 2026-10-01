import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDemoScript, DEFAULT_CANCEL_MIN_LEAD_MIN } from "./demo-script";

describe("demo-script", () => {
  it("o prazo padrão da demo é o default real do schema (cancelMinLeadMin)", () => {
    const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf-8");
    const line = schema.split("\n").find((l) => l.includes("cancelMinLeadMin"));
    const match = line ? /@default\((\d+)\)/.exec(line) : null;
    expect(match).not.toBeNull();
    expect(DEFAULT_CANCEL_MIN_LEAD_MIN).toBe(Number(match![1]));
  });

  it("a mensagem de agendamento confirmado cita 2 horas, não 24", () => {
    const booked = buildDemoScript(new Date("2026-10-01T12:00:00Z")).find((m) => m.id === "m12");
    expect(booked?.text).toContain("2 horas");
    expect(booked?.text).not.toContain("24 horas");
  });

  it("o cliente abre a conversa e o bot responde, alternando", () => {
    const script = buildDemoScript(new Date("2026-10-01T12:00:00Z"));
    expect(script[0].from).toBe("client");
    expect(script[1].from).toBe("bot");
  });
});
