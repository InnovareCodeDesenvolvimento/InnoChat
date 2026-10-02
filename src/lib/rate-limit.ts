/**
 * Rate limit em memória, janela fixa (docs/arquitetura.md — cadastro público por IP).
 *
 * Deliberadamente simples: um único processo Next.js (ver docs/arquitetura.md §14, um domínio
 * público único, sem múltiplas instâncias atrás de load balancer na v1). Se o painel um dia
 * escalar horizontalmente, isto precisa virar um contador no Postgres/Redis — registrar essa
 * migração como TODO nesse dia, não antes (YAGNI: não complicar hoje por um cenário que não
 * existe ainda).
 */

import { globalState } from "./global-state";

type Bucket = { count: number; resetAt: number };

// Em `globalThis`: o Next empacota este módulo uma vez por bundle (Server Action x Route Handler) e um `Map` de módulo
// viraria vários contadores, dobrando o teto de tentativas (ver `global-state.ts`).
const state = globalState("rate-limit", () => ({ buckets: new Map<string, Bucket>(), callsSinceSweep: 0 }));
const buckets = state.buckets;

// Evita crescimento sem limite do Map em um processo de vida longa: poda entradas expiradas a
// cada N chamadas em vez de um setInterval (sem timer para gerenciar em teste/serverless).
const SWEEP_EVERY = 200;

function sweep(now: number) {
  state.callsSinceSweep += 1;
  if (state.callsSinceSweep < SWEEP_EVERY) return;
  state.callsSinceSweep = 0;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterMs: number };

/**
 * `key` deve já incluir o escopo (ex.: `signup:203.0.113.5`) — esta função não sabe nada sobre
 * IP/rota, só conta.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
  }

  if (existing.count >= limit) {
    return { allowed: false, remaining: 0, retryAfterMs: existing.resetAt - now };
  }

  existing.count += 1;
  return { allowed: true, remaining: limit - existing.count, retryAfterMs: 0 };
}

/** Só para testes: zera todos os contadores. */
export function __resetRateLimitsForTests() {
  buckets.clear();
}
