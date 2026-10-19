/**
 * Cloudflare na frente do Traefik (troca de servidor, 2026-10-19) — exercita, contra Postgres
 * real (`PlatformSettings`), o que os unit tests de `client-ip.test.ts`/`public-url.test.ts` não
 * cobrem: a escrita de verdade feita por `ensurePublicBaseUrlFromCurrentRequest`, e `clientIp()`
 * ponta a ponta (a função async exportada, não só `pickClientIp` pura) com cabeçalhos de borda da
 * Cloudflare reais.
 *
 * `next/headers` é mockado (fora de uma requisição HTTP de verdade não dá para popular o
 * AsyncLocalStorage do App Router chamando a função direto — ver `support-session.integration.test.ts`
 * para o mesmo padrão); tudo o mais (Prisma, `getPublicBaseUrl`) é real.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

const headerMap = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (name: string) => headerMap.get(name.toLowerCase()) ?? null,
  })),
}));

function setHeaders(h: Record<string, string>) {
  headerMap.clear();
  for (const [k, v] of Object.entries(h)) headerMap.set(k.toLowerCase(), v);
}

const { clientIp } = await import("@/lib/http/client-ip");
const { ensurePublicBaseUrlFromCurrentRequest, clearTrustedPublicBaseUrlCache } = await import("@/lib/public-url");

const prisma = getPrisma();
let originalBase: string | null = null;

beforeAll(async () => {
  originalBase = (await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { publicBaseUrl: true } }))?.publicBaseUrl ?? null;
});

afterEach(async () => {
  await prisma.platformSettings.updateMany({ where: { id: 1 }, data: { publicBaseUrl: null } });
  clearTrustedPublicBaseUrlCache();
});

afterAll(async () => {
  await prisma.platformSettings.updateMany({ where: { id: 1 }, data: { publicBaseUrl: originalBase } });
  clearTrustedPublicBaseUrlCache();
  await prisma.$disconnect();
});

describe("clientIp() ponta a ponta — Cloudflare na frente do Traefik", () => {
  it("XFF termina num IP de borda da Cloudflare + CF-Connecting-IP presente: usa o IP do visitante", async () => {
    setHeaders({
      "x-forwarded-for": "172.64.0.1", // Traefik reescreveu o XFF com o IP de quem conectou nele (a borda da Cloudflare)
      "cf-connecting-ip": "198.51.100.11",
    });
    await expect(clientIp()).resolves.toBe("198.51.100.11");
  });

  it("dois visitantes diferentes atrás da mesma borda da Cloudflare não ficam com o mesmo IP", async () => {
    setHeaders({ "x-forwarded-for": "172.64.0.1", "cf-connecting-ip": "198.51.100.11" });
    const first = await clientIp();
    setHeaders({ "x-forwarded-for": "172.64.0.1", "cf-connecting-ip": "198.51.100.22" });
    const second = await clientIp();
    expect(first).not.toBe(second);
  });

  it("XFF NÃO vem de borda da Cloudflare (hop fora da faixa) + CF-Connecting-IP forjado: ignora o header forjado", async () => {
    setHeaders({ "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "9.9.9.9" });
    await expect(clientIp()).resolves.toBe("203.0.113.9");
  });

  it("sem Cloudflare na frente (sem CF-Connecting-IP): comportamento de sempre, por hops no XFF", async () => {
    setHeaders({ "x-forwarded-for": "203.0.113.9" });
    await expect(clientIp()).resolves.toBe("203.0.113.9");
  });
});

describe("ensurePublicBaseUrlFromCurrentRequest + cf-visitor — grava no Postgres real", () => {
  it("SSL Flexible (CF → origem sem TLS): x-forwarded-proto=http, cf-visitor diz https, XFF termina em borda Cloudflare — grava https", async () => {
    setHeaders({
      "x-forwarded-host": "painel.innovarecode.com.br",
      host: "painel.innovarecode.com.br",
      "x-forwarded-for": "172.64.0.1",
      "x-forwarded-proto": "http",
      "cf-visitor": '{"scheme":"https"}',
    });
    await ensurePublicBaseUrlFromCurrentRequest();
    const stored = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { publicBaseUrl: true } });
    expect(stored?.publicBaseUrl).toBe("https://painel.innovarecode.com.br");
  });

  it("cf-visitor https com edge hop FORA da faixa Cloudflare (anti-spoof): ignora o cf-visitor forjado — fica só com x-forwarded-proto=http, que `normalizeBaseUrl` recusa para host não-local, então NÃO grava nada", async () => {
    setHeaders({
      "x-forwarded-host": "painel.innovarecode.com.br",
      "x-forwarded-for": "203.0.113.9", // não é borda da Cloudflare — qualquer um bateria direto na origem forjando cf-visitor
      "x-forwarded-proto": "http",
      "cf-visitor": '{"scheme":"https"}',
    });
    await ensurePublicBaseUrlFromCurrentRequest();
    const stored = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { publicBaseUrl: true } });
    // Sem o anti-spoof, o `cf-visitor` forjado faria isto gravar "https://..." mesmo sem a Cloudflare na frente.
    expect(stored?.publicBaseUrl).toBeNull();
  });

  it("não sobrescreve quando já há base gravada, mesmo com cf-visitor apontando outro esquema", async () => {
    await prisma.platformSettings.upsert({
      where: { id: 1 },
      create: { id: 1, publicBaseUrl: "https://ja-gravado.example.com" },
      update: { publicBaseUrl: "https://ja-gravado.example.com" },
    });
    clearTrustedPublicBaseUrlCache();
    setHeaders({
      "x-forwarded-host": "outro-host.example.com",
      "x-forwarded-proto": "http",
      "cf-visitor": '{"scheme":"https"}',
    });
    await ensurePublicBaseUrlFromCurrentRequest();
    const stored = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { publicBaseUrl: true } });
    expect(stored?.publicBaseUrl).toBe("https://ja-gravado.example.com");
  });
});
