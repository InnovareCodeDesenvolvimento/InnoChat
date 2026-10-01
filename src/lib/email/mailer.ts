import nodemailer from "nodemailer";
import { loadPlatformSettingsRow, readGenericSecret } from "@/modules/platform/secrets";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { toMailFrom } from "./sender";

/**
 * E-mail transacional via SMTP próprio (decisão do dono, 2026-09-28) — credenciais em
 * `PlatformSettings.smtp*`, nunca em env var (docs/arquitetura.md §14). `nodemailer` cria um
 * transporte novo por envio: o volume é baixo (transacional, não campanha) e evita manter um
 * pool vivo com credenciais que podem trocar a qualquer momento no admin da plataforma.
 */

/** Teto de cada fase da conversa SMTP (conexão, saudação, inatividade do socket). */
export const SMTP_TIMEOUT_MS = 15_000;

export type SendMailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

/**
 * Erro de DOMÍNIO (nunca crash) quando o SMTP não está configurado — quem chama decide o que
 * fazer (bloquear o fluxo ou só logar e seguir, conforme o e-mail for essencial ou não).
 */
export class SmtpNotConfiguredError extends DomainError {
  constructor() {
    super("SMTP_NOT_CONFIGURED", "SMTP não configurado em PlatformSettings — configure em Admin > Configurações.");
  }
}

async function loadSmtpConfig() {
  const settings = await loadPlatformSettingsRow(); // já migrado; senha SMTP vem cifrada

  if (!settings?.smtpHost || !settings.smtpPort || !settings.smtpFrom) {
    throw new SmtpNotConfiguredError();
  }

  return {
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort,
    smtpSecure: settings.smtpSecure,
    smtpUser: settings.smtpUser,
    smtpPassword: readGenericSecret(settings.smtpPassword, "smtpPassword"),
    smtpFrom: settings.smtpFrom,
  };
}

/**
 * Envia um e-mail. Nunca lança para "SMTP indisponível/erro de rede" — loga (sem segredo, sem
 * corpo, destinatário nem assunto — só o tipo/código do erro, docs/arquitetura.md §11 "nunca logar... dado
 * pessoal") e devolve `{ sent: false }`; quem chama decide se isso bloqueia o fluxo (ex.:
 * cadastro segue mesmo se o e-mail de verificação falhar ao enviar — a conta existe, o usuário
 * pode pedir reenvio depois) ou não. Só lança `SmtpNotConfiguredError` (erro de domínio, não de
 * infraestrutura) quando falta configuração — isso É um erro de configuração que vale a pena
 * propagar como 4xx/DomainError em vez de engolir.
 */
export async function sendMail(input: SendMailInput): Promise<{ sent: boolean }> {
  const config = await loadSmtpConfig();

  const transporter = nodemailer.createTransport({
    host: config.smtpHost!,
    port: config.smtpPort!,
    secure: !!config.smtpSecure,
    auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPassword ?? undefined } : undefined,
    // Sem estes tetos o nodemailer espera minutos (padrão 2 min a 10 min) por um SMTP travado, e o tick
    // de cobrança (serial, sob trava) estouraria o prazo da trava. Falha rápida = reenvio na rodada seguinte.
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });

  try {
    await transporter.sendMail({
      from: toMailFrom(config.smtpFrom!),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    return { sent: true };
  } catch (error) {
    // Nunca loga destinatário, assunto (carrega o nome da empresa) nem a mensagem bruta do transporte
    // (pode repetir o endereço do destinatário): só o tipo/código do erro.
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
    logger.error("email.send.failed", {
      errorName: error instanceof Error ? error.name : "unknown",
      errorCode: code,
    });
    return { sent: false };
  }
}
