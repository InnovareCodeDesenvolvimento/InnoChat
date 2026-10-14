import { getPrisma } from "@/lib/db/prisma";
import { RESCUE_STATUS_CONFIG } from "./labels";
import type { RescueLeadStatus } from "./service";

function escapeCsv(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (text.includes(";") || text.includes("\"") || text.includes("\n") || text.includes("\r")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatDateBr(date: Date | null | undefined): string {
  if (!date) return "";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

export type BuildRescueCsvOptions = {
  status?: string;
  from?: string;
  to?: string;
  search?: string;
};

export async function buildRescueLeadsCsv(options?: BuildRescueCsvOptions): Promise<{ filename: string; csv: string; count: number }> {
  const prisma = getPrisma();
  const where: Record<string, unknown> = {};

  if (options?.status) {
    where.status = options.status;
  }

  if (options?.from || options?.to) {
    const createdAtFilter: { gte?: Date; lte?: Date } = {};
    if (options.from) createdAtFilter.gte = new Date(`${options.from}T00:00:00.000Z`);
    if (options.to) createdAtFilter.lte = new Date(`${options.to}T23:59:59.999Z`);
    where.createdAt = createdAtFilter;
  }

  if (options?.search) {
    const term = options.search;
    const digits = term.replace(/\D/g, "");
    where.OR = [
      { user: { name: { contains: term, mode: "insensitive" } } },
      { user: { email: { contains: term, mode: "insensitive" } } },
      { tenant: { name: { contains: term, mode: "insensitive" } } },
      ...(digits ? [{ phoneE164: { contains: digits } }] : []),
    ];
  }

  const leads = await prisma.rescueLead.findMany({
    where,
    include: {
      user: {
        select: {
          name: true,
          email: true,
        },
      },
      tenant: {
        select: {
          name: true,
          slug: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 5000, // limite de segurança para exportação
  });

  const headers = [
    "ID",
    "Nome",
    "Telefone",
    "E-mail",
    "Empresa",
    "Status",
    "Cadastrado em",
    "Passo 1 agendado",
    "Passo 1 enviado",
    "Passo 2 agendado",
    "Passo 2 enviado",
    "Respondido em",
    "Convertido em",
    "Opt-out em",
    "Próximo disparo",
    "Tentativas",
    "Último erro",
  ];

  const rows: string[] = [headers.map(escapeCsv).join(";")];

  for (const lead of leads) {
    const statusLabel = RESCUE_STATUS_CONFIG[lead.status as RescueLeadStatus]?.label ?? lead.status;
    const row = [
      lead.id,
      lead.user.name || "Sem nome",
      lead.phoneE164,
      lead.user.email,
      lead.tenant.name,
      statusLabel,
      formatDateBr(lead.createdAt),
      formatDateBr(lead.step1ScheduledAt),
      formatDateBr(lead.step1SentAt),
      formatDateBr(lead.step2ScheduledAt),
      formatDateBr(lead.step2SentAt),
      formatDateBr(lead.respondedAt),
      formatDateBr(lead.convertedAt),
      formatDateBr(lead.optedOutAt),
      formatDateBr(lead.nextRunAt),
      lead.attempts,
      lead.lastErrorCode || "",
    ];
    rows.push(row.map(escapeCsv).join(";"));
  }

  const nowStr = new Date().toISOString().slice(0, 10);
  const filename = `leads-resgate-${nowStr}.csv`;
  const csv = `﻿${rows.join("\r\n")}\r\n`;

  return {
    filename,
    csv,
    count: leads.length,
  };
}
