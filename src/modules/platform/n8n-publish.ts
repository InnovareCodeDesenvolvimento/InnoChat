import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getPublicBaseUrl } from "@/lib/public-url";
import botFlowFile from "../../../n8n/innochat-bot.json";
import { createN8nClient, N8nApiError, type N8nClient, type N8nNode, type N8nWorkflow } from "./n8n-client";
import { canonicalFlowHash, readFlowVersion, redactFlowSecrets, sanitizeFlowForDownload } from "./n8n-flow-hash";
import { mergeFlow, type CredentialIds, type MergedFlow } from "./n8n-flow-merge";
import { loadPlatformSettingsRow, readGenericSecret } from "./secrets";

/**
 * "Publicar fluxo" (docs/bot-v2-plano.md §3.5/§3.6): grava no n8n o `innochat-bot.json` que vai
 * empacotado no build, sem perder o que é da instalação (webhookId, credenciais, Config,
 * errorWorkflow), detecta edição manual no n8n e volta 1 versão.
 *
 * O JSON é importado no código (e não lido de disco) porque o Dockerfile não copia `n8n/`.
 *
 * Camadas: este arquivo tem o orquestrador puro (`createFlowPublisher`, recebe cliente n8n e
 * armazenamento por injeção — testável com n8n em memória) e, no fim, a ligação com Prisma/n8n
 * real usada pelas Server Actions.
 */

export type FlowSnapshot = { version: string; hash: string; nodes: N8nNode[]; connections: Record<string, unknown> };

export type BotFlowStatus = {
  buildVersion: string;
  buildHash: string;
  publishedVersion: string | null;
  publishedHash: string | null;
  publishedAt: string | null;
  /** `null` se o n8n não respondeu. */
  liveHash: string | null;
  drift: boolean;
  firstPublish: boolean;
  updateAvailable: boolean;
  canRollback: boolean;
  previousVersion: string | null;
  n8nReachable: boolean;
  error: string | null;
};

export type PublishResult = { version: string; hash: string; publishedAt: string; rolledBack: boolean };

export type PublishConfirm = "PUBLICAR" | "SOBRESCREVER";

type PublishedState = { version: string | null; hash: string | null; publishedAt: Date | null; previous: FlowSnapshot | null };

export interface PublishStore {
  load(): Promise<PublishedState>;
  /** Grava (ou limpa, com `null`) só o snapshot — usado antes do PUT e para desfazer. */
  setPrevious(snapshot: FlowSnapshot | null): Promise<void>;
  savePublished(input: { version: string; hash: string; publishedAt: Date; userId: string; previous: FlowSnapshot | null }): Promise<void>;
}

export type PublishContext = {
  client: N8nClient;
  botWorkflowId: string | null;
  errosWorkflowId: string | null;
  credentialIds: CredentialIds | null;
  painelUrl: string;
  evolutionUrl: string;
  n8nApiUrl: string;
};

export type BuildFlow = { version: string; hash: string; nodes: N8nNode[]; connections: Record<string, unknown> };

export function loadBundledBuildFlow(): BuildFlow {
  const file = botFlowFile as unknown as { nodes: N8nNode[]; connections: Record<string, unknown> };
  return {
    version: readFlowVersion(file.nodes),
    hash: canonicalFlowHash(file.nodes, file.connections),
    nodes: file.nodes,
    connections: file.connections,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Erro do n8n vira DomainError (Result de falha, não tela de erro). A mensagem do cliente não inclui a chave. */
async function callN8n<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof N8nApiError) throw new DomainError("N8N_API_ERROR", error.message, { status: error.status });
    if (error instanceof DomainError) throw error;
    throw new DomainError("N8N_UNREACHABLE", `Não consegui falar com o n8n: ${errorText(error)}`);
  }
}

