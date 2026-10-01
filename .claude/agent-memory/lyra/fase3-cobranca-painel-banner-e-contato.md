---
name: fase3-cobranca-painel-banner-e-contato
description: F3 da régua de cobrança no painel da empresa: banner com contador, pedido do WhatsApp, Contato de cobrança, armadilhas medidas (overflow do Pix, carência de 3 dias nos E2E, hidratação do contador).
metadata:
  type: project
---

Banner/contador, pedido do número e card de contato moram em `src/components/shell/{billing-banner-state,subscription-banner,billing-phone-prompt}` e `src/components/billing/`. Estado calculado no servidor (layout) por `resolveBillingBanner`, que usa `effectiveStatus` + `subscriptionBoundaries` do core: NUNCA recalcular carência/prazo na UI.

**Armadilhas (causa raiz):**
- Pix longo estourava a largura no celular: `flex-1` sem `min-w-0`/`w-full` dentro de `flex-col items-center`. Medir overflow horizontal em 390 com lista de culpados (`horizontalOverflow()` no spec).
- Contador: relógio parte do instante do servidor (`serverNowMs`) e assume o do navegador num `setTimeout(0)`, senão dá erro de hidratação; `router.refresh()` uma vez ao zerar.
- "Dispensar por sessão" com `useSyncExternalStore` (servidor = já dispensado) evita piscar e o lint `set-state-in-effect`.
- Vencimento de quem paga é 23:59 do dia local e a carência é 3 dias (F2): fixtures de E2E que "suspendem" com `currentPeriodEnd` 2 dias atrás agora dão PAST_DUE; usar 5 dias. Corrigido em suspensao.spec e whatsapp.spec.
- D-5 no banner é por dia do calendário: aparece quando faltam menos de 6 dias até 23:59 do dia D.
- Vários E2E logando seguidos estouram o rate limit de login em memória do servidor: reiniciar o `next start` próprio.
- `eslint` sem caminho varre `.next-*` de outros agentes (milhares de erros falsos): usar `eslint src tests`.

**How to apply:** próximos avisos de cobrança reutilizam `BannerShell`/`useSessionDismiss`; ícones de kind novos vão direto em `KIND_ICON` (exaustivo).
