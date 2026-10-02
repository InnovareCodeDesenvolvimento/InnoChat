---
name: waitlist-design
description: Lista de espera / encaixe (melhoria 7): decisões não óbvias (claim override, hook sem ciclo, tick), armadilhas de teste e pendências
metadata:
  type: project
---

Entregue em 2026-10-02 (sem commit; Atlas commita). Módulo `src/modules/waitlist/` (service, offer, respond, hook, claim-support, actions), puro em `src/core/waitlist/match.ts`.

**Decisões que o código não mostra:**
- A resposta SIM/NÃO NÃO depende de gravar a sessão no envio da oferta. O `claim` v2 (flow 2, não HUMAN) acha a oferta com `offeredAt > session.lastInboundAt` e entrega `WAITLIST_OFFER` + contexto montado (opções ACCEPT/DECLINE, `lastTextKey` para o "Repetir passo"). Depois da 1ª resposta a sessão segue normal (não prende o cliente). "sim"/"não" puros também pegam oferta vencida há menos de 6 h (senão vira "Não entendi").
- `appointments.ts` importa só `waitlist/hook.ts` (leve); o motor entra por `import()` dinâmico. Importar `offer.ts` direto cria ciclo (offer -> outbound -> reminders/tick -> claim -> booking-bot -> appointments).
- `claim-support.ts` não pode importar nada que envie mensagem (o claim o importa; offer importa o claim).
- Compatível = horário que TOCA o intervalo liberado (não só começa nele): serviço de 60 min às 9:30 pode ocupar o espaço de um cancelado das 10:00. Ofertas abertas de outros seguram o horário (viram `busy` no cálculo).
- SLOT_TAKEN no aceite devolve a pessoa para WAITING sem perder a posição; LIMIT_REACHED cancela e passa ao próximo.
- Prazo da oferta é constante (`WAITLIST_OFFER_MINUTES = 30`); empresa ainda não tem coluna.

**Armadilhas de teste:**
- `innochat_test` é compartilhado: um `runBillingTick(now futuro)` de outro processo roda `runWaitlistTick(now)` e expira ofertas recém-criadas (viu-se 1 falha espúria). Rodar de novo.
- `bot-api-v2-agenda` API-03 falha perto da meia-noite UTC (flake de horário, não é da lista de espera).
- Simulador: scenarios-v2-waitlist.mjs (WL-01..06) roda no tenant `grade`; o painel envia a oferta pela Evolution FALSA (porta BOTSIM_EVOLUTION_PORT). Suite v2 inteira (65) fica verde.

**Pendências:** gatilho de 5 min no `innochat-cron` chamando `POST /waitlist/tick` (hoje só o tick horário de cobrança roda a varredura); prazo configurável por empresa (coluna); probe do runner n8n real e "Publicar fluxo" (sem MCP do n8n nesta sessão, probe preparado em scratchpad `vega-wl-probe.sdk.js`).
