import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changesBetween,
  checkFlowVersioning,
  compareSemver,
  FLOW_VERSIONS,
  latestFlowVersion,
  parseSemver,
  validateFlowVersions,
  type FlowVersionEntry,
} from "../flow-versions";
import type { N8nNode } from "../n8n-client";
import { canonicalContentHash, canonicalFlowHash, readFlowVersion } from "../n8n-flow-hash";

const root = join(__dirname, "..", "..", "..", "..");
const flow = JSON.parse(readFileSync(join(root, "n8n", "innochat-bot.json"), "utf8")) as { nodes: N8nNode[]; connections: Record<string, unknown> };

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const entries: FlowVersionEntry[] = [
  { version: "2.2.0", date: "2026-11-01", hash: H2, changes: ["c"] },
  { version: "2.1.0", date: "2026-10-02", hash: H1, changes: ["b"] },
  { version: "2.0.0", date: "2026-09-30", hash: null, changes: ["a"] },
];

describe("trava de versão do fluxo (n8n/innochat-bot.json)", () => {
  it("o conteúdo do fluxo bate com a versão mais recente do histórico; se falhar, suba a versão em n8n/flow-versions.json", () => {
    const problem = checkFlowVersioning(canonicalContentHash(flow.nodes, flow.connections), readFlowVersion(flow.nodes));
    expect(problem).toBeNull();
  });

  it("o hash do conteúdo ignora só o flowVersion; o hash completo não", () => {
    const other = structuredClone(flow.nodes);
    const config = other.find((n) => n.name === "Config")!;
    const a = (config.parameters as { assignments: { assignments: Array<{ name: string; value: string }> } }).assignments.assignments.find((x) => x.name === "flowVersion")!;
    a.value = "9.9.9";
    expect(canonicalContentHash(other, flow.connections)).toBe(canonicalContentHash(flow.nodes, flow.connections));
    expect(canonicalFlowHash(other, flow.connections)).not.toBe(canonicalFlowHash(flow.nodes, flow.connections));
  });

  it("mudou o conteúdo sem subir a versão: falha com mensagem clara", () => {
    const nodes = structuredClone(flow.nodes);
    (nodes.find((n) => n.name === "Claim")!.parameters as Record<string, unknown>).mudancaSemVersao = 1;
    const problem = checkFlowVersioning(canonicalContentHash(nodes, flow.connections), readFlowVersion(nodes));
    expect(problem).toMatch(/o fluxo mudou: suba a versão em n8n\/flow-versions\.json/);
  });

  it("Config.flowVersion diferente da mais recente também falha", () => {
    const problem = checkFlowVersioning(latestFlowVersion().hash!, "2.0.0");
    expect(problem).toMatch(/npm run build:flow/);
  });

  it("o major continua 2 (decide o catálogo de textos v2)", () => {
    expect(parseSemver(latestFlowVersion().version)![0]).toBe(2);
  });
});

describe("histórico (flow-versions.json)", () => {
  it("é válido: semver, datas, frases e ordem decrescente", () => {
    expect(validateFlowVersions(FLOW_VERSIONS)).toEqual([]);
  });

  it("2.0.0 e 2.1.0 estão registrados, com o que mudou escrito sem travessão", () => {
    const versions = FLOW_VERSIONS.map((v) => v.version);
    expect(versions).toContain("2.0.0");
    expect(versions).toContain("2.1.0");
    for (const v of FLOW_VERSIONS) for (const line of v.changes) expect(line).not.toContain("—");
  });

  it("recusa ordem errada, versão repetida, data ruim e lista sem frases", () => {
    expect(validateFlowVersions([entries[1]!, entries[0]!]).join(" ")).toMatch(/deveria ser maior/);
    expect(validateFlowVersions([entries[1]!, entries[1]!]).join(" ")).toMatch(/deveria ser maior/);
    expect(validateFlowVersions([{ ...entries[0]!, date: "01/11/2026" }]).join(" ")).toMatch(/AAAA-MM-DD/);
    expect(validateFlowVersions([{ ...entries[0]!, changes: [] }]).join(" ")).toMatch(/changes/);
    expect(validateFlowVersions([{ ...entries[0]!, version: "1.0.0" }]).join(" ")).toMatch(/major/);
    expect(validateFlowVersions([])).toHaveLength(1);
  });
});

describe("semver e o que mudou", () => {
  it("compara por número, não por texto", () => {
    expect(compareSemver("2.10.0", "2.9.0")).toBeGreaterThan(0);
    expect(compareSemver("2.1.0", "2.1.0 (editado no n8n)")).toBe(0);
    expect(compareSemver(null, "1.0.0")).toBeLessThan(0);
  });

  it("lista só as versões entre a publicada (exclusive) e a disponível (inclusive)", () => {
    expect(changesBetween("2.0.0", "2.2.0", entries).map((c) => c.version)).toEqual(["2.2.0", "2.1.0"]);
    expect(changesBetween("2.1.0", "2.2.0", entries).map((c) => c.version)).toEqual(["2.2.0"]);
    expect(changesBetween("2.2.0", "2.2.0", entries)).toEqual([]);
    expect(changesBetween("2.0.0", "2.1.0", entries).map((c) => c.version)).toEqual(["2.1.0"]);
  });

  it("sem versão publicada legível não inventa lista, e não vaza hash nem observação", () => {
    expect(changesBetween(null, "2.2.0", entries)).toEqual([]);
    expect(changesBetween("lixo", "2.2.0", entries)).toEqual([]);
    expect(Object.keys(changesBetween("2.0.0", "2.2.0", entries)[0]!).sort()).toEqual(["changes", "date", "version"]);
  });
});
