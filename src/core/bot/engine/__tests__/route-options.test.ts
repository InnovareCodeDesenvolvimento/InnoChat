import { describe, expect, it } from "vitest";
import {
  STATIC_OPTION_IDS,
  buildOptions,
  isResumable,
  keycap,
  mapLegacyOptions,
  pageSlice,
  popTrail,
  pushTrail,
  routeFor,
  validateName,
  type Intent,
} from "../index";

const base = { state: "SELECT_DAY", invalidCount: 0, fresh: false, resumable: false };
const invalid: Intent = { kind: "invalid" };

describe("routeFor: inválidos (CA-11)", () => {
  it("1ª inválida → INVALID_1; 2ª seguida → INVALID_2 e zera", () => {
    const a = routeFor({ ...base, intent: invalid });
    expect(a).toEqual({ route: "INVALID_1", invalidCount: 1, greet: false });
    const b = routeFor({ ...base, intent: invalid, invalidCount: a.invalidCount });
    expect(b).toEqual({ route: "INVALID_2", invalidCount: 0, greet: false });
  });
  it("comando e opção zeram", () => {
    expect(routeFor({ ...base, invalidCount: 1, intent: { kind: "command", command: "HELP" } }).invalidCount).toBe(0);
    expect(
      routeFor({ ...base, invalidCount: 1, intent: { kind: "date", date: "2026-10-01", time: null } }),
    ).toMatchObject({ route: "STATE", invalidCount: 0 });
  });
  it("mídia e ambígua não contam (CA-12)", () => {
    expect(routeFor({ ...base, invalidCount: 1, intent: { kind: "media" } })).toMatchObject({ route: "MEDIA", invalidCount: 1 });
    expect(routeFor({ ...base, invalidCount: 1, intent: { kind: "ambiguous", candidates: [] } })).toMatchObject({
      route: "AMBIGUOUS",
      invalidCount: 1,
    });
  });
  it("nome inválido conta, mas 2 seguidas viram INVALID_2", () => {
    const i: Intent = { kind: "name_invalid", reason: "INVALID" };
    expect(routeFor({ ...base, state: "ASK_NAME", intent: i })).toMatchObject({ route: "STATE", invalidCount: 1 });
    expect(routeFor({ ...base, state: "ASK_NAME", invalidCount: 1, intent: i })).toMatchObject({
      route: "INVALID_2",
      invalidCount: 0,
    });
  });
});

describe("routeFor: comandos e cortesia", () => {
  it.each([
    ["MENU", "CMD_MENU"],
    ["BACK", "CMD_BACK"],
    ["EXIT", "CMD_EXIT"],
    ["HUMAN", "CMD_HUMAN"],
    ["HELP", "CMD_HELP"],
  ] as const)("%s", (command, route) => {
    expect(routeFor({ ...base, intent: { kind: "command", command } }).route).toBe(route);
  });
  it("saudação: menu no MAIN_MENU, CONTINUE no meio do fluxo (CA-28)", () => {
    const intent: Intent = { kind: "command", command: "GREETING" };
    expect(routeFor({ ...base, state: "MAIN_MENU", intent })).toMatchObject({ route: "CMD_MENU", greet: true });
    expect(routeFor({ ...base, intent }).route).toBe("CMD_CONTINUE");
  });
  it("cortesia: encerra em POST_ACTION/MAIN_MENU, reenvia o prompt nos outros", () => {
    const intent: Intent = { kind: "command", command: "THANKS" };
    expect(routeFor({ ...base, state: "POST_ACTION", intent }).route).toBe("CMD_THANKS");
    expect(routeFor({ ...base, intent }).route).toBe("REPROMPT");
  });
});

