import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { digitsFromJid, normalizeEvolutionMessage, resolveSenderIdentity } from "../evolution-normalize";

const FIXTURES_DIR = join(process.cwd(), "fixtures", "evolution");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf-8"));
}

describe("normalizeEvolutionMessage", () => {
  it("texto simples (message.conversation)", () => {
    const result = normalizeEvolutionMessage(loadFixture("text-conversation.json"));
    expect(result).toMatchObject({ kind: "message", fromMe: false, content: { type: "text", text: "2" } });
    if (result.kind === "message") {
      expect(result.jid).toBe("5511988887777@s.whatsapp.net");
      expect(result.providerMessageId).toBe("3EB0C767D26A1D2F1234");
    }
  });

  it("texto com citação (message.extendedTextMessage.text)", () => {
    const result = normalizeEvolutionMessage(loadFixture("text-extended.json"));
    expect(result).toMatchObject({ kind: "message", content: { type: "text", text: "Quero remarcar" } });
  });

  it("@lid com remoteJidAlt resolve para o número real", () => {
    const result = normalizeEvolutionMessage(loadFixture("lid-sender.json"));
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    expect(result.jid).toBe("184926574839201@lid");
    expect(result.altJid).toBe("5511977776666@s.whatsapp.net");

    const identity = resolveSenderIdentity(result);
    expect(identity).toEqual({ waJid: "5511977776666@s.whatsapp.net", lid: "184926574839201@lid" });
  });

  it("@lid sem alternativa não resolve waJid (fica UNRESOLVABLE_SENDER a cargo do claim)", () => {
    const result = normalizeEvolutionMessage(loadFixture("lid-sender-no-alt.json"));
    expect(result.kind).toBe("message");
    if (result.kind !== "message") return;
    const identity = resolveSenderIdentity(result);
    expect(identity).toEqual({ waJid: null, lid: "184926574839202@lid" });
  });

  it("mensagem de grupo (@g.us) vira unsupported/GROUP", () => {
    const result = normalizeEvolutionMessage(loadFixture("group-message.json"));
    expect(result).toEqual({ kind: "unsupported", reason: "GROUP" });
  });

  it("mídia vira content type media", () => {
    const result = normalizeEvolutionMessage(loadFixture("media-message.json"));
    expect(result).toMatchObject({ kind: "message", content: { type: "media" } });
  });

  it("fromMe: true é reconhecido", () => {
    const result = normalizeEvolutionMessage(loadFixture("from-me.json"));
    expect(result).toMatchObject({ kind: "message", fromMe: true });
  });

  it("evento connection.update não é uma mensagem (claim não trata; /connection-events trata)", () => {
    const result = normalizeEvolutionMessage(loadFixture("connection-update.json"));
    expect(result).toEqual({ kind: "unsupported", reason: "UNSUPPORTED_EVENT" });
  });

  it("payload lixo nunca lança — sempre unsupported/UNSUPPORTED_EVENT", () => {
    const result = normalizeEvolutionMessage(loadFixture("garbage.json"));
    expect(result).toEqual({ kind: "unsupported", reason: "UNSUPPORTED_EVENT" });
  });

  it("payloads totalmente inválidos (null, array, string, number) nunca lançam", () => {
    for (const bad of [null, undefined, [], "string", 42, {}]) {
      expect(() => normalizeEvolutionMessage(bad)).not.toThrow();
      expect(normalizeEvolutionMessage(bad)).toEqual({ kind: "unsupported", reason: "UNSUPPORTED_EVENT" });
    }
  });
});

describe("digitsFromJid", () => {
  it("extrai os dígitos exatamente como recebidos, sem reconstituir o 9º dígito", () => {
    expect(digitsFromJid("5511988887777@s.whatsapp.net")).toBe("5511988887777");
  });
});

/**
 * Respostas interativas. ⚠️ Payloads montados a partir do código-fonte da Evolution 2.3.7
 * (whatsapp.baileys.service.ts) e dos protos do Baileys — NÃO capturados de um aparelho real ainda
 * (ver docs/whatsapp-botoes-listas.md). Se o teste no celular mostrar outro formato, ajustar aqui.
 */
function upsertWith(message: Record<string, unknown>, extraData: Record<string, unknown> = {}): unknown {
  return {
    event: "messages.upsert",
    instance: "innochat-x",
    data: {
      key: { remoteJid: "5511988887777@s.whatsapp.net", fromMe: false, id: "3EB0INTERACTIVE01" },
      pushName: "Cliente",
      messageTimestamp: 1_790_000_000,
      message,
      ...extraData,
    },
  };
}

function textOf(payload: unknown): string | null {
  const result = normalizeEvolutionMessage(payload);
  if (result.kind !== "message") return null;
  return result.content.type === "text" ? result.content.text : `media:${result.content.label}`;
}

