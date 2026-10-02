import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import { pctToNumber } from "@/core/reports/commission";

/**
 * Cadastro de comissão (Melhoria 8). Só o dono lê e grava (o guard fica nas actions). O % do profissional é o
 * padrão; o % de um serviço dele vale só para aquele serviço (0 é válido). Nulo = "usa o padrão".
 * As colunas ficam fora das leituras comuns (`omit` em src/lib/db/prisma.ts): aqui se lê SEMPRE com `select`.
 */

export type ServiceCommissionOverride = { serviceId: string; pct: number | null };
export type ProfessionalCommission = { professionalId: string; pct: number | null; overrides: ServiceCommissionOverride[] };

export async function getCommissionConfig(tenantId: string, professionalId?: string): Promise<ProfessionalCommission[]> {
  const rows = await forTenant(tenantId).professional.findMany({
    where: professionalId ? { id: professionalId } : undefined,
    select: {
      id: true,
      commissionPct: true,
      professionalServices: { select: { serviceId: true, commissionPct: true } },
    },
  });
  return rows.map((p) => ({
    professionalId: p.id,
    pct: pctToNumber(p.commissionPct),
    overrides: p.professionalServices.map((ps) => ({ serviceId: ps.serviceId, pct: pctToNumber(ps.commissionPct) })),
  }));
}

export type SetCommissionInput = { pct: number | null; overrides: ServiceCommissionOverride[] };

function assertPct(pct: number | null) {
  if (pct === null) return;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new DomainError("INVALID_COMMISSION", "A comissão precisa ficar entre 0% e 100%.");
  }
}

/**
 * Grava o % do profissional e o de cada serviço dele numa transação só. Isolamento: o profissional é provado do
 * tenant via `forTenant()` (ProfessionalService não tem `tenantId` próprio) e só se grava em serviço que ele
 * realmente atende; id de outra empresa ou de serviço não vinculado é recusado, nunca ignorado em silêncio.
 */
export async function setProfessionalCommission(tenantId: string, professionalId: string, input: SetCommissionInput) {
  assertPct(input.pct);
  input.overrides.forEach((o) => assertPct(o.pct));

  const db = forTenant(tenantId);
  const professional = await db.professional.findFirst({ where: { id: professionalId }, select: { id: true } });
  if (!professional) throw new DomainError("NOT_FOUND", "Profissional não encontrado.");

  const ids = Array.from(new Set(input.overrides.map((o) => o.serviceId)));
  if (ids.length !== input.overrides.length) {
    throw new DomainError("INVALID_COMMISSION", "Serviço repetido na lista de comissões.");
  }
  const prisma = getPrisma();
  if (ids.length > 0) {
    const linked = await prisma.professionalService.count({ where: { professionalId, serviceId: { in: ids } } });
    if (linked !== ids.length) {
      throw new DomainError("INVALID_SERVICE_IDS", "Um ou mais serviços não são atendidos por este profissional.");
    }
  }

  await prisma.$transaction([
    prisma.professional.updateMany({ where: { id: professionalId, tenantId }, data: { commissionPct: input.pct } }),
    ...input.overrides.map((o) =>
      prisma.professionalService.updateMany({ where: { professionalId, serviceId: o.serviceId }, data: { commissionPct: o.pct } }),
    ),
  ]);

  const [config] = await getCommissionConfig(tenantId, professionalId);
  return config;
}