function webhookFingerprint(nodes: N8nNode[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of nodes) {
    if (node.type === "n8n-nodes-base.webhook") {
      out[`${node.name}#path`] = String((node.parameters as { path?: unknown } | undefined)?.path ?? "");
    }
    if (typeof node.webhookId === "string") out[`${node.name}#webhookId`] = node.webhookId;
  }
  return out;
}

// Um publicar/voltar por vez neste processo (o painel roda como um único container). Evita dois
// admins intercalando GET→PUT e gravando snapshots que se sobrescrevem.
let publishLock: Promise<unknown> = Promise.resolve();
function withPublishLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = publishLock.then(fn, fn);
  publishLock = run.catch(() => undefined);
  return run;
}

export function createFlowPublisher(deps: { store: PublishStore; context: PublishContext; build: BuildFlow; now?: () => Date }) {
  const { store, context, build } = deps;
  const now = deps.now ?? (() => new Date());

  async function fetchLive(): Promise<N8nWorkflow> {
    if (!context.botWorkflowId) {
      throw new DomainError("N8N_NOT_SYNCED", "Sincronize o n8n antes de publicar o fluxo.");
    }
    const live = await callN8n(() => context.client.getWorkflow(context.botWorkflowId!));
    if (!live) throw new DomainError("N8N_WORKFLOW_NOT_FOUND", 'Workflow "innochat-bot" não encontrado no n8n. Sincronize o n8n de novo.');
    return live;
  }

  function requireSyncedIds(): { credentialIds: CredentialIds; errosWorkflowId: string } {
    if (!context.credentialIds || !context.errosWorkflowId) {
      throw new DomainError("N8N_NOT_SYNCED", "Sincronize o n8n antes de publicar o fluxo (credenciais e workflow de erros ainda não gravados).");
    }
    return { credentialIds: context.credentialIds, errosWorkflowId: context.errosWorkflowId };
  }

  function merge(source: { nodes: N8nNode[]; connections: Record<string, unknown> }, live: N8nWorkflow): MergedFlow {
    const ids = requireSyncedIds();
    return mergeFlow({
      source,
      live,
      credentialIds: ids.credentialIds,
      errosWorkflowId: ids.errosWorkflowId,
      painelUrl: context.painelUrl,
      evolutionUrl: context.evolutionUrl,
      n8nApiUrl: context.n8nApiUrl,
    });
  }

  async function put(merged: MergedFlow): Promise<void> {
    await callN8n(() => context.client.updateWorkflow(context.botWorkflowId!, merged));
  }

  /** Volta o vivo para o que estava antes do PUT. Devolve se conseguiu. */
  async function restore(before: N8nWorkflow, snapshot: FlowSnapshot): Promise<boolean> {
    try {
      await put(merge({ nodes: snapshot.nodes, connections: snapshot.connections }, before));
      return true;
    } catch (error) {
      logger.error("platform.bot_flow.restore_failed", { errorMessage: errorText(error) });
      return false;
    }
  }

  /** Confere o que o n8n gravou de fato: rota/webhookId intactos e hash igual ao esperado. */
  async function verify(before: N8nWorkflow, expectedHash: string): Promise<string | null> {
    const after = await fetchLive();
    const beforeFp = webhookFingerprint(before.nodes);
    const afterFp = webhookFingerprint(after.nodes);
    for (const key of Object.keys(beforeFp)) {
      if (afterFp[key] !== beforeFp[key]) return `${key} mudou depois da gravação`;
    }
    const afterHash = canonicalFlowHash(after.nodes, after.connections);
    if (afterHash !== expectedHash) return "o fluxo gravado no n8n não bate com o esperado";
    return null;
  }

  function snapshotOf(live: N8nWorkflow, liveHash: string, state: PublishedState): FlowSnapshot {
    const untouched = state.hash !== null && state.hash === liveHash;
    return {
      version: untouched ? (state.version ?? "1.0.0") : state.version ? `${state.version} (editado no n8n)` : "original",
      hash: liveHash,
      nodes: structuredClone(live.nodes),
      connections: structuredClone(live.connections ?? {}),
    };
  }

  /**
   * O que vai para o BANCO (`previous`): sem segredos literais dos parâmetros dos nós (I4). O snapshot
   * em memória segue íntegro para `restore` na mesma requisição; o hash é recalculado sobre o que foi
   * gravado, então o "voltar" continua verificável. Fluxo sem segredo literal = idêntico ao original.
   */
  function forStorage(snapshot: FlowSnapshot): FlowSnapshot {
    const nodes = redactFlowSecrets(snapshot.nodes);
    return { ...snapshot, nodes, hash: canonicalFlowHash(nodes, snapshot.connections) };
  }

  async function getStatus(): Promise<BotFlowStatus> {
    const state = await store.load();
    let liveHash: string | null = null;
    let error: string | null = null;
    try {
      const live = await fetchLive();
      liveHash = canonicalFlowHash(live.nodes, live.connections);
    } catch (e) {
      error = e instanceof DomainError || e instanceof Error ? e.message : String(e);
    }
    const firstPublish = state.hash === null;
    return {
      buildVersion: build.version,
      buildHash: build.hash,
      publishedVersion: state.version,
      publishedHash: state.hash,
      publishedAt: state.publishedAt ? state.publishedAt.toISOString() : null,
      liveHash,
      drift: !firstPublish && liveHash !== null && liveHash !== state.hash,
      firstPublish,
      updateAvailable: build.hash !== state.hash,
      canRollback: state.previous !== null,
      previousVersion: state.previous?.version ?? null,
      n8nReachable: liveHash !== null,
      error,
    };
  }

  async function publish(userId: string, confirm?: PublishConfirm): Promise<PublishResult> {
    return withPublishLock(async () => {
      const live = await fetchLive();
      const state = await store.load();
      const liveHash = canonicalFlowHash(live.nodes, live.connections);
      const firstPublish = state.hash === null;
      const drift = !firstPublish && liveHash !== state.hash;

      if (firstPublish && confirm !== "PUBLICAR" && confirm !== "SOBRESCREVER") {
        throw new DomainError(
          "CONFIRMATION_REQUIRED",
          'Primeira publicação: o fluxo que está no n8n será substituído pelo do painel. Confirme com "PUBLICAR".',
        );
      }
      if (drift && confirm !== "SOBRESCREVER") {
        throw new DomainError(
          "FLOW_DRIFT",
          "O fluxo no n8n foi editado à mão depois da última publicação. Baixe o vivo para conferir; publicar agora descarta essas edições (confirme com \"SOBRESCREVER\").",
          { liveHash, publishedHash: state.hash },
        );
      }
      // Já é exatamente o que está publicado e vivo: nada a fazer — e regravar apagaria o "voltar".
      if (!firstPublish && !drift && liveHash === build.hash) {
        return { version: state.version ?? build.version, hash: liveHash, publishedAt: (state.publishedAt ?? now()).toISOString(), rolledBack: false };
      }

      const merged = merge({ nodes: build.nodes, connections: build.connections }, live); // WEBHOOK_PATH_CHANGED sai daqui, antes de qualquer escrita
      const snapshot = snapshotOf(live, liveHash, state);

      await store.setPrevious(forStorage(snapshot));
      try {
        await put(merged);
      } catch (error) {
        await store.setPrevious(state.previous); // nada mudou no vivo: mantém o "voltar" anterior
        throw error;
      }

      const problem = await verify(live, build.hash).catch((e) => `verificação falhou: ${errorText(e)}`);
      if (problem) {
        const restored = await restore(live, snapshot);
        await store.setPrevious(state.previous);
        logger.error("platform.bot_flow.verify_failed", { problem, restored });
        throw new DomainError(
          "PUBLISH_VERIFY_FAILED",
          restored
            ? `A publicação foi desfeita: ${problem}. O fluxo anterior foi restaurado.`
            : `A publicação falhou (${problem}) e NÃO consegui restaurar o fluxo anterior. Confira o n8n agora.`,
          { restored },
        );
      }

      const publishedAt = now();
      await store.savePublished({ version: build.version, hash: build.hash, publishedAt, userId, previous: forStorage(snapshot) });
      logger.info("platform.bot_flow.published", { version: build.version, hash: build.hash, overwroteDrift: drift, first: firstPublish, userId });
      return { version: build.version, hash: build.hash, publishedAt: publishedAt.toISOString(), rolledBack: false };
    });
  }

  async function rollback(userId: string): Promise<PublishResult> {
    return withPublishLock(async () => {
      const state = await store.load();
      const snapshot = state.previous;
      if (!snapshot) throw new DomainError("NO_SNAPSHOT", "Não há versão anterior guardada para voltar.");

      const live = await fetchLive();
      const expectedHash = canonicalFlowHash(snapshot.nodes, snapshot.connections);
      const merged = merge({ nodes: snapshot.nodes, connections: snapshot.connections }, live);
      await put(merged);

      const problem = await verify(live, expectedHash).catch((e) => `verificação falhou: ${errorText(e)}`);
      if (problem) {
        const liveHash = canonicalFlowHash(live.nodes, live.connections);
        const restored = await restore(live, { version: state.version ?? "atual", hash: liveHash, nodes: live.nodes, connections: live.connections });
        logger.error("platform.bot_flow.rollback_verify_failed", { problem, restored });
        throw new DomainError(
          "PUBLISH_VERIFY_FAILED",
          restored ? `O retorno foi desfeito: ${problem}. O fluxo de antes foi restaurado.` : `O retorno falhou (${problem}) e NÃO consegui restaurar. Confira o n8n agora.`,
          { restored },
        );
      }

      const publishedAt = now();
      // Volta de 1 versão só: depois disto não há "anterior" (voltar de novo seria publicar de novo).
      await store.savePublished({ version: snapshot.version, hash: expectedHash, publishedAt, userId, previous: null });
      logger.info("platform.bot_flow.rolled_back", { version: snapshot.version, hash: expectedHash, userId });
      return { version: snapshot.version, hash: expectedHash, publishedAt: publishedAt.toISOString(), rolledBack: true };
    });
  }

  async function downloadLive(): Promise<{ filename: string; json: string }> {
    const live = await fetchLive();
    const hash = canonicalFlowHash(live.nodes, live.connections);
    const clean = sanitizeFlowForDownload(live);
    return { filename: `innochat-bot-vivo-${hash.slice(0, 8)}.json`, json: JSON.stringify(clean, null, 2) };
  }

  return { getStatus, publish, rollback, downloadLive };
}

