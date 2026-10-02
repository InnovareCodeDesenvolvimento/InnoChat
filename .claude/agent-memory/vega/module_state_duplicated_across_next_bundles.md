---
name: module-state-duplicated-across-next-bundles
description: No build de produção do Next, Map/let de módulo vira uma cópia por bundle (Server Action x Route Handler x página); estado de segurança tem que ir para globalThis (src/lib/global-state.ts)
metadata:
  type: project
---

Achado da Íris (2026-10-02): rate limit (`buckets`) e desafio de 2FA de uso único (`challenges`) em `Map` de módulo valiam o DOBRO,
porque a Server Action do login e `/api/auth/callback/two-factor` rodam em cópias diferentes do módulo. Também explicava a
revogação de sessão "atrasada" (cache de `sessionVersion` de 5 s por bundle).

**Correção:** `globalState(name, init)` em `src/lib/global-state.ts` (`globalThis` + `Symbol.for`). Aplicado em rate-limit, idempotency,
session-version, two-factor/login (`challenges`), error-monitor (capture + timer do alerta).
**Como evitar:** todo estado em memória que funciona como TRAVA (limite, uso único, cache de revogação) usa `globalState`; nunca `const x = new Map()`
no topo do arquivo. Em teste (vitest) não aparece: só no `next build`. Prova só por E2E contra build de produção.

**Efeito colateral:** o teto de logins por IP (20/15 min) agora conta de verdade; suíte E2E inteira de um IP só estoura. Reiniciar o servidor
entre grupos de specs ou usar `x-forwarded-for` distinto por contexto (clientIp pega o último XFF).
