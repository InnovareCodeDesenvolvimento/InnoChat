import crypto from "node:crypto";
import { MercadoPagoApiError, type CreatePixPaymentInput, type MercadoPagoGateway, type MercadoPagoPayment } from "./mercadopago";

/**
 * Fake do Mercado Pago para testes (sem credenciais reais ainda — PENDÊNCIAS no handoff da
 * Fase 7). Implementa `MercadoPagoGateway` de verdade — os testes injetam isto no lugar do
 * gateway real (`createMercadoPagoGateway`) nas funções de serviço que aceitam `gateway?` como
 * parâmetro, e usam `approve()`/`setStatus()` para simular o webhook confirmando o pagamento.
 *
 * Reproduz a MESMA falha cedo do gateway real quando falta `payerDocument` (conferido contra o
 * incidente do Parque das Feiras, `payments.pix.cpf.test.ts`) — sem isto, um teste de
 * integração que esquecesse de semear `Tenant.document` passaria mesmo simulando um cenário que
 * o Mercado Pago de verdade recusaria.
 */
export function createMockMercadoPagoGateway() {
  let counter = 0;
  const payments = new Map<string, MercadoPagoPayment & { copyPaste: string }>();
  const cancelledPaymentIds: string[] = [];

  const gateway: MercadoPagoGateway = {
    async createPixPayment(input: CreatePixPaymentInput) {
      if (!input.payerDocument) {
        throw new MercadoPagoApiError("mock: falta o CPF/CNPJ do pagador.", undefined, "missing_payer_document");
      }
      counter += 1;
      const paymentId = `mock_pay_${crypto.randomUUID().slice(0, 8)}_${counter}`; // único entre mocks: ProviderEvent(provider, id) é global
      payments.set(paymentId, {
        id: paymentId,
        status: "pending",
        dateApproved: null,
        externalReference: input.externalReference,
        transactionAmountCents: input.amountCents,
        copyPaste: `00020126mock-pix-${paymentId}`,
      });
      return {
        paymentId,
        qrCode: `mock-qr-${paymentId}`,
        copyPaste: `00020126mock-pix-${paymentId}`,
        expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      };
    },

    async getPayment(paymentId: string) {
      const payment = payments.get(paymentId);
      if (!payment) throw new Error(`mock: pagamento ${paymentId} não existe`);
      return payment;
    },

    async cancelPayment(paymentId: string) {
      const payment = payments.get(paymentId);
      if (!payment) throw new MercadoPagoApiError(`mock: pagamento ${paymentId} não existe`, 404);
      // Igual ao MP: só pagamento pendente pode ser cancelado.
      if (payment.status !== "pending" && payment.status !== "in_process") {
        throw new MercadoPagoApiError(`mock: pagamento ${paymentId} está ${payment.status} e não pode ser cancelado`, 400, "payload_rejected");
      }
      payment.status = "cancelled";
      cancelledPaymentIds.push(paymentId);
    },
  };

  return {
    gateway,
    /** Ids dos pagamentos cancelados via `cancelPayment`, na ordem. */
    cancelledPaymentIds,
    /** Sobrescreve campos do pagamento (ex.: `externalReference: null`, `transactionAmountCents`) para testar divergências. */
    tamper(paymentId: string, patch: Partial<MercadoPagoPayment>) {
      const payment = payments.get(paymentId);
      if (!payment) throw new Error(`mock: pagamento ${paymentId} não existe`);
      Object.assign(payment, patch);
    },
    /** Força um status (rejected/cancelled/pending...) — o que `getPayment` reconsulta. */
    setStatus(paymentId: string, status: string) {
      const payment = payments.get(paymentId);
      if (!payment) throw new Error(`mock: pagamento ${paymentId} não existe`);
      payment.status = status;
    },
    /** Simula a aprovação do pagamento (o que o webhook reconsulta via `getPayment`). */
    approve(paymentId: string, approvedAt: Date = new Date()) {
      const payment = payments.get(paymentId);
      if (!payment) throw new Error(`mock: pagamento ${paymentId} não existe`);
      payment.status = "approved";
      payment.dateApproved = approvedAt;
    },
  };
}
