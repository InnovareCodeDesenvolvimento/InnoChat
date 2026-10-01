import { describe, expect, it } from "vitest";
import { cap, DEFAULT_NICHE_ID, firstName, NICHES, nicheById } from "./day-story-data";

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("day-story-data", () => {
  it("todo nicho tem todos os campos preenchidos e ids únicos", () => {
    expect(new Set(NICHES.map((n) => n.id)).size).toBe(NICHES.length);
    for (const n of NICHES) {
      const all = strings(n);
      expect(all.length, n.id).toBeGreaterThan(20);
      for (const s of all) expect(s.trim(), `${n.id} tem campo vazio`).not.toBe("");
      expect(n.messages).toHaveLength(3);
      expect(n.agenda).toHaveLength(3);
    }
  });

  it("começa num nicho neutro, sem 'salão' nem 'cadeira' em lugar nenhum", () => {
    const neutral = nicheById(DEFAULT_NICHE_ID);
    expect(neutral.id).toBe("geral");
    expect(strings(neutral).join(" ").toLowerCase()).not.toMatch(/sal[ãa]o|cadeira|maca/);
  });

  it("id desconhecido cai no nicho neutro; helpers", () => {
    expect(nicheById("nao-existe").id).toBe("geral");
    expect(firstName("Camila (Thor)")).toBe("Camila");
    expect(firstName("Camila")).toBe("Camila");
    expect(cap("a cliente")).toBe("A cliente");
  });
});
