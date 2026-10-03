/**
 * Normalização PURA do payload de webhook da Evolution API v2 (docs/arquitetura.md §6.9).
 * Sem I/O, sem Prisma, sem Next — só transforma o corpo bruto do webhook num formato estável
 * que `src/modules/bot-api/claim.ts` consome. Isolado de propósito: quando os payloads REAIS
 * chegarem (Fase 0, ainda pendente — ver `fixtures/evolution/README.md`), só este arquivo (e as
 * fixtures) deve precisar mudar.
 *
 * Formato esperado (arquitetura.md §6.9, baseado na documentação pública — NÃO capturado do
 * servidor real ainda):
 *   { event, instance, data: { key: { remoteJid, remoteJidAlt?, fromMe, id }, pushName,
 *     message: { conversation | extendedTextMessage.text }, messageType, messageTimestamp },
 *     date_time, apikey }
 */

/** `label` = marcador de exibição para o histórico ("[imagem]"...) — nunca o binário nem a legenda. */
export type NormalizedMessageContent = { type: "text"; text: string } | { type: "media"; label: string };

const MEDIA_LABELS: Record<string, string> = {
  imageMessage: "[imagem]",
  audioMessage: "[áudio]",
  videoMessage: "[vídeo]",
  documentMessage: "[documento]",
  documentWithCaptionMessage: "[documento]",
  stickerMessage: "[figurinha]",
  ptvMessage: "[vídeo]",
  contactMessage: "[contato]",
  locationMessage: "[localização]",
};

export type NormalizedMessage = {
  kind: "message";
  providerMessageId: string;
  fromMe: boolean;
  /** `key.remoteJid` exatamente como recebido — pode terminar em `@lid`, `@s.whatsapp.net` etc. */
  jid: string;
  /** `key.remoteJidAlt` ou `data.senderPn`, quando presentes (resolução de `@lid`, §6.9). */
  altJid: string | null;
  pushName: string | null;
  /** Instante da mensagem, já em milissegundos (a Evolution manda em segundos). */
  timestampMs: number;
  content: NormalizedMessageContent;
};

export type NormalizedUnsupported = {
  kind: "unsupported";
  /** `GROUP` quando reconhecemos o evento mas é de um grupo (`@g.us`); `UNSUPPORTED_EVENT` para
   * qualquer outra coisa que não seja uma mensagem individual reconhecível. */
  reason: "GROUP" | "UNSUPPORTED_EVENT";
};

export type NormalizedEvolutionEvent = NormalizedMessage | NormalizedUnsupported;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    // A Evolution manda `messageTimestamp` em segundos (padrão do WhatsApp/Baileys); valores já
    // em milissegundos (> ~10^12) são aceitos sem conversão, defensivamente.
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
    return normalizeTimestamp(Number(value));
  }
  return Date.now();
}

/** Envelopes que só embrulham a mensagem de verdade (conversa com mensagens temporárias, "ver uma vez"...). */
const WRAPPER_KEYS = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "deviceSentMessage"] as const;

function unwrapMessage(message: Record<string, unknown>): Record<string, unknown> {
  let current = message;
  for (let depth = 0; depth < 4; depth++) {
    const key = WRAPPER_KEYS.find((k) => isRecord(current[k]));
    const inner = key ? (current[key] as Record<string, unknown>).message : undefined;
    if (!isRecord(inner)) break;
    current = inner;
  }
  return current;
}

/**
 * Primeiro valor que seja um telefone (`<dígitos>@s.whatsapp.net` ou só dígitos). Nunca aceita `@lid`: o ponto é justamente
 * achar o número por trás do LID. A Evolution v2.3 (Baileys 7) pode mandar em `key.remoteJidAlt`, `key.senderPn`,
 * `key.participantPn` ou nos mesmos nomes dentro de `data`.
 */
