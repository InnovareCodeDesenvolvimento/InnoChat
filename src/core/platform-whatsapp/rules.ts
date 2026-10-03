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
/** Janela de contagem da resposta automática por contato (trava 2). */
export const AUTOREPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Mesmo contato só recebe outra resposta automática depois deste intervalo (2026-10-03: antes era 1 por dia e parecia quebrado). */
export const AUTOREPLY_MIN_GAP_MS = 10 * 60 * 1000;
/** Teto de respostas automáticas por contato na janela: protege de loop com outro robô. */
export const AUTOREPLY_DAILY_CAP = 6;
/** SAIR e SIM sempre respondem, mas até um teto alto na janela (só para um robô em loop não gerar eco infinito). */
export const AUTOREPLY_PRIORITY_HARD_CAP = 30;
export const LABEL_MAX = 40;

/** `ProviderEvent.provider` das respostas de assinantes (sino) e da resposta automática (trava por contato). */
export const PLATFORM_REPLY_PROVIDER = "platform-whatsapp-reply";
export const PLATFORM_AUTOREPLY_PROVIDER = "platform-whatsapp-autoreply";
/** Uma linha por conexão (providerEventId = id da conexão) com o diagnóstico do que chegou e do que foi respondido. */
export const PLATFORM_DIAG_PROVIDER = "platform-whatsapp-diag";
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
 * Formatação do WhatsApp: *negrito*, _itálico_ (docs/guia-de-voz.md: sem travessão).
 */
function supportLine(supportDisplay: string | null): string {
  return supportDisplay
    ? `💬 Para falar com a gente, chame no *${supportDisplay}*.`
    : "💬 Se precisar de ajuda com a assinatura, fale com a gente pelo painel.";
}

export function autoreplyText(supportDisplay: string | null): string {
  return [
    "Oi! 👋 Aqui é o *InnoChat*.",
    "Este número só envia *avisos de cobrança* e não lê respostas.",
    supportLine(supportDisplay),
    "🔕 Não quer mais receber os avisos por aqui? Responda *SAIR*.",
    "_Os avisos continuam chegando por e-mail e no seu painel._",
  ].join("\n\n");
}

export const OPT_OUT_CONFIRMATION =
  "Pronto, anotado. ✅\n\nVocê não vai mais receber avisos de cobrança do *InnoChat* por este WhatsApp.\n\n_Os avisos continuam chegando por e-mail e no seu painel._";

/** "SAIR" de um número que não achamos no cadastro (ou que chegou sem telefone): não dá para prometer que parou. */
export function optOutNotFoundText(supportDisplay: string | null): string {
  return [
    "Recebi o seu pedido, mas não achei este número no cadastro do *InnoChat*.",
    supportDisplay ? `💬 Para parar os avisos, chame a gente no *${supportDisplay}*.` : "💬 Para parar os avisos, fale com a gente pelo painel.",
    "_Os avisos continuam chegando por e-mail e no seu painel._",
  ].join("\n\n");
}

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
  "Obrigado, número confirmado! ✅\n\nOs avisos de cobrança do *InnoChat* vão continuar chegando por aqui.\n\n🔕 Para parar de recebê-los neste WhatsApp, responda *SAIR*.";

/** Hash (não reversível) do número, para chaves de deduplicação sem guardar o telefone em claro. */
export function hashPhoneForDedup(digits: string): string {
  return createHash("sha256").update(`wa-dedup:${digitsOnly(digits)}`).digest("hex").slice(0, 32);
}

export function withNewNumberNotice(text: string): string {
  return `${NEW_NUMBER_NOTICE}\n\n${text}`;
}

/** Chave de deduplicação para contato que chegou só com o LID do WhatsApp (sem telefone). Também só hash. */
export function hashLidForDedup(lidJid: string): string {
  return createHash("sha256").update(`wa-dedup-lid:${lidJid.split("@")[0] ?? lidJid}`).digest("hex").slice(0, 32);
}

export type AutoreplyDecision = { allow: true } | { allow: false; reason: "RECENT"; minutesAgo: number } | { allow: false; reason: "DAILY_CAP" };

/**
 * Trava 2 (2026-10-03): responde de novo só se a última resposta automática ao contato foi há mais de 10 min
 * e se ainda não passou de 6 na janela de 24 h. `priority` (SAIR/SIM) ignora o intervalo e o teto normal.
 * `sentAtDesc` = instantes das respostas automáticas da janela, da mais recente para a mais antiga.
 */
export function decideAutoreply(sentAtDesc: Date[], now: Date, priority: boolean): AutoreplyDecision {
  const inWindow = sentAtDesc.filter((d) => now.getTime() - d.getTime() < AUTOREPLY_WINDOW_MS);
  if (priority) return inWindow.length >= AUTOREPLY_PRIORITY_HARD_CAP ? { allow: false, reason: "DAILY_CAP" } : { allow: true };
  if (inWindow.length >= AUTOREPLY_DAILY_CAP) return { allow: false, reason: "DAILY_CAP" };
  const last = inWindow[0];
  if (last && now.getTime() - last.getTime() < AUTOREPLY_MIN_GAP_MS) {
    return { allow: false, reason: "RECENT", minutesAgo: Math.max(0, Math.floor((now.getTime() - last.getTime()) / 60_000)) };
  }
  return { allow: true };
}

/** Por que a última mensagem recebida NÃO foi respondida (código gravado no diagnóstico). */
export type SkipReason = "OWN_NUMBER" | "COMPANY_BOT" | "RECENT" | "DAILY_CAP" | "SEND_FAILED" | "NO_EVOLUTION" | "NO_SENDER" | "CONNECTION_RETIRED";

export function describeSkipReason(reason: string | null | undefined, minutesAgo?: number | null): string | null {
  switch (reason) {
    case "OWN_NUMBER":
      return "não respondeu: o número é o próprio WhatsApp de cobrança (ou um que já foi)";
    case "COMPANY_BOT":
      return "não respondeu: o número é o WhatsApp de uma empresa cadastrada";
    case "RECENT":
      return `não respondeu: já respondeu há ${minutesAgo ?? 0} min`;
    case "DAILY_CAP":
      return `não respondeu: já respondeu ${AUTOREPLY_DAILY_CAP} vezes hoje a este contato`;
    case "SEND_FAILED":
      return "não respondeu: o envio falhou (a Evolution recusou ou está fora do ar)";
    case "NO_EVOLUTION":
      return "não respondeu: sem conexão com a Evolution";
    case "NO_SENDER":
      return "não respondeu: a mensagem veio sem número nem identificador do contato";
    case "CONNECTION_RETIRED":
      return "não respondeu: a conexão já foi encerrada";
    default:
      return null;
  }
}
