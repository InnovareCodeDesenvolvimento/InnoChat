import { loadPlatformSettingsRow, readGenericSecret } from "@/modules/platform/secrets";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Adaptador Evolution API v2 (docs/arquitetura.md §4, §8; mission da Fase 3). Interface isolada
 * de propósito — nenhum outro módulo do sistema conhece a forma exata das respostas da
 * Evolution; tudo passa por `EvolutionClient`, injetável nos testes (`__tests__/`, testes de
 * integração do módulo `whatsapp`).
 *
 * ⚠️ HONESTIDADE SOBRE O QUE FOI VERIFICADO: implementado a partir da documentação pública da
 * Evolution API v2 e do adaptador validado AO VIVO no InnoAtendente em 2026-09-04
 * (`C:\Projetos\Web\InnoAtendente\src\adapters\whatsapp\evolution\index.ts`) — mas o InnoChat
 * **não tem servidor Evolution real conectado nesta rodada** (a credencial fica em
 * `PlatformSettings`, configurada pelo admin depois do deploy). Todo formato de resposta abaixo
 * está marcado com `SUPOSIÇÃO:` e os testes unitários (`evolution-client.test.ts`) usam fixtures
 * **não capturadas de um servidor do InnoChat** — ver handoff desta rodada.
 */

const EVOLUTION_TIMEOUT_MS = 15_000;
const EVOLUTION_MAX_ATTEMPTS = 3;
const NUMBER_CHECK_TIMEOUT_MS = 4_000;
const EVOLUTION_RETRY_DELAY_MS = 300;

export class EvolutionApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly cause?: unknown,
    /** Corpo cru da resposta de erro. NUNCA entra em log/mensagem (pode ecoar dado pessoal); só o teste de envio interativo do admin lê. */
    readonly responseBody?: string,
  ) {
    super(message);
    this.name = "EvolutionApiError";
  }
}

export type EvolutionConnectResult = {
  qrCodeDataUrl: string | null;
  pairingCode: string | null;
};

/** Estado bruto devolvido por `connectionState` — mapeamento para o enum do domínio fica em `src/core/whatsapp/connection-event.ts` (reaproveitado aqui via `mapConnectionStateValue`). */
export type EvolutionRawState = "open" | "connecting" | "close" | "closed" | string;

/** Botão de resposta rápida (`type: "reply"`) do `sendButtons` — no máximo 3 (limite da Evolution 2.3.7). */
export type EvolutionReplyButton = { type: "reply"; displayText: string; id: string };

export type EvolutionListRow = { title: string; description?: string; rowId: string };

export type EvolutionListInput = {
  title: string;
  description?: string;
  footerText?: string;
  /** Texto do botão que abre a lista (ex.: "Ver opções"). */
  buttonText: string;
  sections: { title: string; rows: EvolutionListRow[] }[];
};

export type EvolutionButtonsInput = {
  title: string;
  description?: string;
  footer?: string;
  buttons: EvolutionReplyButton[];
};

export type EvolutionPollInput = {
  name: string;
  /** 1 = escolha única (o que o bot usa); 0 = qualquer quantidade. */
  selectableCount: number;
  /** 2 a 10 opções únicas. */
  values: string[];
};

/** Resultado de envio interativo: além do id, devolve status e corpo da Evolution (para o teste do admin provar o que ela respondeu). */
export type EvolutionInteractiveSendResult = { messageId: string | null; status: number; body: unknown };

export type EvolutionNumberCheck = { number: string; exists: boolean };

export type EvolutionWebhookInfo = { enabled: boolean; url: string | null; events: string[] };

