import { describe, expect, it } from "vitest";
import { pageItems, parsePageSize, parsePositiveInt, rangeOf } from "./pagination";

describe("paginação", () => {
  it("poucas páginas aparecem todas", () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("usa reticências no meio", () => {
    expect(pageItems(5, 12)).toEqual([1, "…", 4, 5, 6, "…", 12]);
  });
  it("perto do começo e do fim", () => {
    expect(pageItems(1, 12)).toEqual([1, 2, 3, 4, "…", 12]);
    expect(pageItems(12, 12)).toEqual([1, "…", 9, 10, 11, 12]);
    expect(pageItems(3, 12)).toEqual([1, 2, 3, 4, "…", 12]);
  });
  it("não põe reticências para pular uma única página", () => {
    expect(pageItems(4, 9)).toEqual([1, 2, 3, 4, 5, "…", 9]);
  });
  it("intervalo mostrado", () => {
    expect(rangeOf(2, 25, 137)).toEqual({ from: 26, to: 50 });
    expect(rangeOf(6, 25, 137)).toEqual({ from: 126, to: 137 });
    expect(rangeOf(1, 25, 0)).toEqual({ from: 0, to: 0 });
  });
  it("lê a URL com segurança", () => {
    expect(parsePositiveInt("3", 1)).toBe(3);
    expect(parsePositiveInt("0", 1)).toBe(1);
    expect(parsePositiveInt("-2", 1)).toBe(1);
    expect(parsePositiveInt("abc", 1)).toBe(1);
    expect(parsePageSize("50")).toBe(50);
    expect(parsePageSize("37")).toBe(25);
    expect(parsePageSize(undefined)).toBe(25);
  });
});
