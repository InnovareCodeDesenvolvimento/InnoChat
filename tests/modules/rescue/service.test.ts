import { describe, expect, it, vi } from "vitest";
import {
  ensureRescueLead,
  transitionRescueLead,
  optOut,
  markResponded,
  markConverted,
  sanitizeRescuePhone,
} from "@/modules/rescue/service";
import { getPrisma } from "@/lib/db/prisma";
import type { RescueLeadStatus } from "@/lib/db/types";

vi.mock("@/lib/db/prisma", () => {
  const mPrisma = {
    rescueLead: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      updateMany: vi.fn(),
    },
  };
  return { getPrisma: () => mPrisma };
});

type MockPrisma = {
  rescueLead: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  user: {
    updateMany: ReturnType<typeof vi.fn>;
  };
};

describe("rescue/service", () => {
  it("sanitizeRescuePhone formata telefones corretamente", () => {
    expect(sanitizeRescuePhone("84999998888")).toBe("5584999998888");
    expect(sanitizeRescuePhone("+55 (84) 99999-8888")).toBe("5584999998888");
    expect(sanitizeRescuePhone("5584999998888")).toBe("5584999998888");
    expect(sanitizeRescuePhone("123")).toBe("123");
  });

  it("ensureRescueLead é idempotente se já existir", async () => {
    const prisma = getPrisma() as unknown as MockPrisma;
    const existing = {
      id: "lead-existing",
      userId: "u1",
      tenantId: "t1",
      phoneE164: "558499998888",
      status: "PENDING" as RescueLeadStatus,
    };
    prisma.rescueLead.findUnique.mockResolvedValue(existing);

    const result = await ensureRescueLead("u1", "t1", "558499998888");
    expect(result).toEqual(existing);
    expect(prisma.rescueLead.create).not.toHaveBeenCalled();
  });

  it("ensureRescueLead cria quando não existe", async () => {
    const prisma = getPrisma() as unknown as MockPrisma;
    prisma.rescueLead.findUnique.mockResolvedValue(null);
    const created = {
      id: "lead-new",
      userId: "u2",
      tenantId: "t2",
      phoneE164: "558499998888",
      status: "PENDING" as RescueLeadStatus,
    };
    prisma.rescueLead.create.mockResolvedValue(created);

    const result = await ensureRescueLead("u2", "t2", "558499998888");
    expect(result).toEqual(created);
    expect(prisma.rescueLead.create).toHaveBeenCalled();
  });

  it("transitionRescueLead atualiza com updateMany de forma idempotente", async () => {
    const prisma = getPrisma() as unknown as MockPrisma;
    prisma.rescueLead.updateMany.mockResolvedValue({ count: 1 });

    const res = await transitionRescueLead(
      { id: "lead-1", status: "PENDING" },
      "MESSAGE_1_SENDING",
    );

    expect(res.ok).toBe(true);
    expect(res.newStatus).toBe("MESSAGE_1_SENDING");
    expect(prisma.rescueLead.updateMany).toHaveBeenCalledWith({
      where: { id: "lead-1", status: "PENDING" },
      data: expect.objectContaining({ status: "MESSAGE_1_SENDING" }),
    });
  });

  it("transitionRescueLead devolve ok: false se status esperado não bater", async () => {
    const prisma = getPrisma() as unknown as MockPrisma;
    prisma.rescueLead.updateMany.mockResolvedValue({ count: 0 });
    prisma.rescueLead.findUnique.mockResolvedValue({ status: "CONVERTED" as RescueLeadStatus });

    const res = await transitionRescueLead(
      { id: "lead-1", status: "PENDING" },
      "MESSAGE_1_SENDING",
    );

    expect(res.ok).toBe(false);
    expect(res.newStatus).toBe("CONVERTED");
  });

  it("optOut atualiza status para OPTED_OUT e zera nextRunAt", async () => {
    const prisma = getPrisma() as unknown as MockPrisma;
    prisma.rescueLead.updateMany.mockResolvedValue({ count: 1 });
    const now = new Date("2026-10-14T12:00:00Z");

    await optOut("lead-1", now);

    expect(prisma.rescueLead.updateMany).toHaveBeenCalledWith({
      where: {
        id: "lead-1",
        status: { notIn: ["OPTED_OUT", "CONVERTED"] },
      },
      data: {
        status: "OPTED_OUT",
        optedOutAt: now,
        nextRunAt: null,
      },
    });
  });

  it("markResponded atualiza status para RESPONDED e zera nextRunAt", async () => {
    const prisma = getPrisma() as unknown as MockPrisma;
    prisma.rescueLead.updateMany.mockResolvedValue({ count: 1 });
    const now = new Date("2026-10-14T12:00:00Z");

    await markResponded("lead-1", now, "Como funciona?");

    expect(prisma.rescueLead.updateMany).toHaveBeenCalledWith({
      where: {
        id: "lead-1",
        status: { notIn: ["OPTED_OUT", "CONVERTED", "RESPONDED"] },
      },
      data: {
        status: "RESPONDED",
        respondedAt: now,
        nextRunAt: null,
      },
    });
  });

  it("markConverted atualiza status para CONVERTED", async () => {
    const prisma = getPrisma() as unknown as MockPrisma;
    prisma.rescueLead.updateMany.mockResolvedValue({ count: 1 });
    const now = new Date("2026-10-14T12:00:00Z");

    await markConverted("user-1", now);

    expect(prisma.rescueLead.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        status: { notIn: ["CONVERTED", "OPTED_OUT"] },
      },
      data: {
        status: "CONVERTED",
        convertedAt: now,
        nextRunAt: null,
      },
    });
  });
});
