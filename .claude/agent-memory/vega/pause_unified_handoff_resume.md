---
name: pause-unified-handoff-resume
description: Pausa do bot após resposta da equipe = Tenant.handoffResumeMinutes no painel e no claim v2; claim v1 (flow 1) mantém humanPauseMin
metadata:
  type: project
---

Decisão do dono (2026-09-30): um tempo só, o editável `handoffResumeMinutes`. Implementado em `claim.ts#humanPauseMinutesFor(flow, tenant)`: flow 2 → handoffResumeMinutes (com e sem pedido aberto), flow 1 → humanPauseMin. `session.ts` (PUT handoff sem handoffReason = LEGACY_FLOW) segue em humanPauseMin.

**Why:** o claim v1 é congelado; o fromMe sem pedido aberto usa o mesmo código para v1 e v2, então a separação é pelo `flow`, não pelo caminho. Coluna humanPauseMin mantida (sem migration).

**How to apply:** ao tocar pausa, lembrar que v1 ainda depende de humanPauseMin. Flake corrigido: `makeContact` em attendance.integration gerava waJid repetido (seq*13+random<1000); agora seq*1000.
