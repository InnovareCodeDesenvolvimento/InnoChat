import { beforeEach, describe, expect, it, vi } from "vitest";
import { touchUserLastSeen } from "@/modules/rescue/throttle";
import { getPrisma } from "@/lib/db/prisma";

vi.mock("@/lib/db/prisma", () => {
  const mPrisma = {
    user: {
      updateMany: vi.fn(),
    },
    rescueLead: {
      updateMany: vi.fn(),
    },
  };
  return { getPrisma: () => mPrisma };
});

type MockPrisma = {
  user: {
    updateMany: ReturnType<typeof vi.fn>;
  };
  rescueLead: {
    updateMany: ReturnType<typeof vi.fn>;
  };
};

describe("rescue/throttle (touchUserLastSeen)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executa update se passou mais de 15 minutos e avança RescueLead para CONVERTED", async () => {
    const prisma = getPrisma() as unknown as MockPrisma;
    prisma.user.updateMany.mockResolvedValue({ count: 1 });
    prisma.rescueLead.updateMany.mockResolvedValue({ count: 1 });

    const now = new Date("2026-10-14T12:00:00Z");
    const updated = await touchUserLastSeen("user-1", now);

    expect(updated).toBe(true);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: "user-1",
        OR: [
          { lastSeenAt: null },
          { lastSeenAt: { lte: new Date(now.getTime() - 15 * 60 * 1000) } },
        ],
      },
      data: {
        lastSeenAt: now,
      },
    });
    expect(prisma.rescueLead.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        status: { in: ["PENDING", "MESSAGE_1_SENDING", "MESSAGE_1_SENT", "MESSAGE_2_SENDING", "MESSAGE_2_SENT"] },
      },
      data: {
        status: "CONVERTED",
        convertedAt: now,
        nextRunAt: null,
      },
    });
  });

  it("não atualiza (noop) se o updateMany do user retornou 0 (foi visto há < 15 min)", async () => {
    const prisma = getPrisma() as unknown as MockPrisma;
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    const now = new Date("2026-10-14T12:05:00Z");
    const updated = await touchUserLastSeen("user-1", now);

    expect(updated).toBe(false);
    expect(prisma.rescueLead.updateMany).not.toHaveBeenCalled();
  });
});
