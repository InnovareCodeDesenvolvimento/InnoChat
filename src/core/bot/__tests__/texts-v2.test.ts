import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BOT_TEXT_KEYS } from "../texts";
import {
  BOT_TEXT_ALLOWED_VARS,
  BOT_TEXT_CATALOG,
  BOT_TEXT_KEYS_V2,
  BOT_TEXT_VARIABLES_V2,
  DEFAULT_BOT_TEXTS_V2,
  LEGACY_V1_KEYS,
  findDisallowedVariables,
} from "../texts-v2";
import type { BotTextKeyV2 } from "../texts-v2";

const V1_KEYS = BOT_TEXT_KEYS as readonly string[];
const KEYS = BOT_TEXT_KEYS_V2 as readonly string[];

describe("BOT_TEXT_KEYS_V2", () => {
  it("são as chaves v1 não legadas + as 50 novas (79 no total, sem repetição)", () => {
    const keptFromV1 = V1_KEYS.filter((k) => !(LEGACY_V1_KEYS as readonly string[]).includes(k));
    expect(keptFromV1).toHaveLength(29);
    for (const k of keptFromV1) expect(KEYS).toContain(k);
    const novas = KEYS.filter((k) => !V1_KEYS.includes(k));
    expect(novas).toHaveLength(50);
    expect(novas.filter((k) => k.startsWith("LABEL_"))).toHaveLength(20);
    expect(KEYS).toHaveLength(79);
    expect(new Set(KEYS).size).toBe(KEYS.length);
  });

  it("nenhuma chave legada entra na v2", () => {
    for (const k of LEGACY_V1_KEYS) expect(KEYS).not.toContain(k);
  });
});

describe("cobertura por chave", () => {
  it.each(KEYS)("%s tem padrão, catálogo e lista de variáveis", (key) => {
    const k = key as BotTextKeyV2;
    expect(typeof DEFAULT_BOT_TEXTS_V2[k]).toBe("string");
    expect(DEFAULT_BOT_TEXTS_V2[k].length).toBeGreaterThan(0);
    expect(BOT_TEXT_CATALOG[k].title.length).toBeGreaterThan(0);
    expect(BOT_TEXT_CATALOG[k].description.length).toBeGreaterThan(0);
    expect(Array.isArray(BOT_TEXT_ALLOWED_VARS[k])).toBe(true);
  });

  it("os mapas não têm chaves sobrando", () => {
    for (const map of [DEFAULT_BOT_TEXTS_V2, BOT_TEXT_CATALOG, BOT_TEXT_ALLOWED_VARS]) {
      expect(Object.keys(map).sort()).toEqual([...KEYS].sort());
    }
  });

  it("rótulos ficam no grupo rotulos e só eles", () => {
    for (const k of KEYS) {
      expect(BOT_TEXT_CATALOG[k as BotTextKeyV2].group === "rotulos").toBe(k.startsWith("LABEL_"));
    }
  });

  it("nenhuma variável do texto padrão fica fora de BOT_TEXT_ALLOWED_VARS", () => {
    for (const k of KEYS) {
      expect(findDisallowedVariables(k as BotTextKeyV2, DEFAULT_BOT_TEXTS_V2[k as BotTextKeyV2])).toEqual([]);
    }
  });

  it("toda variável permitida existe em BOT_TEXT_VARIABLES_V2 (8 da v1 + 7 novas)", () => {
    expect(BOT_TEXT_VARIABLES_V2).toHaveLength(15);
    for (const k of KEYS) {
      for (const v of BOT_TEXT_ALLOWED_VARS[k as BotTextKeyV2]) expect(BOT_TEXT_VARIABLES_V2).toContain(v);
    }
  });

  it("nenhum texto padrão contém número de opção (BUG-11): quem numera é o renderizador", () => {
    for (const k of KEYS) {
      expect(DEFAULT_BOT_TEXTS_V2[k as BotTextKeyV2]).not.toMatch(/(^|\n)\s*([0-9]️⃣|[1-9][.)])\s/);
    }
  });
});

describe("BOT_TEXT_ALLOWED_VARS", () => {
  it("rótulos não aceitam variável", () => {
    for (const k of KEYS.filter((x) => x.startsWith("LABEL_"))) expect(BOT_TEXT_ALLOWED_VARS[k as BotTextKeyV2]).toEqual([]);
  });

  it("nome e empresa valem em toda mensagem; extras conforme a tabela da spec §5.3", () => {
    expect(BOT_TEXT_ALLOWED_VARS.GREETING).toEqual(["nome", "empresa"]);
    expect(BOT_TEXT_ALLOWED_VARS.APPOINTMENT_LIMIT).toEqual(["nome", "empresa", "limite"]);
    expect(BOT_TEXT_ALLOWED_VARS.CHOOSE_TIME).toEqual(["nome", "empresa", "servico", "profissional", "data", "hora", "proximo"]);
    expect(BOT_TEXT_ALLOWED_VARS.HUMAN_HANDOFF).toEqual(["nome", "empresa", "retorno", "proximo"]);
    expect(BOT_TEXT_ALLOWED_VARS.CONFIRM_SUMMARY).toContain("data_longa");
    expect(BOT_TEXT_ALLOWED_VARS.CONFIRM_SUMMARY).toContain("duracao");
    expect(BOT_TEXT_ALLOWED_VARS.CONFIRM_RESCHEDULE).toContain("anterior");
    expect(BOT_TEXT_ALLOWED_VARS.REMINDER).toContain("quando");
  });
});

