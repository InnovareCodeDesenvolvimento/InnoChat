import { describe, expect, it } from "vitest";
import { interpret, routeFor, type Intent, type OptionV2 } from "../index";

/** Lista de espera no motor do bot v2 (melhoria 7): convite, oferta de horário e "Minha lista de espera". */
const clock = { today: "2026-10-05", nowLocal: "10:00" };
const opts = (list: [string, string][]): OptionV2[] => list.map(([id, title], i) => ({ n: i + 1, id, title, label: title }));
const run = (state: string, text: string | null, options: OptionV2[]): Intent => interpret({ state, text, options, clock });
const optionId = (i: Intent) => (i.kind === "option" ? i.option.id : `(${i.kind})`);

const INVITE = opts([["JOIN", "Entrar na lista de espera"], ["SKIP", "Ver outros dias"]]);
const OFFER = opts([["ACCEPT", "Sim, quero esse horário"], ["DECLINE", "Não, obrigado"]]);
const MENU_WITH_LIST = opts([["BOOK", "Agendar horário"], ["MY", "Meus agendamentos"], ["HUMAN", "Falar com atendente"], ["WAITLIST", "Minha lista de espera"]]);

describe("oferta de horário (WAITLIST_OFFER)", () => {
  it.each(["sim", "Sim!", "s", "quero", "aceito", "pode ser", "ok", "isso", "👍", "✅", "1", "1️⃣"])("%j aceita", (t) => {
    expect(optionId(run("WAITLIST_OFFER", t, OFFER))).toBe("ACCEPT");
  });
  it.each(["não", "nao", "Não quero", "n", "recuso", "❌", "👎", "2", "2️⃣"])("%j recusa", (t) => {
    expect(optionId(run("WAITLIST_OFFER", t, OFFER))).toBe("DECLINE");
  });
  it("'ok' aceita (alias do estado vem antes da cortesia) e não é agradecimento", () => {
    expect(run("WAITLIST_OFFER", "ok", OFFER)).toMatchObject({ kind: "option", via: "alias" });
  });
  it("texto solto não casa com nada: inválido", () => {
    expect(run("WAITLIST_OFFER", "talvez amanhã", OFFER).kind).toBe("invalid");
  });
  it("menu e atendente continuam valendo no meio da oferta", () => {
    expect(run("WAITLIST_OFFER", "menu", OFFER)).toEqual({ kind: "command", command: "MENU" });
    expect(run("WAITLIST_OFFER", "atendente", OFFER)).toEqual({ kind: "command", command: "HUMAN" });
  });
});

describe("convite para a lista (WAITLIST_INVITE)", () => {
  it.each(["sim", "entrar", "entrar na lista", "lista de espera", "quero", "👍", "1"])("%j entra na lista", (t) => {
    expect(optionId(run("WAITLIST_INVITE", t, INVITE))).toBe("JOIN");
  });
  it.each(["não", "nao", "n", "outros dias", "ver outros dias", "outro dia", "2"])("%j segue procurando", (t) => {
    expect(optionId(run("WAITLIST_INVITE", t, INVITE))).toBe("SKIP");
  });
});

describe("menu com 'Minha lista de espera'", () => {
  it.each(["lista de espera", "minha lista de espera", "minha lista", "sair da lista", "4"])("%j abre a lista", (t) => {
    expect(optionId(run("MAIN_MENU", t, MENU_WITH_LIST))).toBe("WAITLIST");
  });
  it("sem a opção no menu, 'lista de espera' não vira ação", () => {
    expect(optionId(run("MAIN_MENU", "lista de espera", MENU_WITH_LIST.slice(0, 3)))).not.toBe("WAITLIST");
  });
  it("os números 1 a 3 do menu não mudam", () => {
    expect(optionId(run("MAIN_MENU", "1", MENU_WITH_LIST))).toBe("BOOK");
    expect(optionId(run("MAIN_MENU", "2", MENU_WITH_LIST))).toBe("MY");
    expect(optionId(run("MAIN_MENU", "3", MENU_WITH_LIST))).toBe("HUMAN");
  });
});

describe("minha lista (WAITLIST_VIEW): escolhe por número", () => {
  const VIEW = opts([["wl_a", "Seg 05/10 · Corte"], ["wl_b", "Ter 06/10 · Barba"]]);
  it("o número escolhe a entrada", () => {
    const i = run("WAITLIST_VIEW", "2", VIEW);
    expect(i).toMatchObject({ kind: "option", option: { id: "wl_b" } });
  });
});

describe("rotas dos estados novos", () => {
  it("resposta válida na oferta segue para o ramo do estado; inválida repete e na 2ª volta ao menu", () => {
    const ok = routeFor({ intent: run("WAITLIST_OFFER", "sim", OFFER), state: "WAITLIST_OFFER", invalidCount: 0, fresh: false, resumable: false });
    expect(ok.route).toBe("STATE");
    const bad1 = routeFor({ intent: { kind: "invalid" }, state: "WAITLIST_OFFER", invalidCount: 0, fresh: false, resumable: false });
    expect(bad1).toMatchObject({ route: "INVALID_1", invalidCount: 1 });
    const bad2 = routeFor({ intent: { kind: "invalid" }, state: "WAITLIST_OFFER", invalidCount: 1, fresh: false, resumable: false });
    expect(bad2.route).toBe("INVALID_2");
  });
});
