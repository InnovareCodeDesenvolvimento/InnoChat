---
name: tela-atendimento-fila-e-conversa
description: Tela /atendimento (fila + conversa + compositor): decisões de arquitetura, armadilhas medidas e como validei ao vivo sem Evolution.
metadata:
  type: project
---

- Código em `components/attendance/` (utils puros testados, fila, conversa, compositor, diálogo de encerrar) + `app/(app)/[tenantSlug]/atendimento/`. Cliente aberto vem da URL `?contato=<id>` (fonte única: sino, F5 e voltar funcionam); conversa montada com `key={contactId}` (reset sem efeito).
- Badge do menu: `NavItem.badge: "attendance"` (chave, nunca número/ícone Server→Client) lido de `useAttendanceWaitingCount()`; o hook do sino ganhou `attendanceWaitingCount` e faz 1 poll logo após a 1ª carga (senão o badge esperaria 30 s). A tela sincroniza o badge com `useSetAttendanceWaitingCount`.
- Ao vivo: a tela tem o próprio intervalo de 15 s (fila + `refreshTick` para a conversa); medido: msg nova e novo pedido aparecem em ~14-15 s sem F5. `pollBaseInterval` também dá 15 s em `/atendimento`.
- Envio otimista: bolha local `sending`/`failed`. Erros que devolvem o texto ao campo (sem bolha): CONTACT_HAS_NO_PHONE, TENANT_SUSPENDED, TEXT_*, CONVERSATION_BUSY, SEND_FAILED. WHATSAPP_NOT_CONNECTED/RATE_LIMITED/rede deixam a bolha com "Tentar de novo".
- **Armadilha medida:** ao aparecer o banner de erro do compositor, a conversa encolhe e a última bolha some atrás do compositor → `ResizeObserver` no `role=log` recolando no fim se a pessoa estava no fim.
- Foco automático no compositor só com ponteiro fino (`pointer: coarse` não abre teclado por cima da conversa).
- Sino: `notificationHref()` (notification-utils) redireciona HANDOFF_REQUESTED para `/atendimento?contato=` no cliente; o `href` do servidor ainda aponta para `/clientes?contato=`.
- Backend devolve `authorName = "Atendente"` quando o usuário não tem nome → rótulo acessível não pode repetir ("Atendente Atendente").
- `clientNotification` vem `DISABLED` também quando nada mudou (repetido/mesmo horário): o texto do toast cobre os dois casos.
- **Validação sem Evolution:** dev DB sem instância conectada → o envio real devolve WHATSAPP_NOT_CONNECTED (bom para o print de erro); sucesso de envio NÃO foi provado ao vivo. Seed com prefixo `LYRA-AT-` em `studio-demo` e limpeza por prefixo (apagar appointments antes dos contatos).
- Mobile 390: 3 botões do topo cabem em 1 linha com `max-md:px-2.5`, rótulo curto visível + `aria-label` completo (label-in-name ok).
