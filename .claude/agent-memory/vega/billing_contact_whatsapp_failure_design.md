---
name: billing-contact-whatsapp-failure-design
description: WhatsApp de cobrança errado (2026-10-03) - aviso derivado de BillingNotice, conferência ao salvar com "salvar mesmo assim", Admin corrige, hash não rola em página com streaming
metadata:
  type: project
---

- Causa raiz do "cliente não achou": o cartão Contato de cobrança já era editável em TRIALING; o problema era achar (fim da Assinatura, sem link em Configurações, sem aviso da falha). O dono confirmou que a troca funcionou.
- Aviso do painel SEM migration: `getBillingWhatsappProblem` (src/modules/billing/whatsapp-problem.ts) lê BillingNotice FAILED/WHATSAPP, `recipient` = número atual (trocar apaga), código `WHATSAPP_INVALID_NUMBER` ou genérico com 2+ tentativas, 30 dias, e nenhum SENT depois.
- Sender: 400 da Evolution (ou `exists:false`) com sessão aberta = `reason: "INVALID_NUMBER"`. A checagem de connectionState vem ANTES (o fake dos testes usa 400 para sessão fechada).
- Conferência ao salvar: `NO_WHATSAPP` recusa e a tela oferece "Salvar mesmo assim" (`skipWhatsappCheck`); UNKNOWN (Evolution fora, 4 s) salva. Recusa definitiva seria perigosa por falso negativo.
- Armadilha: `#hash` + Link não rola quando a página abre em streaming (o elemento ainda não existe); o cartão rola e foca sozinho num useEffect.
- Armadilha: testes de integração em `innochat_test` compartilhado falham por varredura global quando outro agente roda ao mesmo tempo; rerodar isolado.
- Admin: `updateBillingContactAsAdminAction`, auditoria `company.billing_contact_changed` com número mascarado (maskPhone).
