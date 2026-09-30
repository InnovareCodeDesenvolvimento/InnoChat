---
name: botv2-b1-agenda-api
description: B-1 do bot v2 — decisões da API de agenda/catálogo (limite sob trava, defaults por versão, horizonte, reason) e armadilhas
metadata:
  type: project
---

- Limite de agendamentos futuros: `createAppointmentManual` ganhou `contactName`/`futureLimit` em actorOptions. A trava é um `tx.contact.update` (lock de linha), não SELECT FOR UPDATE, porque raw SQL só vale em src/lib/db. Idempotência (chave/duplicado) retorna ANTES, então repetir não bate no limite.
- Defaults por versão resolvidos na ROTA (schema com `.optional()`): dias 6 (v2)/7 (v1); horários 7 (v2)/8 (v1)/3 com `near`. Sem header = v1 sem regressão.
- `lastBookableDate` = hoje + (maxHorizonDays-1), o mesmo corte de `computeAvailableDays` (exclusive). Reserva ainda aceita até now+N dias; a lista é conservadora.
- `reason` em /slots com `period` vazio num dia que tem vagas = "FULL" (decisão minha, spec ambígua).
- Prisma: `scheduleException.create` exige `type` ("BLOCK"|"HOLIDAY") em fixtures.
- `next build` reescreve tsconfig.json (include do NEXT_DIST_DIR); remover a linha própria depois. Build pode falhar por arquivo de outro agente sumindo no meio (preview-l4): repetir.
- Heredoc python grande com ''' dentro de bash quebra; use Write para arquivos grandes.
