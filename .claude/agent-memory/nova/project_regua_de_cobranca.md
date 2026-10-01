---
name: project-regua-de-cobranca
description: Plano da régua de cobrança (2026-10-01) — outbox BillingNotice, BillingEvent, WhatsApp da plataforma fora de WhatsappInstance, trava anti-loop no claim
metadata:
  type: project
---

Fonte: `docs/regua-de-cobranca.md` (auditoria R1-R16, régua §2.2, contratos §3, fases F0-F8, decisões D1-D10).
Status em 2026-10-01: plano entregue, D1 decidido pelo dono; D2-D10 pendentes.

Decisões de desenho não óbvias (e o porquê):
- **Achado central:** o tick marca `*SentAt` mesmo quando `sendMail` devolve `{sent:false}` (tick.ts ~350);
  aviso perdido em silêncio. Por isso F0 (hotfix sem migration) vem antes de tudo.
- **Outbox no Postgres** (`BillingNotice`, unique `(cycleKey, step, channel)`, claim com SKIP LOCKED),
  planejador puro em `src/core/billing/dunning.ts`. Sem Redis: escala de dezenas/centenas de tenants.
- `step/channel/status` como String, não enum: `ALTER TYPE ADD VALUE` não roda na mesma transação.
- **Número da plataforma NÃO é WhatsappInstance:** tenantId obrigatório e `syncN8n` reaponta todo
  webhook de instância para o bot do n8n. DONO DECIDIU (2026-10-01): não é o comercial 84 3113-2584
  (fica só no site); o número de cobrança é conectado/TROCADO pelo Admin sem deploy. Por isso virou
  tabela `PlatformWhatsappConnection` (PENDING/ACTIVE/RETIRED, índice único parcial de 1 ACTIVE e 1
  PENDING, troca atômica sem janela sem canal), e `BillingNotice` guarda `platformConnectionId` +
  `senderPhoneE164`. Idempotência não depende do número. Sem número: NO_PLATFORM_NUMBER, régua segue
  por e-mail/sino, alerta PLATFORM_WHATSAPP_MISSING no sino do Admin.
- **Loop:** dono que usa o próprio celular como bot recebe o aviso, o bot responde, a plataforma responde
  de volta. Três travas: claim ignora `PLATFORM_SENDER`, auto-resposta 1x/24h, nunca auto-responder a
  número de WhatsappInstance.
- Recomendei carência 3 dias pagante / 1 teste, vencimento
  normalizado para 23:59 local (só adiando), monitor externo em `/api/health/billing` (não a /api/health
  do container, que derrubaria o painel).

**Why:** dono pediu cobrança "robusta, profissional e 100% funcional"; Pix pontual sem débito automático
faz a inadimplência depender da régua.
**How to apply:** ao retomar, conferir em PROGRESSO.md quais D1-D10 o dono decidiu antes de delegar F1+.
Relacionados: [[project-arquitetura-v1]], [[project-evolution-baileys-limites]]
