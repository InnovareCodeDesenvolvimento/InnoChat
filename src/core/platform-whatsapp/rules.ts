import { createHash, randomBytes } from "node:crypto";
import { whatsappJidCandidatesForPhone } from "@/core/whatsapp/phone";

/**
 * Regras PURAS do WhatsApp da plataforma (docs/regua-de-cobranca.md §2.4): nada de I/O aqui.
 * Telefones deste módulo são sempre SÓ DÍGITOS com DDI ("558499998888"), o mesmo formato de
 * `PlatformWhatsappConnection.phoneE164` e `Tenant.billingWhatsappE164`.
 */

/** QR aberto há mais que isto sem conectar vira `RETIRED/ABANDONED_QR` sozinho. */
export const QR_ABANDON_MS = 30 * 60 * 1000;
/** Número recém-conectado fica em aquecimento por este tempo (§2.4 "Ritmo anti-bloqueio"). */
export const WARMUP_MS = 3 * 24 * 60 * 60 * 1000;
export const WARMUP_ROUND_CAP = 10;
export const NORMAL_ROUND_CAP = 30;
/** A "rodada" do teto é a janela deslizante de 1 hora (o tick da cobrança roda de hora em hora). */
export const ROUND_WINDOW_MS = 60 * 60 * 1000;
/** A mensagem automática da plataforma sai no máximo 1 vez por contato neste intervalo (trava 2). */
export const AUTOREPLY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const LABEL_MAX = 40;

/** `ProviderEvent.provider` das respostas de assinantes (sino) e da resposta automática (trava de 24 h). */
export const PLATFORM_REPLY_PROVIDER = "platform-whatsapp-reply";
export const PLATFORM_AUTOREPLY_PROVIDER = "platform-whatsapp-autoreply";
/**
 * Retenção desses registros (guardam um trecho da mensagem do assinante e o número mascarado, dado pessoal). O sino
 * só olha 30 dias; 45 dá folga e nada mais é necessário depois disso.
 */
export const PLATFORM_REPLY_RETENTION_DAYS = 45;

export const NEW_NUMBER_NOTICE =
  "Este é o novo número de avisos do InnoChat. O anterior não envia mais mensagens.";

/**
 * Resposta automática do número de cobrança. O canal de suporte é o WhatsApp comercial cadastrado no
 * Admin (decisão do dono, 2026-10-01: indicar o (84) 3113-2584). Sem número cadastrado, cai no painel.
 */
export function autoreplyText(supportDisplay: string | null): string {
  const help = supportDisplay
    ? `Para falar com a gente, chame no ${supportDisplay}.`
    : "Se precisar de ajuda com a assinatura, fale com a gente pelo painel.";
  return `Este número é só de avisos de cobrança do InnoChat e não atende conversas. ${help} Para parar de receber os avisos neste WhatsApp, responda SAIR.`;
}

export const OPT_OUT_CONFIRMATION =
  "Pronto, você não vai mais receber avisos de cobrança do InnoChat por este WhatsApp. Os avisos continuam chegando por e-mail e no painel.";

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Todas as formas de dígitos plausíveis para um telefone (com e sem o 9º dígito brasileiro). */
export function phoneDigitVariants(phone: string): string[] {
  const digits = digitsOnly(phone);
  if (!digits) return [];
  return whatsappJidCandidatesForPhone(digits).map((jid) => jid.split("@")[0]!);
}

/** "558499998888" -> "+55 84 9****-8888" (histórico; o número inteiro só aparece no card do ativo). */
export function maskPhone(phone: string | null | undefined): string | null {
  const digits = phone ? digitsOnly(phone) : "";
  if (digits.length < 12) return digits ? `***${digits.slice(-4)}` : null;
  const cc = digits.slice(0, 2);
  const ddd = digits.slice(2, 4);
  const rest = digits.slice(4);
  const last4 = rest.slice(-4);
  const lead = rest.length === 9 ? `${rest[0]}` : "";
  return `+${cc} ${ddd} ${lead}****-${last4}`;
}

/** "558499998888" -> "+55 84 99999-8888". */
export function formatPhoneDisplay(phone: string | null | undefined): string | null {
  const digits = phone ? digitsOnly(phone) : "";
  if (!digits) return null;
  if (digits.length < 12) return `+${digits}`;
  const cc = digits.slice(0, 2);
  const ddd = digits.slice(2, 4);
  const rest = digits.slice(4);
  const head = rest.slice(0, rest.length - 4);
  return `+${cc} ${ddd} ${head}-${rest.slice(-4)}`;
}

export function generateWebhookToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Só o hash do token fica em repouso (mesmo princípio do segredo da API interna). */
export function hashWebhookToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Hash que nunca bate com um token real: usado na linha aposentada que cedeu o token à nova. */
export function deadTokenHash(connectionId: string): string {
  return createHash("sha256").update(`dead:${connectionId}`).digest("hex");
}

/** `innochat-plataforma-<8 chars do id>` (docs §2.4); minúsculo e sem símbolos. */
export function buildPlatformInstanceName(connectionId: string): string {
  const suffix = connectionId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8) || "0000";
  return `innochat-plataforma-${suffix}`;
}

/** Teto de envios por rodada: menor nos primeiros 3 dias depois de ativado. */
export function roundCapFor(activatedAt: Date | null, now: Date): number {
  if (!activatedAt) return WARMUP_ROUND_CAP;
  return now.getTime() - activatedAt.getTime() < WARMUP_MS ? WARMUP_ROUND_CAP : NORMAL_ROUND_CAP;
}

export function isQrAbandoned(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > QR_ABANDON_MS;
}

/** "SAIR" (com pontuação/caixa/acento soltos) pedindo para parar os avisos. */
export function isOptOutText(text: string): boolean {
  const normalized = text
    .slice(0, 200)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .join(" ");
  return normalized === "sair" || normalized === "parar" || normalized === "stop" || normalized === "cancelar avisos";
}

/** "SIM" (com pontuação/caixa/acento soltos) confirmando que o número é da empresa. */
export function isConfirmText(text: string): boolean {
  const normalized = text
    .slice(0, 200)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .trim()
    .split(/\s+/)
    .join(" ");
  // Só "sim" e "confirmo": "s" ou "confirmar" soltos aparecem em respostas comuns e confirmariam a posse sem querer.
  return normalized === "sim" || normalized === "confirmo";
}

export const CONFIRM_REPLY =
  "Obrigado, número confirmado! Os avisos de cobrança do InnoChat vão continuar chegando por aqui. Para parar de recebê-los neste WhatsApp, responda SAIR.";

/** Hash (não reversível) do número, para chaves de deduplicação sem guardar o telefone em claro. */
export function hashPhoneForDedup(digits: string): string {
  return createHash("sha256").update(`wa-dedup:${digitsOnly(digits)}`).digest("hex").slice(0, 32);
}

export function withNewNumberNotice(text: string): string {
  return `${NEW_NUMBER_NOTICE}\n\n${text}`;
}