function pickPhoneJid(candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const value = candidate.trim();
    if (!value || value.endsWith("@lid")) continue;
    const user = value.split("@")[0] ?? "";
    if (/^[0-9]{8,20}$/.test(user) && (!value.includes("@") || value.endsWith("@s.whatsapp.net"))) return value;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resposta a mensagem interativa (botão / lista / enquete) → o TEXTO equivalente ao que o cliente
 * digitaria (o `id` do botão/linha, que o InnoChat monta como o número da opção). Assim o motor do
 * n8n não muda. `null` = não é resposta interativa. `""` = é, mas não dá para extrair (ex.: voto
 * de enquete removido/cifrado) — o chamador decide o que fazer.
 * Formatos (Baileys/Evolution 2.3.x; docs/whatsapp-botoes-listas.md):
 * - `buttonsResponseMessage.selectedButtonId` (botão legado);
 * - `templateButtonReplyMessage.selectedId`;
 * - `listResponseMessage.singleSelectReply.selectedRowId` (lista);
 * - `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` (JSON com `id`) — é o que os
 *   botões `quick_reply` da Evolution 2.3.x devolvem;
 * - `pollUpdateMessage` (enquete): a Evolution decifra o voto e preenche `data.pollUpdates`
 *   (`[{name, voters}]`) e `vote.selectedOptions` (nomes). O nome pode começar com o número da
 *   opção ("1 - Corte"), que é o que vira o texto.
 */
function extractInteractiveReply(message: Record<string, unknown>, data: Record<string, unknown>): string | null {
  const buttons = message.buttonsResponseMessage;
  if (isRecord(buttons)) return nonEmptyString(buttons.selectedButtonId) ?? nonEmptyString(buttons.selectedDisplayText) ?? "";

  const template = message.templateButtonReplyMessage;
  if (isRecord(template)) return nonEmptyString(template.selectedId) ?? nonEmptyString(template.selectedDisplayText) ?? "";

  const list = message.listResponseMessage;
  if (isRecord(list)) {
    const reply = list.singleSelectReply;
    const rowId = isRecord(reply) ? nonEmptyString(reply.selectedRowId) : null;
    return rowId ?? nonEmptyString(list.title) ?? "";
  }

  const interactive = message.interactiveResponseMessage;
  if (isRecord(interactive)) {
    const flow = interactive.nativeFlowResponseMessage;
    if (isRecord(flow) && typeof flow.paramsJson === "string") {
      try {
        const params: unknown = JSON.parse(flow.paramsJson);
        if (isRecord(params)) {
          const id = typeof params.id === "number" ? String(params.id) : nonEmptyString(params.id);
          return id ?? nonEmptyString(params.display_text) ?? nonEmptyString(params.title) ?? "";
        }
      } catch {
        // paramsJson malformado: cai para o texto do corpo, se houver
      }
    }
    const body = interactive.body;
    return (isRecord(body) ? nonEmptyString(body.text) : null) ?? "";
  }

  const poll = message.pollUpdateMessage;
  if (isRecord(poll)) {
    const names: string[] = [];
    if (Array.isArray(data.pollUpdates)) {
      for (const update of data.pollUpdates) {
        if (isRecord(update) && Array.isArray(update.voters) && update.voters.length > 0) {
          const name = nonEmptyString(update.name);
          if (name) names.push(name);
        }
      }
    } else if (isRecord(poll.vote) && !poll.vote.encPayload && Array.isArray(poll.vote.selectedOptions)) {
      for (const option of poll.vote.selectedOptions) {
        const name = nonEmptyString(option);
        if (name) names.push(name);
      }
    }
    const first = names[0];
    if (!first) return "";
    const numbered = /^(\d{1,2})\s*(?:[-–.)]|$)/.exec(first);
    return numbered ? numbered[1]! : first;
  }

  return null;
}

