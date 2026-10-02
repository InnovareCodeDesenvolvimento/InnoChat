import { beforeEach, describe, expect, it, vi } from "vitest";

const adminGuard = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/guards", () => ({ requirePlatformAdmin: adminGuard }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const sendMailMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return { ...actual, sendMail: sendMailMock };
});
vi.mock("../secrets", async (importOriginal) => {
  const original = await importOriginal<typeof import("../secrets")>();
  return { ...original, loadPlatformSettingsRow: vi.fn(async () => ({ smtpUser: "robo@outro.com", smtpFrom: "InnoChat <no-reply@innovarecode.com.br>" })) };
});

const { sendSmtpTestEmailAction } = await import("../actions");
const { senderWarnings } = await import("../smtp-test-email");
const { DomainError } = await import("@/lib/errors");
const { __resetRateLimitsForTests } = await import("@/lib/rate-limit");

beforeEach(() => {
  adminGuard.mockReset();
  adminGuard.mockResolvedValue({ id: "admin-1" });
  sendMailMock.mockReset();
  __resetRateLimitsForTests();
});

describe("sendSmtpTestEmailAction", () => {
  it("só admin da plataforma: sem permissão não envia nada", async () => {
    adminGuard.mockRejectedValue(new DomainError("FORBIDDEN", "Requer acesso de administrador da plataforma."));
    const result = await sendSmtpTestEmailAction({ to: "dono@gmail.com" });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("valida o e-mail antes de enviar", async () => {
    const result = await sendSmtpTestEmailAction({ to: "isto-nao-e-email" });
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("mostra a resposta real do servidor e avisa do remetente de outro domínio", async () => {
    sendMailMock.mockResolvedValue({ sent: true, rejectedCount: 0, accepted: ["dono@gmail.com"], rejected: [], messageId: "<m1@x>", smtpResponse: "250 2.0.0 OK 1 - gsmtp" });
    const result = await sendSmtpTestEmailAction({ to: "dono@gmail.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ ok: true, accepted: ["dono@gmail.com"], rejected: [], messageId: "<m1@x>", response: "250 2.0.0 OK 1 - gsmtp", from: "no-reply@innovarecode.com.br" });
    expect(result.data.warnings.join(" ")).toContain("@outro.com");
    expect(sendMailMock.mock.calls[0][0]).toMatchObject({ to: "dono@gmail.com" });
  });

  it("recusa do servidor aparece como não aceito, sem lançar", async () => {
    sendMailMock.mockResolvedValue({ sent: false, rejectedCount: 1, accepted: [], rejected: ["dono@gmail.com"], failure: "REJECTED", smtpResponse: "550 5.1.1 no such user" });
    const result = await sendSmtpTestEmailAction({ to: "dono@gmail.com" });
    expect(result.ok && result.data).toMatchObject({ ok: false, rejected: ["dono@gmail.com"], response: "550 5.1.1 no such user" });
  });

  it("limita a 5 testes por 10 minutos por administrador", async () => {
    sendMailMock.mockResolvedValue({ sent: true, rejectedCount: 0, accepted: ["dono@gmail.com"], rejected: [] });
    for (let i = 0; i < 5; i += 1) expect((await sendSmtpTestEmailAction({ to: "dono@gmail.com" })).ok).toBe(true);
    expect(await sendSmtpTestEmailAction({ to: "dono@gmail.com" })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(sendMailMock).toHaveBeenCalledTimes(5);
  });
});

describe("senderWarnings", () => {
  it("sem aviso quando o domínio do remetente é o mesmo do usuário SMTP", () => {
    expect(senderWarnings("no-reply@innovarecode.com.br", "InnoChat <no-reply@innovarecode.com.br>").warnings).toEqual([]);
  });
  it("usuário sem @ (ex.: chave de API) não gera comparação", () => {
    expect(senderWarnings("apikey", "no-reply@innovarecode.com.br").warnings).toEqual([]);
  });
});
