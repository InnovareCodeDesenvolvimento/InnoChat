---
name: regua-orion-review-fixes
description: 6 IMPORTANTES da revisão do Órion à régua (2026-10-01) — marcador manualSuspendedAt, Pix duplicado, posse do contato, retenção, SENDING preso, LEGACY_SENT; armadilhas
metadata:
  type: project
---

- **Suspensão manual:** coluna `Subscription.manualSuspendedAt` é o marcador robusto (o evento MANUAL_SUSPEND casa por `currentPeriodEnd` exato e some se o ciclo muda). `effectiveStatus` devolve SUSPENDED enquanto ela existe (até `cancelsAt`); planejador sai cedo com `input.manualSuspension`. Limpa em `applyInvoicePayment` e `reactivateCompanyManually`. Suspensões manuais ANTERIORES ao evento não têm como ser identificadas (sem marca): o admin precisa suspender de novo. Todo `select` que alimenta `effectiveStatus` precisa incluir `manualSuspendedAt`, `firstPaidAt` e o fuso.
- **Pix:** `regeneratePixForInvoice` cancela o `mpPaymentId` anterior (só se ainda não expirou); `applyInvoicePayment(invoiceId, paidAt, paymentId?)` grava `paidByPaymentId` ("manual" na baixa do admin) e, se OUTRO pagamento chega numa fatura PAID, grava `duplicatePaymentAt` -> sino `PAYMENT_DUPLICATE` (`pdup:`). Também cancela Pix pendente diferente do que pagou. Estorno segue MANUAL (decisão do dono).
- **Posse do contato:** `Tenant.billingWhatsappConfirmedAt` (SIM ao número da plataforma, `isConfirmText`). Não confirmado: 1 WhatsApp/24h + rodapé SIM/SAIR; e-mail do financeiro: 1/24h, excedente cai no dono (sem confirmação por link, pendente). Janela com `gt`, NUNCA `gte`: o adiamento marca `sentAt+24h` e `gte` esperaria para sempre.
- **Retenção:** `purgeExpiredReplyEvents` (45 dias) na manutenção; chave do autoreply usa `hashPhoneForDedup`. Manutenção tem orçamento (90 s) e timeout de 15 s no `connectionState`.
- **Outbox:** claim de SENDING preso agora incrementa `attempts` e respeita `maxAttempts`; `failExhaustedStuckNotices` o torna FAILED. `markNoticeSentSafely` tem 3a tentativa mínima (só status+sentAt).
- **LEGACY_SENT/SUSPENDED:** migration de dados apaga só quando a assinatura hoje é PAST_DUE/ACTIVE no MESMO ciclo (cycleKey igual).
- **Armadilha de teste:** `vi.spyOn(prisma.model, "method")` + `mockRestore` quebra o delegate do Prisma (proxy) e derruba os testes seguintes com "is not a function"; troque a propriedade na mão e restaure no `finally`. `makeTenant` do `dunning.helpers.ts` agora cria número CONFIRMADO por padrão (`unconfirmedPhone: true` para o caso novo).
