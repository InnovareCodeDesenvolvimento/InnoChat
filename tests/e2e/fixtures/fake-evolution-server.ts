import { startFakeServer } from "./fake-http-server";

/**
 * Fake da Evolution API v2 (`src/modules/whatsapp/evolution-client.ts`) — mantém um estado por
 * `instanceName` (o teste manipula via `setState`/`setOwnerJid` para simular o celular
 * escaneando o QR, sem precisar de um servidor Evolution de verdade). Endpoints implementados:
 * `POST /instance/create`, `POST /webhook/set/:name`, `GET /instance/connect/:name`,
 * `GET /instance/connectionState/:name`, `GET /instance/fetchInstances?instanceName=`,
 * `DELETE /instance/logout/:name`, `DELETE /instance/delete/:name`.
 */

export type FakeEvolutionState = "connecting" | "open" | "close";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export async function startFakeEvolutionServer() {
  const instances = new Map<string, { state: FakeEvolutionState; ownerJid: string | null }>();

  function instanceNameFromPath(url: string, prefix: string): string {
    const path = url.split("?")[0];
    return decodeURIComponent(path.slice(prefix.length));
  }

  const fake = await startFakeServer([
    {
      method: "POST",
      path: "/instance/create",
      handler: ({ body }) => {
        const name = (body as { instanceName?: string })?.instanceName ?? "";
        instances.set(name, { state: "connecting", ownerJid: null });
        return { status: 200, body: { instance: { instanceName: name } } };
      },
    },
    { method: "POST", path: /^\/webhook\/set\//, handler: () => ({ status: 200, body: { webhook: { enabled: true } } }) },
    {
      method: "GET",
      path: /^\/instance\/connect\//,
      handler: ({ url }) => {
        const name = instanceNameFromPath(url, "/instance/connect/");
        if (!instances.has(name)) instances.set(name, { state: "connecting", ownerJid: null });
        return { status: 200, body: { base64: TINY_PNG_BASE64, pairingCode: "ABCD-1234" } };
      },
    },
    {
      method: "GET",
      path: /^\/instance\/connectionState\//,
      handler: ({ url }) => {
        const name = instanceNameFromPath(url, "/instance/connectionState/");
        const state = instances.get(name)?.state ?? "close";
        return { status: 200, body: { instance: { instanceName: name, state } } };
      },
    },
    {
      method: "GET",
      path: /^\/instance\/fetchInstances\?/,
      handler: ({ url }) => {
        const name = new URL(url, "http://fake-evolution.local").searchParams.get("instanceName") ?? "";
        const ownerJid = instances.get(name)?.ownerJid ?? null;
        return { status: 200, body: [{ instance: { instanceName: name }, ownerJid }] };
      },
    },
    {
      // Envio de texto (mensagem de teste do WhatsApp de cobrança): id fixo; a chamada fica em `received`.
      method: "POST",
      path: /^\/message\/sendText\//,
      handler: () => ({ status: 201, body: { key: { id: "E2E-MSG-1" } } }),
    },
    {
      method: "DELETE",
      path: /^\/instance\/logout\//,
      handler: ({ url }) => {
        const name = instanceNameFromPath(url, "/instance/logout/");
        const entry = instances.get(name);
        if (entry) entry.state = "close";
        return { status: 200, body: {} };
      },
    },
    {
      method: "DELETE",
      path: /^\/instance\/delete\//,
      handler: ({ url }) => {
        const name = instanceNameFromPath(url, "/instance/delete/");
        instances.delete(name);
        return { status: 200, body: {} };
      },
    },
  ]);

  return {
    url: fake.url,
    received: fake.received,
    close: fake.close,
    /** Nome da última instância criada (`POST /instance/create`) — útil pra teste que só sabe o rótulo. */
    lastCreatedInstanceName(): string | null {
      const creates = fake.received.filter((r) => r.method === "POST" && r.url === "/instance/create");
      const last = creates.at(-1);
      return last ? ((last.body as { instanceName?: string })?.instanceName ?? null) : null;
    },
    setState(instanceName: string, state: FakeEvolutionState) {
      const entry = instances.get(instanceName) ?? { state: "connecting", ownerJid: null };
      entry.state = state;
      instances.set(instanceName, entry);
    },
    setOwnerJid(instanceName: string, ownerJid: string | null) {
      const entry = instances.get(instanceName) ?? { state: "connecting", ownerJid: null };
      entry.ownerJid = ownerJid;
      instances.set(instanceName, entry);
    },
  };
}