// ---------------------------------------------------------------------------
// Ligação com o banco e o n8n real
// ---------------------------------------------------------------------------

function isSnapshot(value: unknown): value is FlowSnapshot {
  const v = value as Partial<FlowSnapshot> | null;
  return !!v && typeof v.version === "string" && typeof v.hash === "string" && Array.isArray(v.nodes) && typeof v.connections === "object" && v.connections !== null;
}

/**
 * "Sem snapshot" grava `{}` em vez de `Prisma.JsonNull`: o Prisma cru só pode ser importado em
 * `src/lib/db/` (ESLint) e o sentinel é valor de runtime, não tipo. `isSnapshot` trata `{}` (e
 * NULL de linhas antigas) como "não há versão anterior".
 */
function toJson(snapshot: FlowSnapshot | null): object {
  return snapshot ?? {};
}

export function createDbPublishStore(): PublishStore {
  return {
    async load() {
      const row = await getPrisma().platformSettings.findUnique({
        where: { id: 1 },
        select: { n8nBotFlowVersion: true, n8nBotFlowHash: true, n8nBotFlowPublishedAt: true, n8nBotFlowPrevious: true },
      });
      return {
        version: row?.n8nBotFlowVersion ?? null,
        hash: row?.n8nBotFlowHash ?? null,
        publishedAt: row?.n8nBotFlowPublishedAt ?? null,
        previous: isSnapshot(row?.n8nBotFlowPrevious) ? row.n8nBotFlowPrevious : null,
      };
    },
    async setPrevious(snapshot) {
      await getPrisma().platformSettings.update({ where: { id: 1 }, data: { n8nBotFlowPrevious: toJson(snapshot) } });
    },
    async savePublished({ version, hash, publishedAt, userId, previous }) {
      await getPrisma().platformSettings.update({
        where: { id: 1 },
        data: {
          n8nBotFlowVersion: version,
          n8nBotFlowHash: hash,
          n8nBotFlowPublishedAt: publishedAt,
          n8nBotFlowPublishedByUserId: userId,
          n8nBotFlowPrevious: toJson(previous),
        },
      });
    },
  };
}

