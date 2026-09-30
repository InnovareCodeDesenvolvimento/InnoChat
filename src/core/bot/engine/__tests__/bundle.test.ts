import { join } from "node:path";
import vm from "node:vm";
import { build } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import * as engine from "../index";

/**
 * Prova de que o motor roda no Code node do n8n (spec §7.2): compila `index.ts` do jeito que o
 * `scripts/n8n-build-flow.mjs` vai compilar (IIFE `InnoEngine`, ES2020, sem minificar) e executa
 * o resultado num contexto SEM `require`, `process`, `module`, `Buffer` ou qualquer API do Node.
 */

const ENTRY = join(__dirname, "..", "index.ts");
const clock = { today: "2026-09-30", nowLocal: "10:00" };
const TEXTS = {
  GREETING: "Olá, {nome}! 👋\nBoas-vindas à *{empresa}*.",
  MENU_PROMPT: "Como posso ajudar você hoje?",
  MENU_HINT: "_Responda com o número ou o nome da opção._",
};

let bundle = "";

beforeAll(async () => {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    globalName: "InnoEngine",
    target: "es2020",
    platform: "neutral",
    minify: false,
    write: false,
    logLevel: "silent",
  });
  bundle = result.outputFiles[0].text;
});

/** Tudo que o teste chama; roda igual dentro e fora do sandbox. */
function scenario(e: typeof engine, clock: engine.EngineClock, TEXTS: engine.Texts) {
  const options = e.buildOptions({
    items: [{ id: "BOOK", title: "Agendar horário" }, { id: "MY", title: "Meus agendamentos" }],
    labels: { more: "Ver mais", prev: "Ver anteriores" },
  });
  return {
    norm: e.normalizeText("  MENÚ 0️⃣  "),
    amanha: e.parseInput("amanhã", clock),
    sextaTarde: e.parseInput("sexta à tarde", clock),
    horas: ["15h", "15:30", "3 da tarde"].map((t) => e.parseInput(t, clock).time),
    numeros: ["2", "2️⃣", "2.", "opção 2"].map((t) => e.parseInput(t, clock).number),
    sim: ["sim", "ok", "👍"].map((t) => e.interpret({ state: "CONFIRM", text: t, options: [{ n: 1, id: "confirmar", label: "Confirmar" }, { n: 2, id: "outro", label: "Outro" }], clock })),
    dia: e.interpret({ state: "SELECT_DAY", text: "sexta", options: [], clock }),
    rota: e.routeFor({ intent: { kind: "invalid" }, state: "SELECT_DAY", invalidCount: 1, fresh: false, resumable: false }),
    nome: e.validateName("Maria Souza"),
    trilha: e.popTrail(e.pushTrail(e.pushTrail([], "MAIN_MENU"), "SELECT_SERVICE")),
    msg: e.renderMessage([{ key: "GREETING", vars: { nome: "", empresa: "Studio" } }, { key: "MENU_PROMPT", options, footer: "MENU_HINT" }], TEXTS),
    keycap: e.keycap(9),
  };
}

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe("bundle IIFE do motor (prova do Code node)", () => {
  it("não contém require, import, process nem módulos externos", () => {
    expect(bundle).not.toMatch(/\brequire\s*\(/);
    expect(bundle).not.toMatch(/^\s*(import|export)\s/m);
    expect(bundle).not.toMatch(/\bprocess\b/);
    expect(bundle).not.toMatch(/\bBuffer\b/);
    expect(bundle).toMatch(/^var InnoEngine = \(\(\) => \{/m);
  });

  it("roda num contexto vm vazio (sem require/process/module) e dá o mesmo resultado do TypeScript", () => {
    const sandbox = vm.createContext(Object.create(null));
    const probe = vm.runInContext(
      `${bundle}\n;({ req: typeof require, proc: typeof process, mod: typeof module, buf: typeof Buffer, keys: Object.keys(InnoEngine).sort() })`,
      sandbox,
    );
    expect(plain(probe)).toEqual({
      req: "undefined",
      proc: "undefined",
      mod: "undefined",
      buf: "undefined",
      keys: Object.keys(engine).filter((k) => typeof (engine as Record<string, unknown>)[k] !== "undefined").sort(),
    });

    vm.runInContext(`${bundle}\nglobalThis.__engine = InnoEngine;`, sandbox);
    (sandbox as Record<string, unknown>).__clock = clock;
    (sandbox as Record<string, unknown>).__texts = TEXTS;
    const inside = vm.runInContext(`(${scenario.toString()})(__engine, __clock, __texts)`, sandbox);
    expect(plain(inside)).toEqual(plain(scenario(engine, clock, TEXTS)));
  });

  it("roda em new Function com require/process/module escondidos (formato do Code node)", () => {
    const fn = new Function(
      "require",
      "process",
      "module",
      "exports",
      "Buffer",
      `${bundle}\nreturn InnoEngine;`,
    );
    const e = fn(undefined, undefined, undefined, undefined, undefined) as typeof engine;
    const parsed = e.parseInput("amanhã 15h", clock);
    expect(parsed.date).toBe("2026-10-01");
    expect(parsed.time).toBe("15:00");
    expect(plain(scenario(e, clock, TEXTS))).toEqual(plain(scenario(engine, clock, TEXTS)));
  });
});
