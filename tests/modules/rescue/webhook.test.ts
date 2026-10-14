import { describe, expect, it, vi, beforeEach } from "vitest";
import { handleRescueInboundMessage } from "@/modules/rescue/webhook";
import { getPrisma } from "@/lib/db/prisma";
import type { EvolutionClient } from "@/modules/whatsapp/evolution-client";
import type { RescueLead, PlatformWhatsappConnection } from "@/lib/db/types";

vi.mock("@/lib/db/prisma", () => {
  const mPrisma = {
    rescueLead: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    platformWhatsappConnection: {
      findUnique: vi.fn(),
    },
  };
  return { getPrisma: () => mPrisma };
});

type MockPrisma = {
  rescueLead: {
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  platformWhatsappConnection: {
    findUnique: ReturnType<typeof vi.fn>;
  };
};

describe("rescue/webhook (handleRescueInboundMessage)", () => {
  const mEvolution: EvolutionClient = {
    createInstance: vi.fn(),
    setWebhook: vi.fn(),
    connect: vi.fn(),
    connectionState: vi.fn(),
    fetchOwnerJid: vi.fn(),
    logout: vi.fn(),
    deleteInstance: vi.fn(),
    sendText: vi.fn().mockResolvedValue({ messageId: "reply-123" }),
    checkWhatsappNumbers: vi.fn(),
    sendButtons: vi.fn(),
    sendList: vi.fn(),
    sendPoll: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("STOP/SAIR/PARAR marca como OPTED_OUT e envia mensagem de confirmação", async () => {
    const prisma = getPrisma() as unknown as MockPrisma;
    const fakeLead: Partial<RescueLead> = {
      id: "lead-abc",
      status: "MESSAGE_1_SENT",
      tenantId: "tenant-xyz",
    };
    prisma.rescueLead.findFirst.mockResolvedValue(fakeLead);
    prisma.rescueLead.updateMany.mockResolvedValue({ count: 1 });
    const fakeConn: Partial<PlatformWhatsappConnection> = {
      instanceName: "innochat-plataforma-rescue",
      role: "ACTIVE",
    };
    prisma.platformWhatsappConnection.findUnique.mockResolvedValue(fakeConn);

    const result = await handleRescueInboundMessage(
      {
        connectionId: "conn-1",
        senderDigits: "558499998888",
        text: "SAIR",
        replyTo: "558499998888",
      },
      { evolution: mEvolution, now: new Date("2026-10-14T12:00:00Z") },
    );

    expect(result.handled).toBe(true);
    expect(result.kind).toBe("OPT_OUT");
    expect(result.leadId).toBe("lead-abc");

    expect(prisma.rescueLead.updateMany).toHaveBeenCalledWith({
      where: {
        id: "lead-abc",
        status: { notIn: ["OPTED_OUT", "CONVERTED"] },
      },
      data: expect.objectContaining({
        status: "OPTED_OUT",
        nextRunAt: null,
      }),
    });

    expect(mEvolution.sendText).toHaveBeenCalledWith(
      "innochat-plataforma-rescue",
      "558499998888",
      "Tudo certo, não mando mais. Obrigado!",
    );
  });

  it("qualquer outra resposta marca como RESPONDED e NÃO envia mensagem automática", async () => {
    const prisma = getPrisma() as unknown as MockPrisma;
    const fakeLead: Partial<RescueLead> = {
      id: "lead-abc",
      status: "MESSAGE_1_SENT",
      tenantId: "tenant-xyz",
    };
    prisma.rescueLead.findFirst.mockResolvedValue(fakeLead);
    prisma.rescueLead.updateMany.mockResolvedValue({ count: 1 });

    const result = await handleRescueInboundMessage(
      {
        connectionId: "conn-1",
        senderDigits: "558499998888",
        text: "Olá! Como configuro o bot?",
        replyTo: "558499998888",
      },
      { evolution: mEvolution, now: new Date("2026-10-14T12:00:00Z") },
    );

    expect(result.handled).toBe(true);
    expect(result.kind).toBe("RESPONDED");
    expect(result.leadId).toBe("lead-abc");

    expect(prisma.rescueLead.updateMany).toHaveBeenCalledWith({
      where: {
        id: "lead-abc",
        status: { notIn: ["OPTED_OUT", "CONVERTED", "RESPONDED"] },
      },
      data: expect.objectContaining({
        status: "RESPONDED",
        nextRunAt: null,
      }),
    });

    // Não deve disparar resposta automática para resposta livre
    expect(mEvolution.sendText).not.toHaveBeenCalled();
  });
});
