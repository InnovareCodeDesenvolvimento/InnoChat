---
name: bot-v2-l1-l2-armadilhas
description: Armadilhas medidas ao entregar L-1 (card Atendimento) e L-2 (sino handoff) do bot v2 — servidor dev paralelo, preview de componente, stub em arquivo compartilhado.
metadata:
  type: feedback
---

- **Dev com `NEXT_DIST_DIR` fora de `.next` quebra o Tailwind** (`globals.css` vira lixo binário): o Tailwind v4 varre o dir de build se ele não está no .gitignore. Correção local sem tocar o repo: `printf '/.next-lyra/\n' >> .git/info/exclude`.
- **Preview de componente**: rota solta em `src/app/x/` dá "Missing html/body" (vários root layouts). Colocar sob `src/app/(app)/[tenantSlug]/...` e apagar depois (e apagar `.next-*` para não sobrar tipo velho quebrando o tsc).
- **Stub em arquivo que a Vega está editando é frágil**: ela reescreveu `tenant/actions.ts` no meio e o stub sumiu sozinho. Conferir `grep LYRA-STUB` antes de dar por limpo; preferir stub em arquivo novo quando possível.
- `getBotRulesAction` é OWNER-only no backend, mas a spec diz "STAFF vê": STAFF cai no Alert de erro (pendência para Vega/Atlas).
- Trocar tema no Playwright: clicar `label:has(input[value=TEMA])` (o `check({force})` falha intermitente).
