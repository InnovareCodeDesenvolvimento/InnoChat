---
name: landing-melhorias-3d-jornada-rede
description: Armadilhas da rede canvas, painel 3D (view timeline), jornada sticky e botao flutuante da landing
metadata:
  type: project
---

- `animation-timeline: view()` prende ao ANCESTRAL de rolagem mais proximo: `overflow:hidden` (ex. `.landing-dark`) cria um e a animacao nao anda (progress travado). Usar `overflow: clip`. O mesmo vale para `position: sticky` (jornada usa `overflow-clip`).
- Teste de fallback do tilt: `CSS.supports` falso nao basta, o `@supports` do CSS continua valendo; neutralizar com `animation:none !important` no teste.
- Jornada sticky: passo ativo por IntersectionObserver em blocos-sentinela (faixa -45%/-45%), nao por conta de rolagem. Ultimo bloco com 100svh para o palco so desgrudar depois do passo 5. No passo 1 o palco ainda nao grudou (medir "parado" a partir do passo 2).
- Mensagens do celular da jornada: so as 3 ultimas novas animam (stagger em 11 mensagens deixava o chat vazio por 2 s).
- Botao flutuante evita CTA/rodape por rAF + intervalo (`AVOID_SELECTOR`); cobre texto corrido em mobile (inerente a FAB), nunca CTA.
- Statuses reais da agenda: SCHEDULED/CANCELED/COMPLETED/NO_SHOW. Nao existe "chegou" (check-in): usar "Atendido".
- Dev DB pode nao ter a migration da Vega: `getPublicSalesWhatsapp` devolve null (botao some); E2E do botao faz skip nesse caso.
- Scratchpad compartilhado tem arquivos antigos: usar nomes unicos (`lyra-*`) ou Write falha por "nao lido".
- Lighthouse mobile (npx lighthouse, build prod, 3 rodadas): antes perf 78-81, LCP ~4.0-4.06 s, TBT 211-299 ms, CLS 0; depois perf 77-80, LCP 4.01-4.15 s, TBT 188-308 ms, CLS 0.
