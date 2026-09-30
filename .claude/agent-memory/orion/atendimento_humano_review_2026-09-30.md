---
name: atendimento_humano_review_2026-09-30
description: Revisão do atendimento humano pelo painel (b452d0b..61128fd) — sem CRÍTICO; isolamento e papéis OK, achados de rate limit, envio duplicado e avisos sem teto
metadata:
  type: project
---

Sem CRÍTICO. Isolamento OK (forTenant + ChatSession por whatsappInstance.tenantId; contactId alheio = NOT_FOUND), bodies renderizados como texto React, logs sem corpo.
Padrões: (1) envio ao WhatsApp sem idempotência (duplo submit/retry após timeout duplica); (2) avisos automáticos ao cliente (staff-notify, HANDOFF_CLOSED) sem rate limit/teto por contato — risco de banimento do número; (3) rate limit em memória por usuário (não por tenant/contato); (4) send concorrente com close re-pausa o bot.
Ver [[tenant_isolation_pattern]].
