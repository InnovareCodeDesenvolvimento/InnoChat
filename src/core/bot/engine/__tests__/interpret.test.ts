import { describe, expect, it } from "vitest";
import { buildOptions, interpret, type Intent, type OptionV2 } from "../index";

const clock = { today: "2026-09-30", nowLocal: "10:00" };
const opts = (list: [string, string, Partial<OptionV2>?][]): OptionV2[] =>
  list.map(([id, title, extra], i) => ({ n: i + 1, id, title, ...(extra ?? {}) }));

const MAIN = opts([["BOOK", "Agendar horário"], ["MY", "Meus agendamentos"], ["HUMAN", "Falar com atendente"]]);
const CONFIRM = opts([["CONFIRM", "Confirmar"], ["EDIT", "Corrigir dados"]]);
const run = (state: string, text: string | null, options: OptionV2[] = []): Intent =>
  interpret({ state, text, options, clock });
const optionId = (i: Intent) => (i.kind === "option" ? i.option.id : `(${i.kind})`);

describe("interpret: comandos (CA-01, CA-03, CA-05, CA-28)", () => {
  it.each(["Menu", "MENU", "menú", "0", "0️⃣", "início", "menu principal"])(
    "%j -> MENU em qualquer estado, inclusive ASK_NAME",
    (t) => {
      for (const state of ["SELECT_DAY", "ASK_NAME", "CONFIRM"]) {
        expect(run(state, t, CONFIRM)).toEqual({ kind: "command", command: "MENU" });
      }
    },
  );
  it.each([
    ["voltar", "BACK"], ["#", "BACK"], ["sair", "EXIT"], ["tchau", "EXIT"], ["Atendente", "HUMAN"],
    ["falar com alguém", "HUMAN"], ["ajuda", "HELP"], ["?", "HELP"], ["oi", "GREETING"], ["Bom dia!", "GREETING"],
    ["oi, boa tarde", "GREETING"], ["obrigada", "THANKS"], ["valeu", "THANKS"], ["🙏", "THANKS"],
  ])("%j -> %s", (t, command) => {
    expect(run("SELECT_TIME", t)).toEqual({ kind: "command", command });
  });
  it("a mensagem inteira: 'quero voltar amanhã' não é o comando voltar", () => {
    expect(run("SELECT_DAY", "quero voltar amanhã").kind).not.toBe("command");
  });
  it("mídia", () => {
    expect(run("SELECT_DAY", null)).toEqual({ kind: "media" });
  });
});

describe("interpret: CONFIRM (CA-13)", () => {
  it.each(["sim", "s", "ok", "confirmo", "isso", "pode ser", "Confirmar!", "👍", "👍🏽", "✅", "1", "1️⃣", "confirmar"])(
    "%j confirma",
    (t) => {
      expect(optionId(run("CONFIRM", t, CONFIRM))).toBe("CONFIRM");
    },
  );
  it.each(["não", "n", "nao", "❌", "2", "corrigir"])("%j abre a correção", (t) => {
    expect(optionId(run("CONFIRM", t, CONFIRM))).toBe("EDIT");
  });
  it("'ok' fora de CONFIRM é cortesia", () => {
    expect(run("POST_ACTION", "ok")).toEqual({ kind: "command", command: "THANKS" });
  });
});

describe("interpret: menu e números (CA-07, CA-43)", () => {
  it.each(["2", "2️⃣", "opção 2", "2.", "2)", "#2", " 02 ", "meus", "cancelar", "remarcar"])("%j -> MY", (t) => {
    expect(optionId(run("MAIN_MENU", t, MAIN))).toBe("MY");
  });
  it("texto editável do menu não muda a ação do 2", () => {
    const custom = opts([["BOOK", "Marcar consulta"], ["MY", "Ver minhas consultas"], ["HUMAN", "Humano"]]);
    expect(optionId(run("MAIN_MENU", "2", custom))).toBe("MY");
  });
  it("número fora das opções é inválido", () => {
    expect(run("MAIN_MENU", "7", MAIN)).toEqual({ kind: "invalid" });
  });
  it("via", () => {
    expect(run("MAIN_MENU", "2", MAIN)).toMatchObject({ via: "number" });
    expect(run("MAIN_MENU", "agendar", MAIN)).toMatchObject({ via: "alias" });
  });
});

