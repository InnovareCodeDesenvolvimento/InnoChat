---
name: attendance-panel-and-staff-notify
description: Atendimento humano pelo painel (src/modules/attendance) + aviso ao cliente nas mudanças da equipe (agenda/staff-notify) — decisões e armadilhas
metadata:
  type: project
---

- Envio ao cliente fora do bot passa por UM helper: `attendance/outbound.ts#sendTextToContact` (eco antes, envio, ChatMessage, nunca lança; devolve SENT/NO_PHONE/NO_WHATSAPP/BUSY/FAILED). Reusa `registerOutboundEcho` e `recipientNumber` exportados de `reminders/tick.ts`.
- `endReason` ao encerrar pelo painel = `PANEL_RESUME` (nenhum outro valor do enum serve; sem migration).
- Aviso da equipe fica nas ACTIONS do painel, não em `appointments.ts` (o bot e a API interna usam as mesmas funções e não devem avisar).
- `cancelAppointmentDetailed` (updateMany condicional) dá `changed` confiável; cancelar duas vezes não reavisa.
- IN_PROGRESS da fila = handoff respondido OU `ChatSession.humanUntil > now`; NÃO usar `Contact.botPausedUntil` sozinho (o "pausar bot" de Clientes pode ser indefinido).
- `updateBotRules` aceita `notifyClientOnStaffChanges` opcional (omitido = não altera) para não quebrar UI antiga.
- Teste que compara `getBotRules` com `toEqual` quebra quando entra campo novo no BotRules (bot-texts-v2.integration).
- `node_modules` pode ser reinstalado por outro agente no meio da tarefa (`next` some do .bin): esperar `.bin` reaparecer.
