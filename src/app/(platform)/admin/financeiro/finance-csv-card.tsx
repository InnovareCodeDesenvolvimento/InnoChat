"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

/** Mesmo teto do servidor (docs/regua-de-cobranca.md §3.1): 12 meses por arquivo. O servidor é quem decide; aqui só evita o clique em vão. */
function addYear(from: string): string {
  const [y, m, d] = from.split("-").map(Number);
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function validate(from: string, to: string): string | null {
  if (!from || !to) return "Escolha a data inicial e a final.";
  if (from > to) return "A data inicial precisa ser antes da final.";
  if (to > addYear(from)) return "O período pode ter no máximo 12 meses por arquivo.";
  return null;
}

export function FinanceCsvCard({ defaultFrom, defaultTo }: { defaultFrom: string; defaultTo: string }) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [status, setStatus] = useState("");
  const error = validate(from, to);
  const params = new URLSearchParams({ from, to });
  if (status) params.set("status", status);
  const href = `/api/admin/finance/invoices.csv?${params.toString()}`;

  return (
    <Card className="rounded-hero">
      <CardHeader help="admin.baixarFaturas">
        <CardTitle>Baixar faturas (CSV)</CardTitle>
        <CardDescription>Planilha com as faturas de um período, para conferir com o extrato ou mandar para a contabilidade.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[10rem_10rem_12rem_auto]">
          <Field label="Vencimento de">
            {(fieldProps) => <Input {...fieldProps} type="date" className="w-full" value={from} onChange={(e) => setFrom(e.target.value)} />}
          </Field>
          <Field label="Vencimento até">
            {(fieldProps) => <Input {...fieldProps} type="date" className="w-full" value={to} onChange={(e) => setTo(e.target.value)} />}
          </Field>
          <Field label="Situação das faturas">
            {(fieldProps) => (
              <Select {...fieldProps} value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Todas</option>
                <option value="PAID">Pagas</option>
                <option value="OPEN">Abertas</option>
                <option value="VOID">Anuladas</option>
              </Select>
            )}
          </Field>
          {error ? (
            <Button type="button" disabled className="w-full sm:col-span-2 lg:col-span-1 lg:w-auto" icon={Download}>
              Baixar faturas (CSV)
            </Button>
          ) : (
            <Button asChild className="w-full sm:col-span-2 lg:col-span-1 lg:w-auto">
              <a href={href} download>
                <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
                Baixar faturas (CSV)
              </a>
            </Button>
          )}
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        ) : (
          <p className="mt-3 text-xs text-text-secondary">O período pode ter até 12 meses. As datas filtram pelo vencimento da fatura.</p>
        )}
      </CardContent>
    </Card>
  );
}