export interface EvolutionClient {
  /** `POST /instance/create` — cria a instância na Evolution. Não configura webhook (passo separado, ver `setWebhook`). */
  createInstance(instanceName: string): Promise<void>;
  /** `POST /webhook/set/{instance}` — sempre explícito, depois do create (docs/arquitetura.md §4). */
  setWebhook(instanceName: string, webhookUrl: string): Promise<void>;
  /**
   * `GET /webhook/find/{instance}` — o webhook configurado hoje (`null` = nenhum). Opcional de propósito: só a manutenção do
   * WhatsApp de cobrança usa, para reaplicar o webhook se alguém/algo o trocou; quem não implementa é simplesmente pulado.
   */
  findWebhook?(instanceName: string): Promise<EvolutionWebhookInfo | null>;
  /** `GET /instance/connect/{instance}` — QR (data URL) e pairing code, quando disponíveis. */
  connect(instanceName: string): Promise<EvolutionConnectResult>;
  /** `GET /instance/connectionState/{instance}` — estado atual da sessão Baileys. */
  connectionState(instanceName: string): Promise<EvolutionRawState>;
  /** `GET /instance/fetchInstances?instanceName=` — usado para obter o `ownerJid` após conectar. */
  fetchOwnerJid(instanceName: string): Promise<string | null>;
  /** `DELETE /instance/logout/{instance}` — encerra a sessão, mantém a instância cadastrada. */
  logout(instanceName: string): Promise<void>;
  /** `DELETE /instance/delete/{instance}` — remove a instância de vez da Evolution. */
  deleteInstance(instanceName: string): Promise<void>;
  /**
   * `POST /message/sendText/{instance}` com `{ number, text }` (mesmo formato do nó "Enviar pela
   * Evolution" do workflow do n8n). UMA tentativa só (sem retry): reenviar mensagem após timeout
   * pode duplicar no WhatsApp do cliente — quem chama decide se tenta de novo. Devolve o id da
   * mensagem no provedor quando a resposta traz (`key.id`), senão `null`.
   */
  sendText(instanceName: string, number: string, text: string): Promise<{ messageId: string | null }>;
  /**
   * `POST /chat/whatsappNumbers/{instance}` com `{ numbers }`: diz, para cada número (só dígitos com DDI), se ele tem
   * WhatsApp. UMA tentativa e prazo curto (`timeoutMs`, padrão 4 s): quem chama trata a falha como "não deu para
   * conferir" e segue sem bloquear o usuário. `exists` só é `true` quando a Evolution diz `exists: true`.
   */
  checkWhatsappNumbers(instanceName: string, numbers: string[], options?: { timeoutMs?: number }): Promise<EvolutionNumberCheck[]>;
  /**
   * `POST /message/sendButtons/{instance}` (Evolution 2.3.x: `interactiveMessage`/`nativeFlowMessage`
   * `quick_reply`). Sem retry. ⚠️ O WhatsApp pode NÃO renderizar em contas não oficiais (Baileys);
   * ver docs/whatsapp-botoes-listas.md. Validação de limites (≤3 botões) é do chamador e da Evolution.
   */
  sendButtons(instanceName: string, number: string, input: EvolutionButtonsInput): Promise<EvolutionInteractiveSendResult>;
  /** `POST /message/sendList/{instance}` (`listMessage` legado, `listType: 2`). Sem retry. Mesma ressalva de renderização. */
  sendList(instanceName: string, number: string, input: EvolutionListInput): Promise<EvolutionInteractiveSendResult>;
  /** `POST /message/sendPoll/{instance}` (enquete). Sem retry. O voto volta no webhook como `pollUpdateMessage`. */
  sendPoll(instanceName: string, number: string, input: EvolutionPollInput): Promise<EvolutionInteractiveSendResult>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `data:image/png;base64,...` — aceita base64 cru ou já em data URL, sempre devolve data URL. */
function toDataUrl(base64OrDataUrl: string): string {
  return base64OrDataUrl.startsWith("data:") ? base64OrDataUrl : `data:image/png;base64,${base64OrDataUrl}`;
}

/**
 * `fetch` com timeout e retry — SÓ em falha de rede/timeout e 5xx (nunca em 4xx: erro do nosso
 * lado, repetir não ajuda). Mesma política do resto do sistema (§6.1, `mercadopago.ts`).
 */
async function fetchWithRetry(url: string, init: RequestInit, maxAttempts: number = EVOLUTION_MAX_ATTEMPTS, timeoutMs: number = EVOLUTION_TIMEOUT_MS): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status >= 500 && attempt < maxAttempts) {
        lastError = new Error(`Evolution respondeu ${response.status}`);
        await sleep(EVOLUTION_RETRY_DELAY_MS);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      await sleep(EVOLUTION_RETRY_DELAY_MS);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Falha ao chamar Evolution API");
}

