---
name: ajuda-contextual-help-button
description: Sistema do ícone "i" de ajuda (HelpButton + catálogo help-content.ts), onde plugar e as armadilhas medidas
metadata:
  type: project
---

- `src/components/help/help-button.tsx` (diálogo Radix, folha de baixo no celular) + `help-content.ts` (HELP tipado por `HelpKey`). Plugar: `PageHeader help="pagina.x"`, `CardHeader help="..."`, `StatCard help`, `Field labelAction={<HelpButton/>}`. Só a CHAVE (string) cruza Server→Client.
- **Why:** dono não achou a chave do lembrete. **How to apply:** tela/card novo = entrada no catálogo + `help`; teste unit barra termos técnicos.
- Armadilha: aria-label "Como funciona: <título>" casa `getByLabel(/regex/)` dos E2E — título de ajuda nunca igual a rótulo de campo (por isso "Limite de horários por cliente").
- Armadilha: regex `[^\p{L}]` com flags `iu` casa letras; em template literal `\p` some — usar `String.raw`.
- Medido: botão inline com -my-2 em linha de 28px vaza 8px; Field com labelAction usa `items-center mb-2`; legend de fieldset aceita flex.
