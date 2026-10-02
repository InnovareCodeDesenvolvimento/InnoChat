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

/**
 * Resultado de `sendMail`. `sent` continua sendo o que os chamadores antigos leem; os demais campos são a EVIDÊNCIA do
 * envio (o que o servidor SMTP respondeu), para o registro de envios e para o e-mail de teste do Admin.
 * `sent: true` só quando o servidor ACEITOU o destinatário e não recusou nenhum: aceitar a conversa SMTP não basta.
 * Ainda assim, "aceito" não é "entregue na caixa": o provedor de destino pode filtrar depois (spam, bounce assíncrono).
 */
export type SendMailResult = {
  sent: boolean;
  /** Id da mensagem atribuído pelo transporte (Message-ID). */
  messageId?: string;
  /** Resposta final do servidor, sem endereços de e-mail e com no máximo 200 caracteres. Ex.: "250 2.0.0 OK 1696... - gsmtp". */
  smtpResponse?: string;
  rejectedCount: number;
  /** Endereços que o servidor aceitou / recusou (dado pessoal: só para a tela do admin, nunca para log). */
  accepted: string[];
  rejected: string[];
  /** Por que `sent` é false: `REJECTED` (servidor recusou o destinatário), `NOT_ACCEPTED` (não confirmou o destinatário), `TRANSPORT_ERROR` (falha de rede/login). */
  failure?: "REJECTED" | "NOT_ACCEPTED" | "TRANSPORT_ERROR";
  /** Código do erro de transporte (ex.: EAUTH, ETIMEDOUT), só em `TRANSPORT_ERROR`. */
  errorCode?: string;
};

const SMTP_RESPONSE_MAX = 200;
const EMAIL_IN_TEXT = /[^\s<>"',;()]+@[^\s<>"',;()]+/g;

/** Tira endereços de e-mail (dado pessoal) e limita o tamanho da resposta do servidor antes de guardar ou mostrar. */
export function sanitizeSmtpResponse(response: unknown): string | undefined {
  if (typeof response !== "string") return undefined;
  const clean = response.replace(EMAIL_IN_TEXT, "[e-mail]").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, SMTP_RESPONSE_MAX) : undefined;
}

function smtpCodeOf(response: string | undefined): string | undefined {
  return response?.match(/^\d{3}/)?.[0];
}

function addressList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item : item && typeof item === "object" && "address" in item ? String((item as { address: unknown }).address) : ""))
    .filter((item) => item.length > 0);
}

/** Traduz o `info` do nodemailer em sucesso/falha. Exportada para teste. */
export function interpretSendInfo(to: string, info: unknown): SendMailResult {
  const raw = (info && typeof info === "object" ? info : {}) as { accepted?: unknown; rejected?: unknown; messageId?: unknown; response?: unknown };
  const accepted = addressList(raw.accepted);
  const rejected = addressList(raw.rejected);
  const wanted = to.trim().toLowerCase();
  const acceptedRecipient = accepted.some((address) => address.trim().toLowerCase() === wanted);
  const smtpResponse = sanitizeSmtpResponse(raw.response);
  const messageId = typeof raw.messageId === "string" && raw.messageId.length > 0 ? raw.messageId.slice(0, 300) : undefined;
  const base = { rejectedCount: rejected.length, accepted, rejected, ...(messageId ? { messageId } : {}), ...(smtpResponse ? { smtpResponse } : {}) };
  if (rejected.length > 0) return { ...base, sent: false, failure: "REJECTED" };
  if (!acceptedRecipient) return { ...base, sent: false, failure: "NOT_ACCEPTED" };
  return { ...base, sent: true };
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
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
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
    const info = await transporter.sendMail({
      from: toMailFrom(config.smtpFrom!),
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    const result = interpretSendInfo(input.to, info);
    // Só ids/códigos/contagens: nunca destinatário nem assunto (a resposta do servidor passa por `sanitizeSmtpResponse`).
    const log = { messageId: result.messageId, smtpCode: smtpCodeOf(result.smtpResponse), rejectedCount: result.rejectedCount };
    if (result.sent) logger.info("email.send.accepted", log);
    else logger.warn("email.send.not_accepted", { ...log, failure: result.failure });
    return result;
  } catch (error) {
    // Nunca loga destinatário, assunto (carrega o nome da empresa) nem a mensagem bruta do transporte
    // (pode repetir o endereço do destinatário): só o tipo/código do erro.
    const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
    logger.error("email.send.failed", {
      errorName: error instanceof Error ? error.name : "unknown",
      errorCode: code,
    });
    return { sent: false, rejectedCount: 0, accepted: [], rejected: [], failure: "TRANSPORT_ERROR", ...(code ? { errorCode: code } : {}) };
  }
}
