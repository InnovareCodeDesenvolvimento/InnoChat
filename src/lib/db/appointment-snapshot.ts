import type { Prisma } from "@prisma/client";
import { commissionCentsFor, pctToNumber, resolveCommissionPct } from "@/core/reports/commission";

/**
 * Foto do preço e da comissão no instante em que o atendimento vira COMPLETED (Melhoria 8): o relatório
 * usa estes valores, então editar o preço do serviço ou a comissão depois não reescreve o histórico.
 * Roda DENTRO da transação do `updateMany` condicional: ou o status e a foto vão juntos, ou nada vai.
 * Serviço sem preço fotografa 0 (o relatório conta esses atendimentos à parte, em "sem preço").
 */
export async function recordCompletionSnapshot(tx: Pick<Prisma.TransactionClient, "appointment" | "professionalService">, tenantId: string, appointmentId: string) {
  const appt = await tx.appointment.findFirstOrThrow({
    where: { id: appointmentId, tenantId },
    select: {
      service: { select: { priceCents: true } },
      professional: {
        select: {
          commissionPct: true,
        },
      },
      professionalId: true,
      serviceId: true,
    },
  });
  const link = await tx.professionalService.findUnique({
    where: { professionalId_serviceId: { professionalId: appt.professionalId, serviceId: appt.serviceId } },
    select: { commissionPct: true },
  });
  const priceCents = appt.service.priceCents ?? 0;
  const pct = resolveCommissionPct(pctToNumber(link?.commissionPct), pctToNumber(appt.professional.commissionPct));
  await tx.appointment.updateMany({
    where: { id: appointmentId, tenantId },
    data: {
      priceCentsSnapshot: priceCents,
      commissionPctSnapshot: pct,
      commissionCentsSnapshot: commissionCentsFor(priceCents, pct),
    },
  });
}