function extractContent(rawMessage: unknown, data: Record<string, unknown> = {}): NormalizedMessageContent {
  if (!isRecord(rawMessage)) return { type: "media", label: "[mídia]" };
  const message = unwrapMessage(rawMessage);
  if (typeof message.conversation === "string" && message.conversation.length > 0) {
    return { type: "text", text: message.conversation };
  }
  const extended = message.extendedTextMessage;
  if (isRecord(extended) && typeof extended.text === "string" && extended.text.length > 0) {
    return { type: "text", text: extended.text };
  }
  const reply = extractInteractiveReply(message, data);
  if (reply !== null) {
    // Resposta interativa que não deu para ler (voto removido, enquete sem chave para decifrar):
    // vira "mídia" para o bot responder o aviso padrão em vez de ficar mudo.
    return reply ? { type: "text", text: reply } : { type: "media", label: "[resposta interativa]" };
  }
  // Qualquer outro tipo (imageMessage, videoMessage, audioMessage, documentMessage,
  // stickerMessage, ...) vira "media" — o n8n responde com o texto ONLY_TEXT (§2 regra 6).
  const known = Object.keys(MEDIA_LABELS).find((k) => k in message);
  return { type: "media", label: known ? MEDIA_LABELS[known] : "[mídia]" };
}

/**
 * Extrai a mensagem individual de um evento `messages.upsert`. Qualquer formato inesperado
 * (evento diferente, corpo malformado, sem `data`/`key`) vira `unsupported/UNSUPPORTED_EVENT` —
 * NUNCA lança. É essa garantia que permite ao endpoint `/messages/claim` nunca devolver 5xx para
 * um payload irreconhecível (docs/arquitetura.md §6.2).
 */
export function normalizeEvolutionMessage(payload: unknown): NormalizedEvolutionEvent {
  if (!isRecord(payload)) return { kind: "unsupported", reason: "UNSUPPORTED_EVENT" };
  if (payload.event !== "messages.upsert") return { kind: "unsupported", reason: "UNSUPPORTED_EVENT" };

  const data = payload.data;
  if (!isRecord(data)) return { kind: "unsupported", reason: "UNSUPPORTED_EVENT" };

  const key = data.key;
  if (!isRecord(key)) return { kind: "unsupported", reason: "UNSUPPORTED_EVENT" };

  const remoteJid = typeof key.remoteJid === "string" && key.remoteJid.length > 0 ? key.remoteJid : null;
  const providerMessageId = typeof key.id === "string" && key.id.length > 0 ? key.id : null;
  if (!remoteJid || !providerMessageId) return { kind: "unsupported", reason: "UNSUPPORTED_EVENT" };

  if (remoteJid.endsWith("@g.us")) return { kind: "unsupported", reason: "GROUP" };

  const altJidRaw =
    pickPhoneJid([key.remoteJidAlt, key.senderPn, key.participantPn, data.remoteJidAlt, data.senderPn, data.participantPn]) ||
    // (senderPn e afins já entram no pickPhoneJid acima)
    null;

  return {
    kind: "message",
    providerMessageId,
    fromMe: key.fromMe === true,
    jid: remoteJid,
    altJid: altJidRaw,
    pushName: typeof data.pushName === "string" ? data.pushName : null,
    timestampMs: normalizeTimestamp(data.messageTimestamp),
    content: extractContent(data.message, data),
  };
}

/**
 * Identidade a usar para resolver/gravar o `Contact` (docs/arquitetura.md §6.9, "@lid"):
 * - JID normal (`...@s.whatsapp.net`) → usa direto, sem `lid`.
 * - JID `@lid` COM alternativa (`remoteJidAlt`/`senderPn`) → usa a alternativa como `waJid` e
 *   guarda o `@lid` original em `Contact.lid` (para reconhecer da próxima vez, se a Evolution
 *   parar de mandar a alternativa).
 * - JID `@lid` SEM alternativa → não dá pra resolver um `waJid` novo aqui; o chamador procura um
 *   `Contact.lid` já conhecido, e se não achar, é `UNRESOLVABLE_SENDER`.
 */
export function resolveSenderIdentity(message: NormalizedMessage): { waJid: string | null; lid: string | null } {
  if (message.jid.endsWith("@lid")) {
    if (message.altJid) return { waJid: message.altJid, lid: message.jid };
    return { waJid: null, lid: message.jid };
  }
  return { waJid: message.jid, lid: null };
}

/** Dígitos do JID, exatamente como recebido (docs/arquitetura.md §6.9) — só para exibição/envio. */
export function digitsFromJid(jid: string): string {
  return jid.split("@")[0] ?? jid;
}
