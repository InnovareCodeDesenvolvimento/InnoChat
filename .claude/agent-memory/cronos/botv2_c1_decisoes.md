---
name: botv2-c1-decisoes
description: C-1 do bot v2 — migrations 20261001200000/200100, armadilha do enum desconhecido no código antigo, como a porta de textos foi escrita
metadata:
  type: project
---

- Migrations: `20261001200000_bot_v2_schema` (enums, tabela handoff_requests, CHECKs, índice único parcial, ADD VALUE IF NOT EXISTS x46) e `20261001200100_bot_v2_port_texts` (DO $$ idempotente, split por linha com ordinality; regex de opção aplicada em `line || E'\n'`).
- Armadilha: `botText.findMany()` sem filtro (bot-texts/service.ts) no código ANTIGO explode ao ler chave de enum que o client antigo não conhece. Linhas portadas (MENU_PROMPT/APPOINTMENT_DETAIL) quebram a tela/API de textos daquela empresa na janela do deploy e num rollback de imagem. DOWN.sql da porta apaga as chaves v2.
- `MAIN_MENU` sem nenhuma linha de opção: porta o texto inteiro (decisão minha; plano não cobria).
- Banco vazio testado criando DB temporário `innochat_empty_c1` via `CREATE DATABASE` com a mesma conexão.
