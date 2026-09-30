import { describe, expect, it } from "vitest";
import type { N8nNode } from "../n8n-client";
import { canonicalFlowHash, readFlowVersion, sanitizeFlowForDownload, stableStringify } from "../n8n-flow-hash";

function config(values: { painelUrl: string; evolutionUrl: string; n8nApiUrl: string; flowVersion?: string }): N8nNode {
  const assignments = [
    { name: "painelUrl", value: values.painelUrl },
    { name: "evolutionUrl", value: values.evolutionUrl },
    { name: "n8nApiUrl", value: values.n8nApiUrl },
    ...(values.flowVersion ? [{ name: "flowVersion", value: values.flowVersion }] : []),
  ];
  return { name: "Config", type: "n8n-nodes-base.set", typeVersion: 3.4, parameters: { assignments: { assignments } } };
}

const baseNodes = (): N8nNode[] => [
  config({ painelUrl: "https://a/x", evolutionUrl: "https://e", n8nApiUrl: "https://n/api/v1" }),
  { name: "Claim", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, parameters: { url: "={{ painelUrl }}/claim", method: "POST" } },
];

describe("canonicalFlowHash", () => {
  it("ignora id, position, credentials, webhookId, notes e a ordem dos nós/chaves", () => {
    const a = baseNodes();
    const b = baseNodes().reverse().map((n, i) => ({
      ...n,
      id: `id-${i}`,
      position: [i, i] as [number, number],
      credentials: { httpHeaderAuth: { id: "c1", name: "x" } },
      webhookId: "w",
      notes: "nota",
      parameters: Object.fromEntries(Object.entries(n.parameters ?? {}).reverse()),
    }));
    expect(canonicalFlowHash(a, {})).toBe(canonicalFlowHash(b, {}));
  });

  it("zera as 3 URLs do Config (painelUrl, evolutionUrl, n8nApiUrl) mas nota qualquer outra mudança", () => {
    const a = baseNodes();
    const b = baseNodes();
    b[0] = config({ painelUrl: "https://outro", evolutionUrl: "https://outra", n8nApiUrl: "https://outro/api/v1" });
    expect(canonicalFlowHash(a, {})).toBe(canonicalFlowHash(b, {}));

    const c = baseNodes();
    (c[1]!.parameters as Record<string, unknown>).method = "GET";
    expect(canonicalFlowHash(a, {})).not.toBe(canonicalFlowHash(c, {}));
    expect(canonicalFlowHash(a, {})).not.toBe(canonicalFlowHash(a, { Claim: { main: [[]] } }));
  });

  it("não muta a entrada", () => {
    const a = baseNodes();
    const before = JSON.stringify(a);
    canonicalFlowHash(a, {});
    expect(JSON.stringify(a)).toBe(before);
  });
});

describe("stableStringify / readFlowVersion", () => {
  it("ordena chaves em todos os níveis", () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: [{ z: 1, y: 2 }] } })).toBe('{"a":{"c":[{"y":2,"z":1}],"d":1},"b":1}');
  });

  it("lê Config.flowVersion e cai para 1.0.0 quando não há", () => {
    expect(readFlowVersion(baseNodes())).toBe("1.0.0");
    expect(readFlowVersion([config({ painelUrl: "", evolutionUrl: "", n8nApiUrl: "", flowVersion: "2.1.0" })])).toBe("2.1.0");
    expect(readFlowVersion([config({ painelUrl: "", evolutionUrl: "", n8nApiUrl: "", flowVersion: "abc" })])).toBe("1.0.0");
  });
});

describe("sanitizeFlowForDownload", () => {
  it("remove credentials e pinData dos nós e não devolve staticData", () => {
    const nodes: N8nNode[] = [
      { name: "Claim", type: "n8n-nodes-base.httpRequest", credentials: { httpHeaderAuth: { id: "c9", name: "Bearer" } }, pinData: [{ json: { telefone: "5511" } }] },
    ];
    const out = sanitizeFlowForDownload({ name: "innochat-bot", nodes, connections: {}, settings: { errorWorkflow: "e1" }, ...({ staticData: { x: 1 } } as object) });
    const text = JSON.stringify(out);
    expect(text).not.toContain("credentials");
    expect(text).not.toContain("pinData");
    expect(text).not.toContain("c9");
    expect(text).not.toContain("staticData");
    expect(nodes[0]!.credentials).toBeDefined(); // original intacto
  });
});