/**
 * Corpo de erro da Evolution NUNCA entra em log/mensagem de exceção (achado do Órion no
 * InnoAtendente, replicado aqui de propósito): pode ecoar dado pessoal do payload da
 * requisição. Só status + path + um id de correlação.
 */
async function evolutionRequestFull(
  baseUrl: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
  maxAttempts?: number,
  timeoutMs?: number,
): Promise<{ status: number; body: unknown }> {
  const url = `${baseUrl}${path}`;
  const response = await fetchWithRetry(
    url,
    {
      ...init,
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
        ...(init?.headers ?? {}),
      },
    },
    maxAttempts,
    timeoutMs,
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    const correlationId = crypto.randomUUID();
    logger.error("evolution: resposta de erro da API", { path, status: response.status, correlationId });
    throw new EvolutionApiError(
      `Evolution API respondeu ${response.status} em ${path} (correlationId=${correlationId})`,
      response.status,
      undefined,
      errorBody,
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body };
}

async function evolutionRequest(
  baseUrl: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
  maxAttempts?: number,
  timeoutMs?: number,
): Promise<unknown> {
  return (await evolutionRequestFull(baseUrl, apiKey, path, init, maxAttempts, timeoutMs)).body;
}

interface FetchInstancesEntry {
  instance?: { instanceName?: string; owner?: string };
  ownerJid?: string;
  owner?: string;
}

