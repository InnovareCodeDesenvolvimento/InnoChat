/**
 * Junta as linhas (profissional x serviço) que o banco já somou em totais, por serviço e por profissional.
 * Pura: não conhece Prisma nem fuso. A soma pesada é do banco (src/lib/db/reports-sql.ts); aqui só se
 * agrupa um número pequeno de linhas (no máximo profissionais x serviços da empresa).
 */

export type ReportGroupRow = {
  professionalId: string;
  professionalName: string;
  serviceId: string;
  serviceName: string;
  completed: number;
  noShow: number;
  revenueCents: number;
  commissionCents: number;
  /** Concluídos sem foto de valores (antes da Melhoria 8): preço e comissão atuais, ou seja, estimados. */
  estimatedCount: number;
  /** Concluídos cujo serviço não tem preço cadastrado (contam 0 no faturamento). */
  withoutPriceCount: number;
};

export type ReportLine = {
  id: string;
  name: string;
  completed: number;
  noShow: number;
  revenueCents: number;
  commissionCents: number;
  ticketCents: number;
  /** Faltas sobre (concluídos + faltas), em %, com 1 casa. 0 quando não houve nenhum dos dois. */
  noShowRatePercent: number;
};

export type ReportSummary = {
  completed: number;
  noShow: number;
  revenueCents: number;
  commissionCents: number;
  ticketCents: number;
  noShowRatePercent: number;
  estimatedCount: number;
  withoutPriceCount: number;
};

export type ReportResult = {
  summary: ReportSummary;
  byService: ReportLine[];
  byProfessional: ReportLine[];
};

export function noShowRate(completed: number, noShow: number): number {
  const total = completed + noShow;
  if (total === 0) return 0;
  return Math.round((noShow / total) * 1000) / 10;
}

export function ticketOf(revenueCents: number, completed: number): number {
  return completed === 0 ? 0 : Math.round(revenueCents / completed);
}

type Acc = { name: string; completed: number; noShow: number; revenueCents: number; commissionCents: number };

function groupBy(rows: ReportGroupRow[], key: "service" | "professional"): ReportLine[] {
  const map = new Map<string, Acc>();
  for (const r of rows) {
    const id = key === "service" ? r.serviceId : r.professionalId;
    const name = key === "service" ? r.serviceName : r.professionalName;
    const acc = map.get(id) ?? { name, completed: 0, noShow: 0, revenueCents: 0, commissionCents: 0 };
    acc.completed += r.completed;
    acc.noShow += r.noShow;
    acc.revenueCents += r.revenueCents;
    acc.commissionCents += r.commissionCents;
    map.set(id, acc);
  }
  return [...map.entries()]
    .map(([id, acc]): ReportLine => ({
      id,
      name: acc.name,
      completed: acc.completed,
      noShow: acc.noShow,
      revenueCents: acc.revenueCents,
      commissionCents: acc.commissionCents,
      ticketCents: ticketOf(acc.revenueCents, acc.completed),
      noShowRatePercent: noShowRate(acc.completed, acc.noShow),
    }))
    .sort((a, b) => b.revenueCents - a.revenueCents || b.completed - a.completed || a.name.localeCompare(b.name, "pt-BR"));
}

export function aggregateReport(rows: ReportGroupRow[]): ReportResult {
  let completed = 0;
  let noShow = 0;
  let revenueCents = 0;
  let commissionCents = 0;
  let estimatedCount = 0;
  let withoutPriceCount = 0;
  for (const r of rows) {
    completed += r.completed;
    noShow += r.noShow;
    revenueCents += r.revenueCents;
    commissionCents += r.commissionCents;
    estimatedCount += r.estimatedCount;
    withoutPriceCount += r.withoutPriceCount;
  }
  return {
    summary: {
      completed,
      noShow,
      revenueCents,
      commissionCents,
      ticketCents: ticketOf(revenueCents, completed),
      noShowRatePercent: noShowRate(completed, noShow),
      estimatedCount,
      withoutPriceCount,
    },
    byService: groupBy(rows, "service"),
    byProfessional: groupBy(rows, "professional"),
  };
}
