# Memória do Cronos — InnoChat

- [Migration sem TTY](migrate_diff_sem_tty.md) — como gerar/aplicar migration com `migrate diff` + `migrate deploy`, sem travar em prompt interativo.
- [Decisões da Fase 7 (cobrança)](fase7_cobranca_decisoes.md) — por que Subscription é 1:1 estrito, Invoice sem tenantId próprio, TrialClaim cross-tenant, Plan price=0/active=false.
- [Bot v2 C-1](botv2_c1_decisoes.md) — migrations do bot v2, porta de textos, risco de enum desconhecido no código antigo
- [Atendimento humano](atendimento_humano_schema.md) — migration 20261002100000, sem índice em authorUserId, checklist de chave nova (79 chaves)
- [Régua F1 schema](regua_f1_schema_decisoes.md) — BillingNotice/BillingEvent/PlatformWhatsappConnection, cycleKey, backfill LEGACY_SENT, telefone do dono não existe
- [Fase 2 schema](fase2_schema_decisoes.md) — índice do lembrete, dedup ChatMessage, onde espelhar nova BotTextKey
- [Onda 0 melhorias](onda0_melhorias_schema.md) — 8 migrations 20261010100000..700, CHECK com NULL passa, refazer migration local, decisoes de modelagem
