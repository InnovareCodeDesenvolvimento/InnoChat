import nodemailer from "nodemailer";
import { logger } from "@/lib/logger";
import { safeFetch, UnsafeUrlError } from "@/lib/net/safe-fetch";

/**
 * "Testar conexão" para as integrações configuradas em `PlatformSettings` (docs/contratos.md).
 * Resultado sempre `{ ok, detalhe }` legível — nunca lança, nunca devolve o segredo de volta
 * (nem no `detalhe`, nem em log: só o status HTTP/tipo de erro, docs/arquitetura.md §11).
 * Timeout curto (5s): é um clique de "testar agora" na UI, não uma chamada de negócio — o
 * admin não deve ficar esperando o padrão de retry/timeout de 10s usado no resto do sistema
 * (Mercado Pago, n8n em produção).
 *
 * Evolution/n8n usam `safeFetch` (revisão de segurança 2026-09-28, achado MÉDIA — defesa SSRF
 * leve contra a URL informada pelo admin, ver `src/lib/net/safe-fetch.ts`); Mercado Pago usa a
 * URL fixa da API oficial (`fetchWithTimeout` simples), não é input do admin.
 */

export type ConnectionTestResult = { ok: boolean; detalhe: string };

const TEST_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function safeFetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    return await safeFetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function describeFetchError(error: unknown): string {
  if (error instanceof UnsafeUrlError) {
    return `URL de destino bloqueada por segurança: ${error.message}`;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return `Sem resposta em ${TEST_TIMEOUT_MS / 1000}s (timeout).`;
  }
  return "Não foi possível conectar (erro de rede).";
}

export async function testEvolutionConnection(baseUrl: string, apiKey: string): Promise<ConnectionTestResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/instance/fetchInstances`;
  try {
    const response = await safeFetchWithTimeout(url, { method: "GET", headers: { apikey: apiKey } });
    if (response.ok) return { ok: true, detalhe: "Conectado. A Evolution respondeu." };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detalhe: "Conectou, mas a chave de API foi rejeitada (401/403)." };
    }
    return { ok: false, detalhe: `A Evolution respondeu com status ${response.status}.` };
  } catch (error) {
    logger.warn("platform.connection_test.evolution_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
    return { ok: false, detalhe: describeFetchError(error) };
  }
}

export async function testMercadoPagoConnection(accessToken: string): Promise<ConnectionTestResult> {
  try {
    const response = await fetchWithTimeout("https://api.mercadopago.com/users/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) return { ok: true, detalhe: "Conectado. O access token do Mercado Pago é válido." };
    if (response.status === 401) return { ok: false, detalhe: "Access token inválido ou expirado (401)." };
    return { ok: false, detalhe: `O Mercado Pago respondeu com status ${response.status}.` };
  } catch (error) {
    logger.warn("platform.connection_test.mercadopago_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
    return { ok: false, detalhe: describeFetchError(error) };
  }
}

export async function testN8nConnection(baseUrl: string, apiKey: string): Promise<ConnectionTestResult> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/workflows?limit=1`;
  try {
    const response = await safeFetchWithTimeout(url, { method: "GET", headers: { "X-N8N-API-KEY": apiKey } });
    if (response.ok) return { ok: true, detalhe: "Conectado. A API do n8n respondeu." };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detalhe: "Conectou, mas a API key do n8n foi rejeitada (401/403)." };
    }
    return { ok: false, detalhe: `O n8n respondeu com status ${response.status}.` };
  } catch (error) {
    logger.warn("platform.connection_test.n8n_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
    return { ok: false, detalhe: describeFetchError(error) };
  }
}

export type SmtpConnectionInput = {
  host: string;
  port: number;
  secure: boolean;
  user?: string | null;
  password?: string | null;
};

export async function testSmtpConnection(config: SmtpConnectionInput): Promise<ConnectionTestResult> {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.password ?? undefined } : undefined,
    connectionTimeout: TEST_TIMEOUT_MS,
    greetingTimeout: TEST_TIMEOUT_MS,
  });

  try {
    await transporter.verify();
    return { ok: true, detalhe: "Conectado. O servidor SMTP aceitou o login." };
  } catch (error) {
    logger.warn("platform.connection_test.smtp_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
    return { ok: false, detalhe: "Não foi possível autenticar no SMTP. Confira host, porta, usuário e senha." };
  }
}
