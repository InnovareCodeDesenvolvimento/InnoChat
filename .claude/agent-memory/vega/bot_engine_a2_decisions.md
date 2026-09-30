---
name: bot-engine-a2-decisions
description: Motor puro do bot v2 (src/core/bot/engine): decisões não óbvias, armadilhas de ambiente e furos do contrato
metadata:
  type: project
---

Motor A-2 entregue em 2026-09-30 (sem commit; Atlas commita). Decisões que não estão no código de forma óbvia:

- `routeFor`: saudação/menu em sessão fresh → FRESH mesmo com retomada (spec §2.4.1 regra 2); HUMAN/EXIT/HELP em fresh nunca são engolidos por RESUME; `name_invalid` devolve `STATE` (o ramo ASK_NAME escolhe NAME_INVALID/NAME_TOO_LONG pelo `reason`) e conta como inválido, 2ª seguida = INVALID_2.
- Regra 2 (fresh) é do `routeFor`: o chamador roda `interpret` com `state="MAIN_MENU"` e opções estáticas.
- `renderMessage` lança se a chave de texto não existe (o error workflow avisa o cliente) e move `footer` para o fim.
- `buildOptions` lança se >9 opções. Furo do contrato: página do meio com 8 itens + MORE + PREV = 10. Quem chamar precisa ajustar o tamanho da página (7) — sinalizado ao Atlas.
- `OptionV2` ganhou `label?` opcional (= title) preenchido por `buildOptions`.
- esbuild NÃO é devDependency declarada (vem transitivo por vitest/tsx, 0.28.2). W-1 deve declarar ao mexer no package.json.

**Armadilha de ambiente:** heredoc bash gigante com `'` em texto (ex. `D'Ávila`) dentro do Bash tool quebra o comando inteiro e não grava nada; usar Write para arquivos grandes.
**Why:** tempo perdido; **How to apply:** criar arquivos de teste pelo Write, não por `cat <<EOF`.
