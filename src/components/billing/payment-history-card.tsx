import { formatInTimeZone } from "date-fns-tz";
import { Receipt } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cycleTitle, type BillingCycle } from "@/core/billing";

export type PaymentHistoryItem = {
  id: string;
  amountCents: number;
  periodStart: string;
  periodEnd: string;
  status: "PAID" | "OPEN";
  paidAt: string | null;
  /** Ciclo da fatura (1, 3, 6 ou 12 meses) e desconto de cupom já abatido (opcionais: telas antigas seguem valendo). */
  cycle?: BillingCycle;
  discountCents?: number;
  couponCode?: string | null;
};

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/**
 * "Histórico de pagamentos" da tela Assinatura (docs/regua-de-cobranca.md §3.3): as faturas pagas e
 * a que está em aberto, da mais recente para a mais antiga. Só leitura, funciona para OWNER e STAFF.
 */
export function PaymentHistoryCard({ items, timezone }: { items: PaymentHistoryItem[]; timezone: string }) {
  return (
    <Card className="rounded-hero" data-testid="payment-history-card">
      <CardHeader help="assinatura.historico">
        <CardTitle>Histórico de pagamentos</CardTitle>
        <CardDescription>As faturas da empresa, da mais recente para a mais antiga.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <p className="flex items-center gap-2 p-5 text-sm text-text-secondary">
            <Receipt className="h-4 w-4 shrink-0" aria-hidden="true" />
            Nenhum pagamento por aqui ainda. Quando a primeira fatura for paga, ela aparece nesta lista.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-5 py-3 text-sm">
                <span className="min-w-0 tabular-nums text-text">
                  {formatInTimeZone(new Date(item.periodStart), timezone, "dd/MM/yyyy")} a{" "}
                  {formatInTimeZone(new Date(item.periodEnd), timezone, "dd/MM/yyyy")}
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-medium tabular-nums text-text">{BRL.format(item.amountCents / 100)}</span>
                  {item.cycle && item.cycle !== "MONTHLY" ? <Badge variant="neutral">{cycleTitle(item.cycle)}</Badge> : null}
                  {item.discountCents && item.discountCents > 0 ? (
                    <span className="text-xs text-text-secondary">cupom {item.couponCode ?? ""}: {BRL.format(item.discountCents / 100)} de desconto</span>
                  ) : null}
                  {item.status === "PAID" && item.paidAt ? (
                    <Badge variant="success">Paga em {formatInTimeZone(new Date(item.paidAt), timezone, "dd/MM/yyyy")}</Badge>
                  ) : (
                    <Badge variant="warning">Em aberto</Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
