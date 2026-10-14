"use client";

import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { ShieldCheck, UserCheck, Clock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Pagination } from "@/components/ui/pagination";
import type { SupportSessionItem } from "@/modules/billing/support-actions-types";

export type SupportAccessCardProps = {
  items: SupportSessionItem[];
  timezone?: string;
  className?: string;
};

const STATUS_CONFIG: Record<
  SupportSessionItem["status"],
  { label: string; variant: "success" | "warning" | "neutral" }
> = {
  ACTIVE: { label: "Em andamento", variant: "success" },
  EXPIRED: { label: "Expirada", variant: "warning" },
  CLOSED: { label: "Encerrada", variant: "neutral" },
};

/**
 * Card "Acessos do Suporte" (transparência LGPD) na tela de Assinatura.
 * Exibe histórico de sessões com paginação 10/25/50/100, detalhes de data, admin,
 * motivo resumido e status da sessão, com ajuda contextual.
 */
export function SupportAccessCard({ items, timezone = "America/Sao_Paulo", className }: SupportAccessCardProps) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const effectivePage = Math.min(page, totalPages);
  const pagedItems = items.slice((effectivePage - 1) * pageSize, effectivePage * pageSize);

  function handlePageSizeChange(newSize: number) {
    setPageSize(newSize);
    setPage(1);
  }

  return (
    <Card className={className} data-testid="support-access-card">
      <CardHeader help="suporte.acessosHistorico">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
              Acessos do Suporte
            </CardTitle>
            <CardDescription>
              Histórico de acessos e manutenções da equipe da plataforma nesta empresa.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {totalItems === 0 ? (
          <div className="flex items-center gap-2 p-5 text-sm text-text-secondary">
            <UserCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
            Nenhum acesso de suporte registrado para esta empresa até o momento.
          </div>
        ) : (
          <div className="flex flex-col">
            <ul className="divide-y divide-border">
              {pagedItems.map((item) => {
                const cfg = STATUS_CONFIG[item.status] ?? { label: item.status, variant: "neutral" as const };
                return (
                  <li
                    key={item.id}
                    className="flex flex-col gap-2 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
                    data-testid={`support-session-${item.id}`}
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-text">{item.adminName}</span>
                        <span className="text-xs text-text-secondary">({item.adminEmail})</span>
                        <Badge variant={cfg.variant}>{cfg.label}</Badge>
                      </div>
                      <p className="text-xs text-text-secondary line-clamp-2">
                        <span className="font-semibold text-text">Motivo:</span> {item.reason}
                      </p>
                    </div>

                    <div className="shrink-0 text-left sm:text-right space-y-0.5">
                      <div className="flex items-center gap-1.5 text-xs text-text-secondary sm:justify-end">
                        <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>
                          Início: {formatInTimeZone(new Date(item.startedAt), timezone, "dd/MM/yyyy HH:mm")}
                        </span>
                      </div>
                      {item.closedAt ? (
                        <div className="text-xs text-text-secondary">
                          Término: {formatInTimeZone(new Date(item.closedAt), timezone, "dd/MM/yyyy HH:mm")}
                        </div>
                      ) : (
                        <div className="text-xs text-text-secondary">
                          Expira em: {formatInTimeZone(new Date(item.expiresAt), timezone, "dd/MM/yyyy HH:mm")}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>

            {totalItems > 10 ? (
              <div className="border-t border-border p-4">
                <Pagination
                  page={effectivePage}
                  pageSize={pageSize}
                  totalItems={totalItems}
                  totalPages={totalPages}
                  onPageChange={setPage}
                  onPageSizeChange={handlePageSizeChange}
                  label="Paginação dos acessos de suporte"
                />
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