/** Implementação real, contra um servidor Evolution API v2 (`baseUrl`/`apiKey` já resolvidos). */
export function createEvolutionClient(baseUrl: string, apiKey: string): EvolutionClient {
  const base = baseUrl.replace(/\/+$/, "");

  return {
    // SUPOSIÇÃO: `POST /instance/create` aceita este corpo (documentação pública da Evolution
    // API v2). O webhook NÃO vai embutido aqui de propósito — a mission pede `webhook/set`
    // explícito e separado, para o log de erro do 2º passo apontar exatamente onde falhou.
    async createInstance(instanceName) {
      try {
        await evolutionRequest(base, apiKey, "/instance/create", {
          method: "POST",
          body: JSON.stringify({
            instanceName,
            integration: "WHATSAPP-BAILEYS",
            qrcode: true,
            groupsIgnore: true,
            readMessages: false,
            alwaysOnline: false,
          }),
        });
      } catch (error) {
        throw wrapNetworkError(error, `criar instância ${instanceName}`);
      }
    },

    // SUPOSIÇÃO: `POST /webhook/set/{instance}` com o corpo abaixo (documentação pública). O
    // nome do endpoint mudou de versão para versão (`/webhook/set/` vs. `/webhook/instance/`);
    // esta é a forma documentada mais estável na v2.
    async setWebhook(instanceName, webhookUrl) {
      try {
        await evolutionRequest(base, apiKey, `/webhook/set/${instanceName}`, {
          method: "POST",
          body: JSON.stringify({
            webhook: {
              enabled: true,
              url: webhookUrl,
              byEvents: false,
              base64: false,
              events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"],
            },
          }),
        });
      } catch (error) {
        throw wrapNetworkError(error, `configurar webhook de ${instanceName}`);
      }
    },

    // SUPOSIÇÃO (Evolution v2, documentação pública): `GET /webhook/find/{instance}` devolve `{ enabled, url, events, ... }`
    // (ou `null`/`{}` sem webhook). 404 também vale como "sem webhook".
    async findWebhook(instanceName) {
      try {
        const response = (await evolutionRequest(base, apiKey, `/webhook/find/${encodeURIComponent(instanceName)}`, { method: "GET" }, 1, 8_000)) as
          | { enabled?: unknown; url?: unknown; events?: unknown; webhook?: { enabled?: unknown; url?: unknown; events?: unknown } }
          | null;
        const row = response && typeof response === "object" ? (response.webhook && typeof response.webhook === "object" ? response.webhook : response) : null;
        if (!row || (typeof row.url !== "string" && row.enabled === undefined)) return null;
        return {
          enabled: row.enabled === true,
          url: typeof row.url === "string" && row.url ? row.url : null,
          events: Array.isArray(row.events) ? row.events.filter((e): e is string => typeof e === "string") : [],
        };
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw wrapNetworkError(error, `consultar webhook de ${instanceName}`);
      }
    },

    // SUPOSIÇÃO: `GET /instance/connect/{instance}` devolve o QR em `base64`, `qrcode.base64`
    // ou `code` (varia por versão) e o pairing code em `pairingCode` — tratamos as formas
    // conhecidas, nunca lançamos por um formato de QR ausente (instância já conectada não tem QR).
    async connect(instanceName) {
      try {
        const response = (await evolutionRequest(base, apiKey, `/instance/connect/${instanceName}`, {
          method: "GET",
        })) as { base64?: string; code?: string; pairingCode?: string; qrcode?: { base64?: string; code?: string } } | null;

        const rawQr = response?.base64 ?? response?.qrcode?.base64 ?? response?.code ?? response?.qrcode?.code;
        return {
          qrCodeDataUrl: rawQr ? toDataUrl(rawQr) : null,
          pairingCode: response?.pairingCode ?? null,
        };
      } catch (error) {
        throw wrapNetworkError(error, `obter QR de ${instanceName}`);
      }
    },

    // SUPOSIÇÃO: `GET /instance/connectionState/{instance}` devolve
    // `{ instance: { instanceName, state } }`, com `state` nos valores Baileys (`open` |
    // `connecting` | `close`).
    async connectionState(instanceName) {
      try {
        const response = (await evolutionRequest(base, apiKey, `/instance/connectionState/${instanceName}`, {
          method: "GET",
        })) as { instance?: { state?: string }; state?: string } | null;
        return (response?.instance?.state ?? response?.state ?? "close") as EvolutionRawState;
      } catch (error) {
        throw wrapNetworkError(error, `consultar estado de ${instanceName}`);
      }
    },

    // SUPOSIÇÃO: `GET /instance/fetchInstances?instanceName=` devolve um array com
    // `ownerJid`/`owner`/`instance.owner` (o campo variou entre versões públicas da Evolution) —
    // tentamos as três formas conhecidas.
    async fetchOwnerJid(instanceName) {
      try {
        const response = (await evolutionRequest(
          base,
          apiKey,
          `/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`,
          { method: "GET" },
        )) as FetchInstancesEntry[] | FetchInstancesEntry | null;

        const entry = Array.isArray(response) ? response[0] : response;
        return entry?.ownerJid ?? entry?.owner ?? entry?.instance?.owner ?? null;
      } catch (error) {
        throw wrapNetworkError(error, `buscar dono de ${instanceName}`);
      }
    },

    async logout(instanceName) {
      try {
        await evolutionRequest(base, apiKey, `/instance/logout/${instanceName}`, { method: "DELETE" });
      } catch (error) {
        throw wrapNetworkError(error, `desconectar ${instanceName}`);
      }
    },

    // SUPOSIÇÃO: resposta com `key.id` (Baileys). Ausência do id nunca falha o envio.
    async sendText(instanceName, number, text) {
      try {
        const response = (await evolutionRequest(
          base,
          apiKey,
          `/message/sendText/${encodeURIComponent(instanceName)}`,
          { method: "POST", body: JSON.stringify({ number, text }) },
          1,
        )) as { key?: { id?: string } } | null;
        return { messageId: response?.key?.id ?? null };
      } catch (error) {
        throw wrapNetworkError(error, `enviar mensagem por ${instanceName}`);
      }
    },

    // SUPOSIÇÃO (Evolution v2, documentação pública): resposta é uma lista `[{ exists, jid, number }]`.
    async checkWhatsappNumbers(instanceName, numbers, options) {
      try {
        const response = await evolutionRequest(
          base,
          apiKey,
          `/chat/whatsappNumbers/${encodeURIComponent(instanceName)}`,
          { method: "POST", body: JSON.stringify({ numbers }) },
          1,
          options?.timeoutMs ?? NUMBER_CHECK_TIMEOUT_MS,
        );
        if (!Array.isArray(response)) throw new EvolutionApiError("Resposta inesperada da Evolution ao conferir números.");
        return response.map((item) => {
          const row = (item ?? {}) as { exists?: unknown; number?: unknown; jid?: unknown };
          const raw = typeof row.number === "string" ? row.number : typeof row.jid === "string" ? row.jid.split("@")[0]! : "";
          return { number: raw.replace(/\D/g, ""), exists: row.exists === true };
        });
      } catch (error) {
        throw wrapNetworkError(error, `conferir números por ${instanceName}`);
      }
    },

    async sendButtons(instanceName, number, input) {
      return postInteractive(base, apiKey, "sendButtons", instanceName, {
        number,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.footer ? { footer: input.footer } : {}),
        buttons: input.buttons.map((b) => ({ type: "reply", displayText: b.displayText, id: b.id })),
      });
    },

    async sendList(instanceName, number, input) {
      return postInteractive(base, apiKey, "sendList", instanceName, {
        number,
        title: input.title,
        ...(input.description ? { description: input.description } : {}),
        ...(input.footerText ? { footerText: input.footerText } : {}),
        buttonText: input.buttonText,
        // A Evolution rejeita `description` vazia numa linha: só entra quando preenchida.
        sections: input.sections.map((section) => ({
          title: section.title,
          rows: section.rows.map((row) => ({
            title: row.title,
            rowId: row.rowId,
            ...(row.description ? { description: row.description } : {}),
          })),
        })),
      });
    },

    async sendPoll(instanceName, number, input) {
      return postInteractive(base, apiKey, "sendPoll", instanceName, {
        number,
        name: input.name,
        selectableCount: input.selectableCount,
        values: input.values,
      });
    },

    async deleteInstance(instanceName) {
      try {
        await evolutionRequest(base, apiKey, `/instance/delete/${instanceName}`, { method: "DELETE" });
      } catch (error) {
        throw wrapNetworkError(error, `remover ${instanceName}`);
      }
    },
  };
}

