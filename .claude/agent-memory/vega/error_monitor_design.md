---
name: error-monitor-design
description: Monitor de erros próprio (Melhoria 1, 2026-10-02) — onde captura, janela de alerta e armadilhas (timestamp sem fuso no SQL cru, auto-flush nos testes)
metadata:
  type: project
---

Captura: `onRequestError` (instrumentation.ts) + sink do `logger.error` (Symbol em globalThis, registrado no `register()`) + `POST /api/client-errors` (navegador). Tudo vai por `src/modules/error-monitor/capture.ts` (`captureError` fire-and-forget, teto 120/min, 2 s por assinatura, max 5 em voo; o monitor só usa `console.warn`/`logger.warn`, nunca `logger.error`, para não fazer loop).

- Upsert em SQL cru (`src/lib/db/error-queries.ts`). **Armadilha:** colunas `timestamp(3)` sem fuso + `Date` em `$queryRaw` = Postgres converte pelo fuso da SESSÃO e a hora sai deslocada (viu -3 h no banco de teste). Fixar com `(${date}::timestamptz AT TIME ZONE 'UTC')`.
- Alerta: `alertedAt` nulo + OPEN = "novo"; RESOLVED que repete zera `alertedAt` (regressão avisa de novo). Janela de 15 min = linha única em `ProviderEvent(provider="error-alert", id = floor(now/15min))` via `createMany skipDuplicates` (não gera log de erro do Prisma como o P2002). Falha de envio desfaz `alertedAt` mas a janela fica gasta. Timer único adiado + manutenção diária pegam o que sobrou.
- Sino é DERIVADO do grupo (OPEN com firstSeenAt na janela de 30 dias, `err:<id>`), independe do e-mail.
- Boundary só relata erro SEM `digest` (com digest o servidor já registrou: contaria em dobro).
- **Teste de integração:** o disparo automático da captura (`scheduleErrorAlertFlush`) usa o relógio real e atropela testes de janela com datas fixas. Mockar `scheduleErrorAlertFlush` com flag hoisted e ligar só no teste que quer o disparo.
- Retenção: eventos > 30 dias no `runMaintenanceTick` (+ linhas de janela > 2 dias); grupos ficam (não há purge de grupo).
