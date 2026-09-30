import { describe, expect, it } from "vitest";
import { buildOptions, renderMessage, renderMessages, renderTemplateV2 } from "../index";

const TEXTS = {
  GREETING: "Olá, {nome}! 👋\nBoas-vindas à *{empresa}*.",
  MENU_PROMPT: "Como posso ajudar você hoje?",
  MENU_HINT: "_Responda com o número ou o nome da opção._",
  FOOTER_HINT: "_Digite *0* para o menu ou *voltar* para a etapa anterior._",
  CONFIRM_SUMMARY:
    "*Confira os dados do agendamento*\n\n*Serviço:* {servico}\n*Profissional:* {profissional}\n*Data:* {data_longa}\n*Horário:* {hora} _(duração de {duracao})_\n*Valor:* {preco}\n*Nome:* {nome}\n\nEstá tudo certo?",
  CHOOSE_DAY: "*Para qual dia?*\n_{servico} · {profissional}_\n\nEscolha uma opção.",
  THANKS_REPLY: "Por nada, {nome}! Quando precisar, é só mandar uma mensagem. 👋",
};
const LITERAL_VAR = /\{[A-Za-z_]+\}/;

describe("renderTemplateV2 (CA-38..40)", () => {
  it("variável ausente, nula ou vazia vira vazio, nunca literal", () => {
    expect(renderTemplateV2("a {x} b {y} c {z}", { x: null, y: "" })).toBe("a b c");
    expect(renderTemplateV2("{qualquer}", {})).toBe("");
  });
  it("Olá, ! vira Olá!", () => {
    expect(renderTemplateV2(TEXTS.GREETING, { empresa: "Studio", nome: "" })).toBe("Olá! 👋\nBoas-vindas à *Studio*.");
    expect(renderTemplateV2(TEXTS.THANKS_REPLY, { nome: null })).toBe("Por nada! Quando precisar, é só mandar uma mensagem. 👋");
  });
  it.each([".", "~", "  ", "*", "-"])("pushName %j equivale a vazio", (nome) => {
    const out = renderTemplateV2(TEXTS.GREETING, { empresa: "Studio", nome });
    expect(out).not.toContain("Olá, !");
    expect(out.startsWith("Olá!")).toBe(true);
  });
  it("com nome", () => {
    expect(renderTemplateV2(TEXTS.GREETING, { empresa: "Studio", nome: "Maria" })).toBe("Olá, Maria! 👋\nBoas-vindas à *Studio*.");
  });
  it("valores perdem * _ ~ ` (CA-40)", () => {
    expect(renderTemplateV2("*{servico}*", { servico: "Corte *VIP*_2" })).toBe("*Corte VIP2*");
    expect(renderTemplateV2("{a}", { a: "x~y`z" })).toBe("xyz");
  });
  it("valor não reintroduz variável literal", () => {
    expect(renderTemplateV2("{nome}", { nome: "{empresa}" })).not.toMatch(LITERAL_VAR);
  });
  it("linha só com rótulo some (sem preço)", () => {
    const out = renderTemplateV2(TEXTS.CONFIRM_SUMMARY, {
      servico: "Corte",
      profissional: "Ana",
      data_longa: "sexta-feira, 02/10",
      hora: "15:00",
      duracao: "1h",
      preco: null,
      nome: "Maria",
    });
    expect(out).not.toContain("Valor");
    expect(out).toContain("*Horário:* 15:00 _(duração de 1h)_");
    expect(out).not.toMatch(/\n{3,}/);
  });
  it("separador órfão quando falta profissional", () => {
    expect(renderTemplateV2(TEXTS.CHOOSE_DAY, { servico: "Corte", profissional: "" })).toBe(
      "*Para qual dia?*\n_Corte_\n\nEscolha uma opção.",
    );
  });
  it("3+ quebras viram 2 e espaços duplos somem", () => {
    expect(renderTemplateV2("a\n\n\n\nb  c", {})).toBe("a\n\nb c");
    expect(renderTemplateV2("oi , tudo ?", {})).toBe("oi, tudo?");
  });
});