describe("interpret: texto contra opções (CA-06)", () => {
  const services = opts([
    ["s1", "Corte feminino", { match: "corte feminino" }],
    ["s2", "Corte masculino"],
    ["s3", "Escova"],
    ["s4", "Coloração"],
  ]);
  it.each(["escova", "ESCOVA", "Escóva", "quero escova"])("%j escolhe Escova", (t) => {
    expect(optionId(run("SELECT_SERVICE", t, services))).toBe("s3");
  });
  it("'corte' com 2 cortes é ambíguo, só com os 2, renumerados 1 e 2", () => {
    const r = run("SELECT_SERVICE", "corte", services);
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") {
      expect(r.candidates.map((c) => [c.n, c.id])).toEqual([[1, "s1"], [2, "s2"]]);
    }
  });
  it("candidatas renumeradas mesmo quando não eram as primeiras", () => {
    const list = opts([["a", "Escova"], ["b", "Corte feminino"], ["c", "Corte masculino"]]);
    const r = run("SELECT_SERVICE", "corte", list);
    expect(r.kind === "ambiguous" && r.candidates.map((c) => [c.n, c.id])).toEqual([[1, "b"], [2, "c"]]);
  });
  it("igualdade exata vence o parcial", () => {
    const list = opts([["a", "Corte"], ["b", "Corte feminino"]]);
    expect(optionId(run("SELECT_SERVICE", "corte", list))).toBe("a");
  });
  it("palavra a mais na frase inutiliza o casamento parcial", () => {
    expect(run("SELECT_SERVICE", "escova progressiva", services)).toEqual({ kind: "invalid" });
  });
  it("aliases da opção", () => {
    const list = opts([["p1", "Ana", { aliases: ["aninha"] }]]);
    expect(run("SELECT_PROFESSIONAL", "aninha", list)).toMatchObject({ kind: "option", via: "alias" });
  });
  it("paginação", () => {
    const list = buildOptions({
      items: [{ id: "d1", title: "Hoje" }],
      hasMore: true,
      hasPrev: true,
      labels: { more: "Ver mais datas", prev: "Ver anteriores" },
    });
    expect(optionId(run("SELECT_TIME", "ver mais", list))).toBe("MORE");
    expect(optionId(run("SELECT_TIME", "anteriores", list))).toBe("PREV");
  });
});

describe("interpret: data e hora por estado (CA-08, CA-09)", () => {
  it("SELECT_DAY com data", () => {
    expect(run("SELECT_DAY", "amanhã")).toEqual({ kind: "date", date: "2026-10-01", time: null });
    expect(run("SELECT_DAY", "02/10")).toEqual({ kind: "date", date: "2026-10-02", time: null });
    expect(run("SELECT_DAY", "2/10")).toEqual({ kind: "date", date: "2026-10-02", time: null });
    expect(run("SELECT_DAY", "sexta")).toEqual({ kind: "date", date: "2026-10-02", time: null });
    expect(run("SELECT_DAY", "quarta")).toEqual({ kind: "date", date: "2026-09-30", time: null });
    expect(run("SELECT_DAY", "quarta que vem")).toEqual({ kind: "date", date: "2026-10-07", time: null });
    expect(run("SELECT_DAY", "amanhã 15h")).toEqual({ kind: "date", date: "2026-10-01", time: "15:00" });
  });
  it.each(["15h", "15:00", "15h00", "3 da tarde"])("SELECT_TIME %j -> hora 15:00", (t) => {
    expect(run("SELECT_TIME", t)).toEqual({ kind: "time", time: "15:00" });
  });
  it("SELECT_TIME com período e com data", () => {
    expect(run("SELECT_TIME", "tarde")).toEqual({ kind: "period", period: "afternoon" });
    expect(run("SELECT_TIME", "sexta")).toEqual({ kind: "date", date: "2026-10-02", time: null });
  });
  it("hora em estado sem horário é inválida", () => {
    expect(run("SELECT_SERVICE", "15h")).toEqual({ kind: "invalid" });
  });
});

describe("interpret: ASK_NAME (CA-10)", () => {
  it("nome válido", () => {
    expect(run("ASK_NAME", "Maria Souza")).toEqual({ kind: "name", name: "Maria Souza" });
  });
  it.each(["1", "a", "sim", "cancelar", "😀😀", ".."])("%j -> NAME_INVALID", (t) => {
    expect(run("ASK_NAME", t)).toEqual({ kind: "name_invalid", reason: "INVALID" });
  });
  it("'oi' é saudação (comando vem antes do nome)", () => {
    expect(run("ASK_NAME", "oi")).toEqual({ kind: "command", command: "GREETING" });
  });
  it("61 caracteres", () => {
    expect(run("ASK_NAME", "a".repeat(61))).toEqual({ kind: "name_invalid", reason: "TOO_LONG" });
  });
  it("voltar navega e não vira nome", () => {
    expect(run("ASK_NAME", "voltar")).toEqual({ kind: "command", command: "BACK" });
  });
});

describe("interpret: opções da v1 (CA-44)", () => {
  it("CONFIRM v1: '1' e '2'", () => {
    const legacy = [
      { n: 1, id: "confirmar", label: "Confirmar" },
      { n: 2, id: "outro", label: "Outro horário" },
    ];
    expect(optionId(interpret({ state: "CONFIRM", text: "1", options: legacy, clock }))).toBe("CONFIRM");
    expect(optionId(interpret({ state: "CONFIRM", text: "2", options: legacy, clock }))).toBe("EDIT");
    expect(optionId(interpret({ state: "CONFIRM", text: "sim", options: legacy, clock }))).toBe("CONFIRM");
  });
});