async function loadDbContext(): Promise<PublishContext> {
  const row = await loadPlatformSettingsRow();
  const n8nBaseUrl = row?.n8nBaseUrl ?? null;
  const n8nApiKey = readGenericSecret(row?.n8nApiKey, "n8nApiKey");
  if (!n8nBaseUrl || !n8nApiKey) {
    throw new DomainError("N8N_NOT_CONFIGURED", "Configure a URL e a API key do n8n em Admin > Configurações antes de publicar o fluxo.");
  }
  const credentialIds =
    row?.n8nCredPainelId && row.n8nCredEvolutionId && row.n8nCredApiId
      ? { painel: row.n8nCredPainelId, evolution: row.n8nCredEvolutionId, n8n: row.n8nCredApiId }
      : null;
  return {
    client: createN8nClient(n8nBaseUrl, n8nApiKey),
    botWorkflowId: row?.n8nWorkflowBotId ?? null,
    errosWorkflowId: row?.n8nWorkflowErrosId ?? null,
    credentialIds,
    painelUrl: `${await getPublicBaseUrl()}/api/internal/v1`,
    evolutionUrl: (row?.evolutionApiUrl ?? "").replace(/\/$/, ""),
    n8nApiUrl: `${n8nBaseUrl.replace(/\/$/, "")}/api/v1`,
  };
}