describe("renderMessage", () => {
  const options = buildOptions({
    items: [
      { id: "s1", title: "Corte *VIP*", detail: "1h · R$ 80,00" },
      { id: "s2", title: "Escova", detail: null },
    ],
    labels: { more: "Ver mais", prev: "Ver anteriores" },
  });
  it("blocos separados por linha em branco, opções com keycap, rodapé por último (CA-41)", () => {
    const msg = renderMessage(
      [
        { key: "GREETING", vars: { nome: "Maria", empresa: "Studio" } },
        { key: "MENU_PROMPT", options, footer: "MENU_HINT" },
      ],
      TEXTS,
    );
    expect(msg).toBe(
      "Olá, Maria! 👋\nBoas-vindas à *Studio*.\n\nComo posso ajudar você hoje?\n\n1️⃣ Corte VIP — _1h · R$ 80,00_\n2️⃣ Escova\n\n_Responda com o número ou o nome da opção._",
    );
  });
  it("rodapé vai para o fim mesmo com bloco depois", () => {
    const msg = renderMessage([{ key: "MENU_PROMPT", options, footer: "FOOTER_HINT" }, { key: "THANKS_REPLY", vars: {} }], TEXTS);
    expect(msg.endsWith(TEXTS.FOOTER_HINT)).toBe(true);
  });
  it("nunca deixa variável literal nem 2 linhas em branco (CA-38/39)", () => {
    const msg = renderMessage(
      [{ key: "GREETING", vars: { nome: ".", empresa: undefined } }, { key: "CHOOSE_DAY", vars: {} }],
      TEXTS,
    );
    expect(msg).not.toMatch(LITERAL_VAR);
    expect(msg).not.toMatch(/\n{3,}/);
    expect(msg).not.toContain(", !");
  });
  it("chave ausente lança", () => {
    expect(() => renderMessage([{ key: "NAO_EXISTE" }], TEXTS)).toThrow(/NAO_EXISTE/);
  });
});

describe("renderMessages (várias mensagens por resposta)", () => {
  const opts = buildOptions({ items: [{ id: "A", title: "Agendar outro" }], labels: { more: "Ver mais", prev: "Anteriores" } });
  it("sem newMessage sai uma mensagem só, igual ao renderMessage", () => {
    const blocks = [{ key: "GREETING", vars: { nome: "Ana", empresa: "Studio" } }, { key: "MENU_PROMPT", options: opts, footer: "MENU_HINT" as const }];
    expect(renderMessages(blocks, TEXTS)).toEqual([renderMessage(blocks, TEXTS)]);
  });
  it("newMessage abre uma segunda mensagem, cada uma com o próprio rodapé", () => {
    const msgs = renderMessages(
      [{ key: "THANKS_REPLY", vars: { nome: "Ana" } }, { key: "MENU_PROMPT", options: opts, footer: "FOOTER_HINT", newMessage: true }],
      TEXTS,
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toBe("Por nada, Ana! Quando precisar, é só mandar uma mensagem. 👋");
    expect(msgs[1]).toContain("Como posso ajudar você hoje?");
    expect(msgs[1]).toContain("1️⃣ Agendar outro");
    expect(msgs[1].endsWith(TEXTS.FOOTER_HINT)).toBe(true);
    expect(msgs[0]).not.toContain(TEXTS.FOOTER_HINT);
  });
  it("newMessage no 1º bloco não cria mensagem vazia; mensagem vazia é descartada", () => {
    expect(renderMessages([{ key: "THANKS_REPLY", vars: { nome: "Ana" }, newMessage: true }], TEXTS)).toHaveLength(1);
    expect(renderMessages([], TEXTS)).toEqual([]);
  });
  it("renderMessage junta as mensagens com 1 linha em branco (prévia do painel)", () => {
    const blocks = [{ key: "THANKS_REPLY", vars: { nome: "Ana" } }, { key: "CHOOSE_DAY", vars: {}, newMessage: true }];
    expect(renderMessage(blocks, TEXTS)).toBe(renderMessages(blocks, TEXTS).join("\n\n"));
  });
});
