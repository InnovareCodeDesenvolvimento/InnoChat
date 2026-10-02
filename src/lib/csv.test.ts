import { describe, expect, it } from "vitest";
import { csvCell, csvLine } from "./csv";

describe("csvCell: injeção de fórmula", () => {
  it("neutraliza célula que começa com tab, espaço antes do operador ou CR", () => {
    // Tab no início: a planilha ignora o tab e avalia a fórmula.
    expect(csvCell("\t=1+1")).toBe("'\t=1+1");
    // Espaço antes do operador.
    expect(csvCell(" =1")).toBe("' =1");
    // CR no início: o valor também tem quebra de linha, então vai entre aspas (com o apóstrofo dentro).
    expect(csvCell("\r=1")).toBe("\"'\r=1\"");
  });

  it("neutraliza = + - @ e deixa texto comum intacto", () => {
    for (const raw of ["=A1", "+1", "-1", "@SUM(A1)"]) expect(csvCell(raw)).toBe(`'${raw}`);
    expect(csvCell("Salão da Ana")).toBe("Salão da Ana");
    expect(csvCell(null)).toBe("");
    expect(csvCell(49.9)).toBe("49.9");
  });

  it("escapa aspas e separador", () => {
    expect(csvCell('a;"b"')).toBe('"a;""b"""');
    expect(csvLine(["x", "=1", null])).toBe("x;'=1;");
  });
});
