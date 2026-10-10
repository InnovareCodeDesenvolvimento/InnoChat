/**
 * E-mails descartáveis: lista estática e curta, sem consulta de rede (latência e falso negativo). O objetivo é só
 * barrar o cadastro de quem nunca vai receber os avisos da conta; quem quer burlar troca de domínio, e tudo bem.
 * Puro, sem I/O.
 */
const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  "mailinator.com",
  "mailinator.net",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamail.biz",
  "guerrillamail.de",
  "grr.la",
  "sharklasers.com",
  "10minutemail.com",
  "10minutemail.net",
  "10minemail.com",
  "temp-mail.org",
  "temp-mail.io",
  "tempmail.com",
  "tempmail.net",
  "tempmail.dev",
  "tempail.com",
  "trashmail.com",
  "trashmail.net",
  "trashmail.de",
  "dispostable.com",
  "getnada.com",
  "nada.email",
  "maildrop.cc",
  "mohmal.com",
  "throwawaymail.com",
  "fakeinbox.com",
  "mailnesia.com",
  "mintemail.com",
  "spamgourmet.com",
  "emailondeck.com",
  "burnermail.io",
  "mytemp.email",
  "moakt.com",
  "tmpmail.org",
  "tmpmail.net",
  "discard.email",
  "mailcatch.com",
  "inboxkitten.com",
  "harakirimail.com",
  "33mail.com",
]);

/** Domínio (minúsculo) do e-mail, ou `null` se não tiver um "@" com algo depois. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

export function isDisposableEmail(email: string): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  if (DISPOSABLE_DOMAINS.has(domain)) return true;
  // Subdomínio de um serviço da lista (ex.: "x.mailinator.com").
  const parts = domain.split(".");
  for (let i = 1; i < parts.length - 1; i += 1) {
    if (DISPOSABLE_DOMAINS.has(parts.slice(i).join("."))) return true;
  }
  return false;
}
