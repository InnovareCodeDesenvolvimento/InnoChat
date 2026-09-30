// Cliente de WhatsApp falso: monta payloads no formato da Evolution, passa pelo Engine e devolve o que o bot enviaria.
export class World {
  constructor(engine) {
    this.engine = engine;
    this.seq = 0;
  }
}

export class Chat {
  constructor(world, token, phone, { pushName = "Maria Souza" } = {}) {
    Object.assign(this, { world, token, phone, pushName });
    this.log = [];
    this.jid = `${phone}@s.whatsapp.net`;
  }

  payload(kind, text, id, ts, fromMe = false) {
    const message =
      kind === "text" ? { conversation: text }
      : kind === "extended" ? { extendedTextMessage: { text } }
      : kind === "audio" ? { audioMessage: { url: "x", seconds: 3 } }
      : kind === "image" ? { imageMessage: { caption: text } }
      : kind === "sticker" ? { stickerMessage: {} }
      : kind === "location" ? { locationMessage: { degreesLatitude: 1 } }
      : kind === "empty" ? { conversation: "" }
      : { reactionMessage: { text: "x" } };
    return {
      event: "messages.upsert",
      instance: "botsim",
      data: { key: { remoteJid: this.jid, fromMe, id }, pushName: this.pushName, message, messageType: kind, messageTimestamp: Math.floor(ts / 1000) },
    };
  }

  /** Envia uma mensagem e devolve { msgs, error, trace, claim, id, res }. Opções: kind, id, ts, fromMe, faults (injeção de falha, ver engine.mjs). `res.release` = resposta do release quando a execução morreu. */
  async say(text, o = {}) {
    const id = o.id || `SIM${Date.now().toString(36)}${++this.world.seq}`;
    const res = await this.world.engine.run({ token: this.token, body: this.payload(o.kind || "text", text, id, o.ts || Date.now(), o.fromMe) }, { faults: o.faults });
    const msgs = res.outbox.map((b) => b.text);
    const claim = res.nodeOut.get("Claim")?.[0]?.json;
    this.log.push({ in: o.kind && o.kind !== "text" ? `[${o.kind}]` : text, msgs, error: res.error, claim: claim && claim.action, reason: claim && claim.reason });
    return { msgs, error: res.error, trace: res.trace, claim, id, res };
  }

  transcript(title) {
    const body = this.log
      .map((e) => {
        const tag = e.claim && e.claim !== "process" ? `  _(claim=${e.claim}${e.reason ? "/" + e.reason : ""})_` : "";
        const out = e.msgs.length ? e.msgs.map((m) => "```\n" + m + "\n```").join("\n") : "_(bot não respondeu)_";
        return `> **cliente:** ${JSON.stringify(e.in)}${tag}\n${out}${e.error ? `\n**ERRO n8n:** ${e.error}` : ""}`;
      })
      .join("\n\n");
    return `\n### ${title}\n\n${body}\n`;
  }
}
