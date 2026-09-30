---
name: atendimento-humano-schema
description: Migration 20261002100000 (Atendimento humano) - campos novos, chaves de texto, decisão de não indexar authorUserId, onde espelhar chave nova
metadata:
  type: project
---

- Migration `20261002100000_atendimento_humano`: `tenants.notifyClientOnStaffChanges` (default true), `chat_messages.authorUserId` (FK users, SET NULL), 4 valores de `BotTextKey` (STAFF_BOOKED/RESCHEDULED/CANCELED, HANDOFF_CLOSED). Aditiva, sem índice novo.
- Sem índice em `authorUserId`: a fila do Atendimento é por `(tenantId, contactId, createdAt)`, já existente; o índice só serviria ao SetNull de delete de User (raro). Reavaliar se surgir filtro "mensagens do atendente X".
- Chave nova de texto v2 = enum + `KEPT/NEW_V2_KEYS`, `DEFAULT_BOT_TEXTS_V2`, `BOT_TEXT_ALLOWED_VARS` (set), `BOT_TEXT_CATALOG`, bloco em spec §5.3, e contagens (79 chaves / 50 novas) em `texts-v2.test.ts`. `KEY_DESCRIPTION` não existe mais: `catalog.ts` deriva de `BOT_TEXT_CATALOG`.
- Edição via `node -e` no Windows: `\\n` em template literal virou quebra real; conferir com `cat -A`. Outro agente pode editar `src/core/bot/engine/*` em paralelo (suíte pode falhar momentaneamente por arquivo meio escrito).