describe("normalizeEvolutionMessage — respostas de botões, lista e enquete", () => {
  it("botão nativo (interactiveResponseMessage/quick_reply) vira o id do botão", () => {
    const payload = upsertWith({
      interactiveResponseMessage: {
        body: { text: "Corte" },
        nativeFlowResponseMessage: { name: "quick_reply", paramsJson: JSON.stringify({ display_text: "Corte", id: "1" }), version: 3 },
      },
    });
    expect(textOf(payload)).toBe("1");
  });

  it("botão nativo com id numérico no JSON", () => {
    const payload = upsertWith({
      interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":2,"display_text":"Escova"}' } },
    });
    expect(textOf(payload)).toBe("2");
  });

  it("botão nativo sem id cai para o display_text", () => {
    const payload = upsertWith({
      interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"display_text":"Coloração"}' } },
    });
    expect(textOf(payload)).toBe("Coloração");
  });

  it("paramsJson malformado usa o texto do corpo; sem nada vira mídia (não fica mudo)", () => {
    expect(textOf(upsertWith({ interactiveResponseMessage: { body: { text: "Corte" }, nativeFlowResponseMessage: { paramsJson: "{oops" } } }))).toBe("Corte");
    expect(textOf(upsertWith({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: "{oops" } } }))).toBe("media:[resposta interativa]");
  });

  it("botão legado (buttonsResponseMessage) vira selectedButtonId", () => {
    const payload = upsertWith({ buttonsResponseMessage: { selectedButtonId: "3", selectedDisplayText: "Coloração", type: 1 } });
    expect(textOf(payload)).toBe("3");
  });

  it("templateButtonReplyMessage vira selectedId", () => {
    expect(textOf(upsertWith({ templateButtonReplyMessage: { selectedId: "2", selectedDisplayText: "Escova", selectedIndex: 1 } }))).toBe("2");
  });

  it("lista (listResponseMessage) vira o rowId", () => {
    const payload = upsertWith({
      listResponseMessage: { title: "Escova", listType: 1, singleSelectReply: { selectedRowId: "2" }, description: "R$ 60" },
    });
    expect(textOf(payload)).toBe("2");
  });

  it("enquete decifrada pela Evolution: pollUpdates com voters vira o número do início do nome", () => {
    const payload = upsertWith(
      { pollUpdateMessage: { pollCreationMessageKey: { id: "POLL1" }, vote: { selectedOptions: ["1 - Corte"] } } },
      {
        pollUpdates: [
          { name: "1 - Corte", voters: ["5511988887777@s.whatsapp.net"] },
          { name: "2 - Escova", voters: [] },
        ],
      },
    );
    expect(textOf(payload)).toBe("1");
  });

  it("enquete com opção sem número usa o nome da opção", () => {
    const payload = upsertWith(
      { pollUpdateMessage: { vote: {} } },
      { pollUpdates: [{ name: "2 horas de espera", voters: ["x"] }, { name: "Corte", voters: [] }] },
    );
    expect(textOf(payload)).toBe("2 horas de espera");
  });

  it("enquete sem pollUpdates: aceita vote.selectedOptions só se NÃO estiver cifrado", () => {
    expect(textOf(upsertWith({ pollUpdateMessage: { vote: { selectedOptions: ["3) Coloração"] } } }))).toBe("3");
    expect(textOf(upsertWith({ pollUpdateMessage: { vote: { encPayload: "AAAA", encIv: "BBBB" } } }))).toBe("media:[resposta interativa]");
    expect(textOf(upsertWith({ pollUpdateMessage: { vote: { encPayload: "AAAA", selectedOptions: ["qualquerhashbase64="] } } }))).toBe("media:[resposta interativa]");
  });

  it("voto removido (nenhuma opção marcada) não vira texto", () => {
    const payload = upsertWith({ pollUpdateMessage: { vote: {} } }, { pollUpdates: [{ name: "1 - Corte", voters: [] }] });
    expect(textOf(payload)).toBe("media:[resposta interativa]");
  });

  it("mensagem de conversa temporária (ephemeralMessage) é desembrulhada", () => {
    expect(textOf(upsertWith({ ephemeralMessage: { message: { conversation: "2" } } }))).toBe("2");
    expect(
      textOf(upsertWith({ ephemeralMessage: { message: { listResponseMessage: { singleSelectReply: { selectedRowId: "3" } } } } })),
    ).toBe("3");
  });
});

describe("telefone por trás do @lid (Evolution v2.3 / Baileys 7)", () => {
  const withKey = (key: Record<string, unknown>, data: Record<string, unknown> = {}) => ({
    event: "messages.upsert",
    data: { key: { remoteJid: "98765432101234@lid", fromMe: false, id: "M1", ...key }, message: { conversation: "oi" }, ...data },
  });
  const identityOf = (payload: unknown) => {
    const n = normalizeEvolutionMessage(payload);
    if (n.kind !== "message") throw new Error("não é mensagem");
    return resolveSenderIdentity(n);
  };

  it.each([
    ["key.remoteJidAlt", withKey({ remoteJidAlt: "5584999998888@s.whatsapp.net" })],
    ["key.senderPn", withKey({ senderPn: "5584999998888@s.whatsapp.net" })],
    ["key.participantPn", withKey({ participantPn: "5584999998888@s.whatsapp.net" })],
    ["data.senderPn", withKey({}, { senderPn: "5584999998888@s.whatsapp.net" })],
    ["data.remoteJidAlt", withKey({}, { remoteJidAlt: "5584999998888@s.whatsapp.net" })],
    ["telefone só com dígitos", withKey({ senderPn: "5584999998888" })],
  ])("acha o telefone em %s", (_label, payload) => {
    expect(identityOf(payload)).toEqual({ waJid: expect.stringContaining("5584999998888"), lid: "98765432101234@lid" });
  });

  it("não aceita outro @lid nem lixo como telefone: continua sem waJid", () => {
    expect(identityOf(withKey({ remoteJidAlt: "11111111111111@lid", senderPn: "status", participantPn: "abc@s.whatsapp.net" }))).toEqual({ waJid: null, lid: "98765432101234@lid" });
  });
});