async function dbPublisher() {
  return createFlowPublisher({ store: createDbPublishStore(), context: await loadDbContext(), build: loadBundledBuildFlow() });
}

export async function getBotFlowStatus(): Promise<BotFlowStatus> {
  const build = loadBundledBuildFlow();
  let context: PublishContext;
  try {
    context = await loadDbContext();
  } catch (error) {
    // Sem n8n configurado o status ainda é útil (versão do build, o que foi publicado).
    const state = await createDbPublishStore().load();
    return {
      buildVersion: build.version,
      buildHash: build.hash,
      publishedVersion: state.version,
      publishedHash: state.hash,
      publishedAt: state.publishedAt ? state.publishedAt.toISOString() : null,
      liveHash: null,
      drift: false,
      firstPublish: state.hash === null,
      updateAvailable: build.hash !== state.hash,
      canRollback: state.previous !== null,
      previousVersion: state.previous?.version ?? null,
      n8nReachable: false,
      error: errorText(error),
    };
  }
  return createFlowPublisher({ store: createDbPublishStore(), context, build }).getStatus();
}

export async function publishBotFlow(userId: string, confirm?: PublishConfirm): Promise<PublishResult> {
  return (await dbPublisher()).publish(userId, confirm);
}

export async function rollbackBotFlow(userId: string): Promise<PublishResult> {
  return (await dbPublisher()).rollback(userId);
}

export async function downloadLiveBotFlow(): Promise<{ filename: string; json: string }> {
  return (await dbPublisher()).downloadLive();
}