describe("routeFor: fresh (BUG-13, CA-27)", () => {
  const fresh = { ...base, state: "MAIN_MENU", fresh: true };
  const opt = (id: string): Intent => ({ kind: "option", option: { n: 2, id, title: "x" }, via: "number" });
  it("'2' em sessão nova vai direto ao estado, sem contar inválido", () => {
    expect(routeFor({ ...fresh, intent: opt("MY") })).toEqual({ route: "STATE", invalidCount: 0, greet: false });
  });
  it("saudação/menu → FRESH, mesmo com retomada disponível", () => {
    const g: Intent = { kind: "command", command: "GREETING" };
    expect(routeFor({ ...fresh, resumable: true, intent: g })).toEqual({ route: "FRESH", invalidCount: 0, greet: true });
    expect(routeFor({ ...fresh, intent: { kind: "command", command: "MENU" } }).route).toBe("FRESH");
  });
  it("retomável e mensagem qualquer → RESUME", () => {
    expect(routeFor({ ...fresh, resumable: true, intent: invalid })).toEqual({ route: "RESUME", invalidCount: 0, greet: true });
  });
  it("nada casou → FRESH com saudação, sem contar inválido", () => {
    expect(routeFor({ ...fresh, invalidCount: 1, intent: invalid })).toEqual({ route: "FRESH", invalidCount: 0, greet: true });
  });
  it("pedido de atendente não é engolido pela retomada", () => {
    expect(routeFor({ ...fresh, resumable: true, intent: { kind: "command", command: "HUMAN" } }).route).toBe("CMD_HUMAN");
  });
});

describe("isResumable (spec §2.7)", () => {
  it("estado de agendamento com serviço", () => {
    expect(isResumable({ state: "SELECT_TIME", context: { serviceId: "svc_1" } })).toBe(true);
  });
  it.each([
    [null],
    [{ state: "MAIN_MENU", context: { serviceId: "s" } }],
    [{ state: "SELECT_TIME", context: {} }],
    [{ state: "SELECT_TIME", context: null }],
  ])("não retomável %j", (prev) => {
    expect(isResumable(prev as never)).toBe(false);
  });
});

describe("paginação (CA-18)", () => {
  const all = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, title: `Dia ${i}` }));
  const labels = { more: "Ver mais", prev: "Ver anteriores" };
  it("pageSlice sem volta cíclica e sem repetição", () => {
    const p0 = pageSlice(all, 0);
    const p1 = pageSlice(all, 1);
    const p2 = pageSlice(all, 2);
    expect([p0.items.length, p1.items.length, p2.items.length]).toEqual([8, 8, 4]);
    expect([p0.hasMore, p1.hasMore, p2.hasMore]).toEqual([true, true, false]);
    expect([p0.hasPrev, p1.hasPrev, p2.hasPrev]).toEqual([false, true, true]);
    expect(new Set([...p0.items, ...p1.items, ...p2.items]).size).toBe(20);
    expect(pageSlice(all, 3).items).toEqual([]);
  });
  it("buildOptions numera 1..n contínuo; 'Ver mais' só se houver, 'Ver anteriores' só da 2ª", () => {
    const first = buildOptions({
      leading: [{ id: "NEXT", title: "Primeiro horário livre" }],
      items: all.slice(0, 7),
      hasMore: true,
      hasPrev: false,
      labels,
    });
    expect(first.map((o) => o.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(first[8].id).toBe("MORE");
    const later = buildOptions({ items: all.slice(8, 15), hasMore: true, hasPrev: true, labels });
    expect(later.slice(-2).map((o) => o.id)).toEqual(["MORE", "PREV"]);
    const last = buildOptions({ items: all.slice(16), hasMore: false, hasPrev: true, labels });
    expect(last.map((o) => o.id)).toEqual(["d16", "d17", "d18", "d19", "PREV"]);
    expect(last.every((o, i) => o.n === i + 1 && o.label === o.title)).toBe(true);
  });
  it("lança acima de 9", () => {
    expect(() => buildOptions({ items: all.slice(0, 10), labels })).toThrow();
    expect(() => keycap(10)).toThrow();
    expect(() => keycap(0)).toThrow();
    expect(keycap(3)).toBe("3️⃣");
  });
});

