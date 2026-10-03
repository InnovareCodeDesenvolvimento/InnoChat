import flowVersionsFile from "../../../n8n/flow-versions.json";

/**
 * Histórico de versões do fluxo do bot (`n8n/flow-versions.json`): fonte ÚNICA do número da versão.
 * O `npm run build:flow` grava a versão mais recente em `Config.flowVersion`; o Admin lê daqui o
 * "o que mudou". Sem dependência de banco nem de Next: roda também no script de build.
 *
 * Regra: toda mudança no fluxo sobe a versão (MINOR funcionalidade, PATCH correção, MAJOR muda
 * contrato ou catálogo de textos; o MAJOR decide o catálogo v1/v2 em `bot-texts/service.ts`).
 */

export type FlowVersionEntry = {
  version: string;
  /** AAAA-MM-DD */
  date: string;
  /** Hash do CONTEÚDO (sem `Config.flowVersion`) deste fluxo; `null` se não deu para reconstruir. */
  hash: string | null;
  /** Frases curtas, escritas para o dono (sem jargão). */
  changes: string[];
  /** Observação técnica, ex.: de onde veio o hash. */
  note?: string;
};

/** O que o Admin mostra por versão (sem hash nem observação técnica). */
export type FlowChangeNote = Pick<FlowVersionEntry, "version" | "date" | "changes">;

/** Mais novo primeiro. */
export const FLOW_VERSIONS: FlowVersionEntry[] = (flowVersionsFile as { versions: FlowVersionEntry[] }).versions;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** `"2.1.0 (editado no n8n)"` vira `[2, 1, 0]`; ilegível vira `null`. */
export function parseSemver(version: string | null | undefined): [number, number, number] | null {
  const m = /^\s*(\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negativo se a < b, 0 se igual, positivo se a > b. Ilegível conta como menor que tudo. */
export function compareSemver(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

export function latestFlowVersion(entries: FlowVersionEntry[] = FLOW_VERSIONS): FlowVersionEntry {
  const first = entries[0];
  if (!first) throw new Error("n8n/flow-versions.json está vazio");
  return first;
}

/**
 * Versões que o dono ainda não tem: maiores que a publicada e até a do sistema, da mais nova para
 * a mais antiga. Sem versão publicada (nunca publicou) ou ilegível: lista vazia.
 */
export function changesBetween(published: string | null | undefined, available: string, entries: FlowVersionEntry[] = FLOW_VERSIONS): FlowChangeNote[] {
  if (!parseSemver(published)) return [];
  return entries
    .filter((e) => compareSemver(e.version, published) > 0 && compareSemver(e.version, available) <= 0)
    .map(({ version, date, changes }) => ({ version, date, changes: [...changes] }));
}

/** Problemas de forma do arquivo (vazio = ok). */
export function validateFlowVersions(entries: FlowVersionEntry[]): string[] {
  const problems: string[] = [];
  if (entries.length === 0) return ["a lista de versões está vazia"];
  entries.forEach((e, i) => {
    if (!SEMVER.test(e.version)) problems.push(`versão "${e.version}" não é semver (ex.: 2.1.0)`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) problems.push(`${e.version}: data "${e.date}" precisa ser AAAA-MM-DD`);
    if (!Array.isArray(e.changes) || e.changes.length === 0 || e.changes.some((c) => typeof c !== "string" || !c.trim())) {
      problems.push(`${e.version}: preencha "changes" com ao menos uma frase`);
    }
    if (e.hash !== null && !/^[0-9a-f]{64}$/.test(e.hash)) problems.push(`${e.version}: hash inválido`);
    const next = entries[i + 1];
    if (next && compareSemver(e.version, next.version) <= 0) problems.push(`${e.version} deveria ser maior que ${next.version} (mais novo primeiro)`);
  });
  const major = parseSemver(entries[0]?.version)?.[0];
  if (major !== undefined && major < 2) problems.push("o major do fluxo v2 não pode ser menor que 2 (decide o catálogo de textos)");
  return problems;
}

/**
 * A trava. `contentHash` é o hash do conteúdo atual do fluxo (`canonicalContentHash`) e
 * `configVersion` o `Config.flowVersion` que está no JSON. Devolve a mensagem do problema, ou `null`.
 */
export function checkFlowVersioning(contentHash: string, configVersion: string, entries: FlowVersionEntry[] = FLOW_VERSIONS): string | null {
  const shape = validateFlowVersions(entries);
  if (shape.length > 0) return `n8n/flow-versions.json inválido: ${shape.join("; ")}`;
  const latest = latestFlowVersion(entries);
  if (latest.hash !== contentHash) {
    return (
      `o fluxo mudou: suba a versão em n8n/flow-versions.json. ` +
      `Acrescente uma entrada acima de ${latest.version} (MINOR para funcionalidade, PATCH para correção) com "changes" em frases curtas ` +
      `e hash ${contentHash}; depois rode npm run build:flow.`
    );
  }
  if (configVersion !== latest.version) {
    return `Config.flowVersion está em ${configVersion} mas a versão mais recente é ${latest.version}: rode npm run build:flow.`;
  }
  return null;
}
