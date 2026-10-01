---
name: cancelamento_review_2026-10-01
description: Revisão do commit d2e778d (cancelamento/reativação pelo painel) — sem CRÍTICO; padrões: Pix de fatura VOID segue pagável, status persistido vs efetivo, ações de leitura que mexem em recurso pago
metadata:
  type: project
---

Revisão d2e778d (2026-10-01): sem CRÍTICO. Controle de acesso (OWNER, slug, sem IDOR), XSS (React escapa; motivo não vai a e-mail/log) e e-mail (esc() em tudo) OK.

Padrões recorrentes a checar em mudanças de billing:
- Anular fatura localmente NÃO cancela o pagamento no Mercado Pago: Pix emitido segue pagável e cai em `voided_invoice_paid` (só `logger.warn`, sem aviso ao admin). Documentado como aceito em contratos.md, mas sem visibilidade.
- Código que decide por `subscription.status` PERSISTIDO (startReactivation, applyInvoicePayment `wasCanceled`) falha na janela entre o fim do período agendado e o tick horário; a UI usa o status EFETIVO. Sempre usar `effectiveStatus`.
- `SubscriptionSnapshot.cancelAtPeriodEnd` é opcional: select que esquece o campo falha ABERTO (ignora o agendamento).
- Server Actions de "leitura" que acionam recurso externo pago (`getQrCodeAction`, `refreshConnectionStatusAction`) não têm `assertTenantCanWrite`: tenant CANCELED consegue reconectar o WhatsApp (o tick re-desconecta de hora em hora).
- Rate limit de cancelar/reativar é em memória (mesma dívida de [[atendimento_humano_review_2026-09-30]]); desfazer não tem limite.

Ver [[tenant_isolation_pattern]].
