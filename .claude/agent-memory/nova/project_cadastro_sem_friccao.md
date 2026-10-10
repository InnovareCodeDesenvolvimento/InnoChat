---
name: project-cadastro-sem-friccao
description: Plano 2026-10-10 do cadastro enxuto (docs/plano-cadastro-sem-friccao.md) — CPF/ciclo/cupom saem do cadastro, Google bloqueado no WebView do Instagram, fatura do teste nasce no cadastro
metadata:
  type: project
---

Campanha Meta 2026-10: 52 cliques, 0 cadastros. Plano em `docs/plano-cadastro-sem-friccao.md` (D1-D7 pendentes).

Fatos não óbvios que sustentam o plano:
- A **fatura do teste nasce NO cadastro** (`createAccount`, `isTrialConversion`), com ciclo e cupom
  daquele momento. `changeBillingCycle`/`applyCouponToSubscription` só valem "da próxima fatura" —
  tirar ciclo/cupom do cadastro exige reprecificar a fatura do teste (F2: anular+recriar, nunca editar
  no lugar, senão Pix mensal velho baixa fatura anual e dá 12 meses).
- O caminho "empresa sem CPF/CNPJ" já existe ponta a ponta (Tenant.document nullable, tryAttachPix
  devolve null, e-mail sem Pix, alerta na Assinatura). Não precisa migration.
- Google OAuth dá `disallowed_useragent` no navegador embutido do Instagram: público do anúncio.
- `Lead` do Pixel só conta quem aceitou cookies; número de "começaram" é piso.
- Login nunca exigiu e-mail verificado; só a conexão do WhatsApp exige. Provedor `verified-login`
  (prova de 60 s) permite abrir sessão logo após o cadastro.
- Slug é usado no nome da instância Evolution: não prometer slug editável.

**Why:** dono quer fricção mínima com cadastros válidos sem quebrar cobrança/Pix/cupons/termos/Meta.
**How to apply:** ao retomar, conferir em PROGRESSO.md quais D1-D7 o dono decidiu; F1 pode publicar sem F2.
Relacionados: [[project-regua-de-cobranca]], [[project-arquitetura-v1]]