describe("findDisallowedVariables", () => {
  it("devolve as variáveis fora do contexto da chave, sem repetir, na ordem de aparição", () => {
    expect(findDisallowedVariables("GREETING", "Oi {nome} {preco} {preco} {xyz}")).toEqual(["preco", "xyz"]);
  });

  it("texto válido devolve vazio", () => {
    expect(findDisallowedVariables("BOOKED", "{servico} às {hora} até {prazo}")).toEqual([]);
    expect(findDisallowedVariables("MENU_PROMPT", "sem variáveis")).toEqual([]);
  });

  it("variável de outra chave é recusada (BUG-12)", () => {
    expect(findDisallowedVariables("CHOOSE_DAY", "{retorno}")).toEqual(["retorno"]);
    expect(findDisallowedVariables("LABEL_BACK", "Voltar {nome}")).toEqual(["nome"]);
  });
});

// Trava de fidelidade: o objeto da spec §5.3 é a fonte; o código não pode divergir dele.
describe("DEFAULT_BOT_TEXTS_V2 idêntico à spec §5.3 (snapshot)", () => {
  const spec = readFileSync(path.resolve(process.cwd(), "docs/bot-v2-especificacao.md"), "utf8");
  const marker = "export const DEFAULT_BOT_TEXTS_V2 = ";
  const start = spec.indexOf(marker);
  const end = spec.indexOf("\n};", start);
  const literal = spec.slice(start + marker.length, end + 2);
  const fromSpec = new Function(`return (${literal});`)() as Record<string, string>;

  it("o bloco da spec foi encontrado", () => {
    expect(start).toBeGreaterThan(-1);
    expect(Object.keys(fromSpec).length).toBeGreaterThan(40);
  });

  it("cada mensagem da spec é igual ao padrão do código, caractere a caractere", () => {
    for (const [key, text] of Object.entries(fromSpec)) {
      expect(DEFAULT_BOT_TEXTS_V2[key as BotTextKeyV2], key).toBe(text);
    }
  });

  it("só sobram no código as mensagens fora do bloco (REMINDER) e os rótulos", () => {
    const extras = KEYS.filter((k) => !(k in fromSpec)).filter((k) => !k.startsWith("LABEL_"));
    expect(extras).toEqual(["REMINDER"]);
  });

  it("rótulos conferem com a tabela da spec (existentes e novos)", () => {
    const expected: Record<string, string> = {
      LABEL_MENU_BOOK: "Agendar horário",
      LABEL_MENU_MY: "Meus agendamentos",
      LABEL_MENU_HUMAN: "Falar com atendente",
      LABEL_ANY_PROFESSIONAL: "Qualquer profissional",
      LABEL_NEXT_AVAILABLE: "Primeiro horário livre",
      LABEL_BY_DAY: "Escolher por dia",
      LABEL_CONFIRM: "Confirmar",
      LABEL_EDIT: "Corrigir dados",
      LABEL_EDIT_SERVICE: "Serviço",
      LABEL_EDIT_PROFESSIONAL: "Profissional",
      LABEL_EDIT_DATETIME: "Data e horário",
      LABEL_EDIT_NAME: "Nome",
      LABEL_RESCHEDULE: "Remarcar",
      LABEL_CANCEL_APPOINTMENT: "Cancelar agendamento",
      LABEL_CANCEL_YES: "Sim, cancelar",
      LABEL_CANCEL_NO: "Não, manter",
      LABEL_BOOK_ANOTHER: "Agendar outro",
      LABEL_FINISH: "Encerrar atendimento",
      LABEL_CONTINUE: "Continuar",
      LABEL_START_OVER: "Começar de novo",
      LABEL_BACK: "Voltar",
      LABEL_OTHER_SERVICE: "Outro serviço",
      LABEL_PREVIOUS: "Ver anteriores",
      LABEL_MORE_DAYS: "Ver mais datas",
      LABEL_MORE_TIMES: "Mais horários",
      LABEL_MORE: "Ver mais",
    };
    const labels = KEYS.filter((k) => k.startsWith("LABEL_"));
    expect([...labels].sort()).toEqual(Object.keys(expected).sort());
    for (const [k, v] of Object.entries(expected)) expect(DEFAULT_BOT_TEXTS_V2[k as BotTextKeyV2], k).toBe(v);
  });
});
