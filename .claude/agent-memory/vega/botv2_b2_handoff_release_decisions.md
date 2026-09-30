---
name: botv2-b2-handoff-release-decisions
description: B-2 do bot v2 (claim v2, HandoffRequest, release com TECH_ERROR, sino): decisões não óbvias e armadilhas
metadata:
  type: project
---

Entregue em 2026-09-30 (sem commit; Atlas commita). Decisões que o código não mostra:

- `ensureOpenHandoff` usa `createMany({skipDuplicates})` + releitura, NÃO `create` + catch P2002: P2002 aborta a transação inteira do chamador (ver [[prisma-transaction-aborts-after-p2002]]) e a sessão já atualizada junto seria perdida.
- Release: liberar a trava e gravar o hash de eco (`recentOutbound`) é UMA `updateMany` condicionada ao `lockToken`; `count===0` = outra chamada venceu e cuida do aviso. Isso dá "1 aviso" sem lock extra. Janela de 10 min vem de `ChatMessage` OUTBOUND com o corpo do TECH_ERROR (recentOutbound só guarda 2 min).
- Furo residual assumido: se um 2º release ocorrer <~1 s depois do 1º (cliente reenvia e a execução morre de novo antes de o ChatMessage ser gravado), pode duplicar. Aceito.
- Regra 3 do claim (fromMe com pedido aberto) roda antes de HUMAN_MODE; eco do próprio bot com pedido aberto cai em HUMAN_MODE (não estende).
- `TIMEOUT` encerra pedido de qualquer reason (inclui LEGACY_FLOW) mas `CLIENT_MENU` só CLIENT_REQUEST.
- Quem volta do humano (CLIENT_MENU/TIMEOUT) vai com `session.expired=false` e `previous=null`.
- Sino: HandoffRequest via forTenant, inclui encerrados (UI esmaece); contador de não lidas conta todos os não lidos.
- Tela de escopo: `docs/api-interna.openapi.json` deve ser regenerada (`npm run generate:openapi`, não `node`) DEPOIS do commit da B-1, senão vem o schemas.ts não commitado dela.