describe("trilha (spec §2.5)", () => {
  it("empilha sem repetir o topo, máx. 12", () => {
    expect(pushTrail(undefined, "MAIN_MENU")).toEqual(["MAIN_MENU"]);
    expect(pushTrail(["MAIN_MENU"], "MAIN_MENU")).toEqual(["MAIN_MENU"]);
    let t: string[] = [];
    for (let i = 0; i < 20; i++) t = pushTrail(t, `S${i}`);
    expect(t).toHaveLength(12);
    expect(t[11]).toBe("S19");
  });
  it("voltar desempilha o atual e devolve o anterior", () => {
    expect(popTrail(["MAIN_MENU", "SELECT_SERVICE", "SELECT_DAY"])).toEqual({
      trail: ["MAIN_MENU", "SELECT_SERVICE"],
      target: "SELECT_SERVICE",
    });
    expect(popTrail(["MAIN_MENU"])).toEqual({ trail: [], target: "MAIN_MENU" });
    expect(popTrail(undefined)).toEqual({ trail: [], target: "MAIN_MENU" });
  });
  it("não muta a entrada", () => {
    const t = ["A", "B"];
    popTrail(t);
    pushTrail(t, "C");
    expect(t).toEqual(["A", "B"]);
  });
});

describe("mapLegacyOptions (CA-44)", () => {
  const mk = (pairs: [string, string][]) => pairs.map(([id, label], i) => ({ n: i + 1, id, label }));
  it("traduz ids estáticos e mantém o resto", () => {
    expect(mapLegacyOptions(mk([["agendar", "A"], ["meus", "M"], ["atendente", "H"]]), "MAIN_MENU").map((o) => o.id)).toEqual(["BOOK", "MY", "HUMAN"]);
    expect(mapLegacyOptions(mk([["confirmar", "C"], ["outro", "O"]]), "CONFIRM").map((o) => o.id)).toEqual(["CONFIRM", "EDIT"]);
    expect(mapLegacyOptions(mk([["sim", "S"], ["nao", "N"]]), "CONFIRM_CANCEL").map((o) => o.id)).toEqual(["YES", "NO"]);
    expect(mapLegacyOptions(mk([["remarcar", "R"], ["cancelar", "C"]]), "APPOINTMENT_ACTIONS").map((o) => o.id)).toEqual(["RESCHEDULE", "CANCEL"]);
    const dyn = mapLegacyOptions(mk([["svc_abc", "Corte"], ["__more_days", "Mais"]]), "SELECT_SERVICE");
    expect(dyn.map((o) => o.id)).toEqual(["svc_abc", "MORE"]);
    expect(dyn[0]).toMatchObject({ n: 1, title: "Corte", match: "Corte", label: "Corte" });
  });
});

describe("validateName (CA-10)", () => {
  it.each(["Maria Souza", "Ana", "João  da Silva", "Zé", "D'Ávila"])("aceita %j", (n) => {
    expect(validateName(n)).toMatchObject({ ok: true });
  });
  it("limpa espaços, < e >", () => {
    expect(validateName("  Maria   <Souza> ")).toEqual({ ok: true, name: "Maria Souza" });
  });
  it.each(["1", "a", "12345", "..", "😀😀", "sim", "Não", "cancelar", "menu", "a@b.com", "www.x.com", "https://x", "voltar", "atendente"])(
    "recusa %j",
    (n) => {
      expect(validateName(n)).toEqual({ ok: false, reason: "INVALID" });
    },
  );
  it("limites", () => {
    expect(validateName("a".repeat(60))).toMatchObject({ ok: true });
    expect(validateName("a".repeat(61))).toEqual({ ok: false, reason: "TOO_LONG" });
  });
  it("ids estáticos do contrato", () => {
    expect(STATIC_OPTION_IDS.MAIN_MENU).toEqual(["BOOK", "MY", "HUMAN"]);
  });
});
