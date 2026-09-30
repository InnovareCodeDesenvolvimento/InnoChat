import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { RescheduleAppointmentRequestSchema } from "@/lib/api-internal/schemas";
import { rescheduleAppointmentBot, toAppointmentSummary } from "@/modules/bot-api/booking-bot";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";

/** `POST /api/internal/v1/appointments/{id}/reschedule` (docs/arquitetura.md §6.5). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const { id } = await params;
    const body = RescheduleAppointmentRequestSchema.parse(await req.json());
    const appointment = await rescheduleAppointmentBot(ctx, id, body.contactId, body.startsAt);
    const { summary } = await toAppointmentSummary(ctx.tenantId, appointment.id);
    return NextResponse.json({ appointmentId: appointment.id, startsAt: appointment.startsAt, summary }, { status: 200 });
  });
}
