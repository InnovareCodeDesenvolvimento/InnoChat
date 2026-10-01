import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMailMock = vi.hoisted(() => vi.fn());
const createTransportMock = vi.hoisted(() => vi.fn(() => ({ sendMail: sendMailMock })));
vi.mock("nodemailer", () => ({ default: { createTransport: createTransportMock } }));
vi.mock("@/modules/platform/secrets", () => ({
  loadPlatformSettingsRow: vi.fn(async () => ({ smtpHost: "smtp.test", smtpPort: 587, smtpSecure: false, smtpUser: "u", smtpPassword: "enc", smtpFrom: "x@test.dev" })),
  readGenericSecret: vi.fn(() => "senha"),
}));
const loggerError = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ logger: { error: loggerError, warn: vi.fn(), info: vi.fn() } }));

const { sendMail, SMTP_TIMEOUT_MS } = await import("../mailer");

beforeEach(() => {
  sendMailMock.mockReset();
  createTransportMock.mockClear();
  loggerError.mockClear();
});

describe("mailer", () => {
  it("cria o transporte com timeouts curtos (conexão, saudação e socket)", async () => {
    sendMailMock.mockResolvedValue({});
    await sendMail({ to: "a@b.com", subject: "s", html: "h", text: "t" });
    const options = (createTransportMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(SMTP_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(SMTP_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(options).toMatchObject({ connectionTimeout: SMTP_TIMEOUT_MS, greetingTimeout: SMTP_TIMEOUT_MS, socketTimeout: SMTP_TIMEOUT_MS });
  });

  it("falha de envio: log sem destinatário, sem assunto e sem a mensagem bruta do transporte", async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error("550 mailbox cliente@empresa.com unavailable"), { code: "EENVELOPE" }));
    const result = await sendMail({ to: "cliente@empresa.com", subject: "Fatura da Barbearia do Zé", html: "h", text: "t" });
    expect(result).toEqual({ sent: false });
    const logged = JSON.stringify(loggerError.mock.calls);
    expect(logged).not.toContain("cliente@empresa.com");
    expect(logged).not.toContain("Barbearia");
    expect(logged).toContain("EENVELOPE");
  });
});
