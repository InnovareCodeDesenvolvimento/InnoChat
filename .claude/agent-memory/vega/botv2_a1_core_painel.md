---
name: botv2-a1-core-painel
description: A-1 do bot v2 (format.ts, texts-v2.ts, grade ancorada, teamOpening) - decisões e armadilhas de ferramenta
metadata:
  type: project
---

- Grade ancorada (`computeAvailableSlots`): candidatos por relógio de parede (HH:mm local, `anchoredGrid`), deduplicados por instante (DST). `teamOpening.nextOpenAt` = próximo início ESTRITAMENTE após `now`, mesmo com `openNow` true.
- T1 do simulador só fica verde quando `booking-bot.ts` (B-1) trocar `formatDayLabel(dateISOToUtcNoon(iso))` por `formatDayLabelFromISO(iso, tz)`; a A-1 só entrega a função.
- Teste de snapshot de `DEFAULT_BOT_TEXTS_V2` lê o bloco da spec (`docs/bot-v2-especificacao.md`) com `new Function`; fatiar até `"\n}"` (não incluir o `;`).
- Ferramenta: heredoc `cat <<'EOF'` com muito texto/aspas quebrou no Bash tool ("unexpected EOF"); usar Write para arquivos grandes.
- Simulador paralelo: `BOTSIM_DB=innochat_botsim_vega`, `NEXT_DIST_DIR` e porta própria evitam colidir com a Íris (banco `innochat_botsim_vega` ficou criado).