/** Envio interativo: UMA tentativa (reenviar após timeout duplicaria a mensagem), devolve status e corpo. */
async function postInteractive(
  base: string,
  apiKey: string,
  endpoint: "sendButtons" | "sendList" | "sendPoll",
  instanceName: string,
  payload: Record<string, unknown>,
): Promise<EvolutionInteractiveSendResult> {
  try {
    const { status, body } = await evolutionRequestFull(
      base,
      apiKey,
      `/message/${endpoint}/${encodeURIComponent(instanceName)}`,
      { method: "POST", body: JSON.stringify(payload) },
      1,
    );
    const messageId = typeof body === "object" && body !== null ? ((body as { key?: { id?: string } }).key?.id ?? null) : null;
    return { messageId, status, body };
  } catch (error) {
    throw wrapNetworkError(error, `enviar ${endpoint} por ${instanceName}`);
  }
}

function wrapNetworkError(error: unknown, action: string): EvolutionApiError {
  if (error instanceof EvolutionApiError) return error;
  return new EvolutionApiError(`Falha ao ${action} na Evolution: ${error instanceof Error ? error.message : String(error)}`, undefined, error);
}

/**
 * Resolve o cliente real a partir das credenciais em `PlatformSettings` (§8 "Configuração pela
 * plataforma" — nada em env var). Lança `EVOLUTION_NOT_CONFIGURED` se faltar URL ou chave — quem
 * chama decide a mensagem final ao usuário (docs/contratos.md, mission item 5: erro de domínio
 * claro antes de criar instância sem base para funcionar).
 */
export async function getEvolutionClient(): Promise<EvolutionClient> {
  const row = await loadPlatformSettingsRow(); // já migrado; chave decifrada abaixo
  const settings = { evolutionApiUrl: row?.evolutionApiUrl ?? null, evolutionApiKey: readGenericSecret(row?.evolutionApiKey, "evolutionApiKey") };
  if (!settings.evolutionApiUrl || !settings.evolutionApiKey) {
    throw new DomainError("EVOLUTION_NOT_CONFIGURED", "Evolution API não configurada em Admin > Configurações.");
  }
  return createEvolutionClient(settings.evolutionApiUrl, settings.evolutionApiKey);
}
