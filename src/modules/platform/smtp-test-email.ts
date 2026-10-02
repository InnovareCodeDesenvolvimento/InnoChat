import { sendMail, type SendMailResult } from "@/lib/email";
import { parseSender } from "@/lib/email/sender";
import { loadPlatformSettingsRow } from "./secrets";

/**
 * E-mail de teste do Admin (Configurações > SMTP): usa o MESMO remetente e o MESMO transporte dos e-mails de cobrança
 * (`sendMail`), para o dono ver a resposta real do servidor e conferir se a mensagem chega na própria caixa.
 * Só I/O: `requirePlatformAdmin` e o limite de uso ficam em `actions.ts`. Nunca devolve nem registra segredo.
 */

export type SmtpTestEmailResult = {
  /** O servidor SMTP ACEITOU a mensagem. Não prova que chegou na caixa de entrada. */
  ok: boolean;
  detalhe: string;
  accepted: string[];
  rejected: string[];
  messageId: string | null;
  response: string | null;
  /** Remetente como será usado (endereço, sem segredo) e avisos de entregabilidade que dá para tirar só da configuração. */
  from: string | null;
  warnings: string[];
};

function domainOf(address: string | null | undefined): string | null {
  const at = address?.lastIndexOf("@") ?? -1;
  return address && at > 0 ? address.slice(at + 1).trim().toLowerCase() : null;
}

/** Avisos que se enxergam só pela configuração salva (sem consultar DNS). */
export function senderWarnings(smtpUser: string | null | undefined, smtpFrom: string | null | undefined): { from: string | null; warnings: string[] } {
  const sender = smtpFrom ? parseSender(smtpFrom) : null;
  const warnings: string[] = [];
  if (smtpFrom && !sender) warnings.push("O remetente salvo não parece um e-mail válido. Confira o campo Remetente.");
  const fromDomain = domainOf(sender?.email);
  const userDomain = domainOf(smtpUser);
  if (fromDomain && userDomain && fromDomain !== userDomain) {
    warnings.push(
      `O remetente (@${fromDomain}) é de um domínio diferente do usuário do SMTP (@${userDomain}). Alguns provedores trocam ou bloqueiam esse remetente, e o Gmail pode mandar pro spam.`,
    );
  }
  return { from: sender?.email ?? null, warnings };
}

function describe(result: SendMailResult): string {
  if (result.sent) return "O servidor de e-mail aceitou a mensagem. Agora confira a sua caixa de entrada, o spam e a aba Promoções.";
  if (result.failure === "REJECTED") return "O servidor de e-mail recusou o destinatário. Veja a resposta abaixo.";
  if (result.failure === "NOT_ACCEPTED") return "O servidor não confirmou que aceitou o destinatário. Trate como não enviado.";
  return "Não foi possível falar com o servidor de e-mail. Confira servidor, porta, usuário e senha.";
}

/** Lança `SmtpNotConfiguredError` (DomainError) se o SMTP não estiver salvo. */
export async function sendSmtpTestEmail(to: string, now: Date = new Date()): Promise<SmtpTestEmailResult> {
  const hhmm = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
  const result = await sendMail({
    to,
    subject: `Teste de e-mail do InnoChat (${hhmm})`,
    text: "Este é um e-mail de teste enviado pelo painel do InnoChat. Se você está lendo isto, o envio está funcionando. Pode apagar.",
    html: "<p>Este é um e-mail de teste enviado pelo painel do InnoChat.</p><p>Se você está lendo isto, o envio está funcionando. Pode apagar.</p>",
  });
  const settings = await loadPlatformSettingsRow();
  const { from, warnings } = senderWarnings(settings?.smtpUser, settings?.smtpFrom);
  return {
    ok: result.sent,
    detalhe: describe(result),
    accepted: result.accepted,
    rejected: result.rejected,
    messageId: result.messageId ?? null,
    response: result.smtpResponse ?? null,
    from,
    warnings,
  };
}
