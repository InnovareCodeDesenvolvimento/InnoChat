import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMailMock = vi.hoisted(() => vi.fn());
const createTransportMock = vi.hoisted(() => vi.fn(() => ({ sendMail: sendMailMock })));
vi.mock("nodemailer", () => ({ default: { createTransport: createTransportMock } }));
vi.mock("@/modules/platform/secrets", () => ({
  loadPlatformSettingsRow: vi.fn(async () => ({ smtpHost: "smtp.test", smtpPort: 587, smtpSecure: false, smtpUser: "u", smtpPassword: "enc", smtpFrom: "x@test.dev" })),
  readGenericSecret: vi.fn(() => "senha"),
}));
const loggerError = vi.hoisted(() => vi.fn());
const loggerInfo = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", () => ({ logger: { error: loggerError, warn: loggerWarn, info: loggerInfo } }));

const { sendMail, sanitizeSmtpResponse, SMTP_TIMEOUT_MS } = await import("../mailer");

beforeEach(() => {
  sendMailMock.mockReset();
  createTransportMock.mockClear();
  loggerError.mockClear();
  loggerInfo.mockClear();
  loggerWarn.mockClear();
});

describe("mailer", () => {
  it("cria o transporte com timeouts curtos (conexão, saudação e socket)", async () => {
    sendMailMock.mockResolvedValue({ accepted: ["a@b.com"], rejected: [] });
    await sendMail({ to: "a@b.com", subject: "s", html: "h", text: "t" });
    const options = (createTransportMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(SMTP_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(SMTP_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
    expect(options).toMatchObject({ connectionTimeout: SMTP_TIMEOUT_MS, greetingTimeout: SMTP_TIMEOUT_MS, socketTimeout: SMTP_TIMEOUT_MS });
  });

  it("falha de envio: log sem destinatário, sem assunto e sem a mensagem bruta do transporte", async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error("550 mailbox cliente@empresa.com unavailable"), { code: "EENVELOPE" }));
    const result = await sendMail({ to: "cliente@empresa.com", subject: "Fatura da Barbearia do Zé", html: "h", text: "t" });
    expect(result).toMatchObject({ sent: false, failure: "TRANSPORT_ERROR", errorCode: "EENVELOPE", rejectedCount: 0 });
    const logged = JSON.stringify(loggerError.mock.calls);
    expect(logged).not.toContain("cliente@empresa.com");
    expect(logged).not.toContain("Barbearia");
    expect(logged).toContain("EENVELOPE");
  });

  it("aceito de verdade: devolve messageId e resposta do servidor sem endereço, e loga só id e código", async () => {
    sendMailMock.mockResolvedValue({
      accepted: ["Cliente@Empresa.com"],
      rejected: [],
      messageId: "<abc@innochat.test>",
      response: "250 2.0.0 OK 1700000000 x-gsmtp queued for Cliente@Empresa.com",
    });
    const result = await sendMail({ to: "cliente@empresa.com", subject: "Fatura da Barbearia do Zé", html: "h", text: "t" });
    expect(result).toMatchObject({ sent: true, rejectedCount: 0, messageId: "<abc@innochat.test>", smtpResponse: "250 2.0.0 OK 1700000000 x-gsmtp queued for [e-mail]" });
    const logged = JSON.stringify(loggerInfo.mock.calls);
    expect(logged).toContain("<abc@innochat.test>");
    expect(logged).toContain("250");
    expect(logged).not.toContain("empresa.com");
    expect(logged).not.toContain("Barbearia");
  });

  it("recusa parcial ou total do servidor vira falha (sent:false)", async () => {
    sendMailMock.mockResolvedValue({ accepted: ["a@b.com"], rejected: ["c@d.com"], response: "250 OK" });
    expect(await sendMail({ to: "a@b.com", subject: "s", html: "h", text: "t" })).toMatchObject({ sent: false, failure: "REJECTED", rejectedCount: 1 });

    sendMailMock.mockResolvedValue({ accepted: [], rejected: ["a@b.com"], response: "550 5.1.1 no such user" });
    expect(await sendMail({ to: "a@b.com", subject: "s", html: "h", text: "t" })).toMatchObject({ sent: false, failure: "REJECTED", rejectedCount: 1, smtpResponse: "550 5.1.1 no such user" });
    expect(JSON.stringify(loggerWarn.mock.calls)).not.toContain("a@b.com");
  });

  it("servidor que não confirma o destinatário em accepted conta como falha", async () => {
    sendMailMock.mockResolvedValue({ accepted: [], rejected: [], response: "250 OK" });
    expect(await sendMail({ to: "a@b.com", subject: "s", html: "h", text: "t" })).toMatchObject({ sent: false, failure: "NOT_ACCEPTED" });
    sendMailMock.mockResolvedValue({});
    expect((await sendMail({ to: "a@b.com", subject: "s", html: "h", text: "t" })).sent).toBe(false);
  });

  it("aceita endereços no formato { address } e limita a resposta a 200 caracteres", async () => {
    sendMailMock.mockResolvedValue({ accepted: [{ address: "a@b.com", name: "A" }], rejected: [], response: `250 ${"x".repeat(500)}` });
    const result = await sendMail({ to: "a@b.com", subject: "s", html: "h", text: "t" });
    expect(result.sent).toBe(true);
    expect(result.smtpResponse).toHaveLength(200);
    expect(sanitizeSmtpResponse(undefined)).toBeUndefined();
  });
});
