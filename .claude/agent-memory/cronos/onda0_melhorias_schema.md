---
name: onda0-melhorias-schema
description: Onda 0 (migrations 20261010100000..700, 8 itens do plano de melhorias 2026-10) - decisoes, armadilha do CHECK com NULL e como refazer migration so local
metadata:
  type: project
---

- 8 migrations (uma por item) + DOWN.sql. Conjuntos fechados = String + CHECK (padrao da regua), nao enum.
- ARMADILHA: `CHECK (a = 'X' AND col >= 1)` PASSA quando col e NULL (NULL nao reprova CHECK). Escrever `col IS NOT NULL AND ...`. Pegou no cupom N_CYCLES; so o teste de integracao revelou.
- Refazer migration ainda nao publicada: rodar o DOWN.sql, `DELETE FROM _prisma_migrations WHERE migration_name=...`, `migrate deploy` de novo (dev e test). Script precisa estar DENTRO do repo para resolver @prisma/client.
- `prisma format` realinha o schema inteiro (160 linhas de ruido): evitar; se rodar, `git diff -w` + `git apply --ignore-whitespace` recupera o diff limpo.
- Decisoes: AuditLog sem FK em actorUserId/targetId (SetNull = UPDATE = barrado pelo trigger); Plan.annualPriceCents (preco explicito) em vez de %; Invoice.amountCents segue LIQUIDO, discountCents e o abatido; WaitlistEntry unico parcial 1 ativa por contato+servico+dia+prof e 1 oferta aberta por horario+prof; recovery codes em tabela (consumo atomico); BackupConfig singleton id=1 com CHECK.
- Em TENANT_SCOPED_MODELS entrou so WaitlistEntry. AuditLog e CouponRedemption tem tenantId mas ficam fora (leitura cross-tenant).
- Sem snapshot de preco/comissao no Appointment: relatorios usam preco atual do Service (risco de historico mudar). Registrado como pendencia ao Atlas.
- Flake conhecido: bot-api-v2-agenda API-03 "rotulo relativo ao dia" depende da hora do dia.
