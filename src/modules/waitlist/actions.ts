"use server";

import { z } from "zod";
import { WAITLIST_PERIODS } from "@/core/waitlist/match";
import { requireTenantMember } from "@/lib/auth/guards";
import { DomainError } from "@/lib/errors";
import { runAction, type Result } from "@/lib/result";
import { forTenant } from "@/lib/db/tenant-client";
import { formatDateTimeBr } from "@/modules/audit/describe";
import { memberActor, recordAudit } from "@/modules/audit/record";
import { assertTenantCanWrite } from "@/modules/billing/service";
import { createContact } from "@/modules/contacts/contacts";
import { offerEntryManually } from "./offer";
import { createWaitlistEntry, listWaitlist, removeWaitlistEntry } from "./service";

/**
 * Server Actions da tela "Lista de espera" do painel. Qualquer membro da equipe lista, adiciona,
 * remove e oferece encaixe; painel suspenso é somente leitura (`assertTenantCanWrite`).
 */

/**
 * "um cliente (Corte)" para os resumos do histórico. NÃO leva o nome do cliente (LGPD: o registro de auditoria não aceita
 * correção); o `targetId` é a entrada da fila e a tela do histórico resolve o nome pelo contato vivo.
 */
async function waitlistLabel(tenantId: string, entryId: string): Promise<string> {
  try {
    const row = await forTenant(tenantId).waitlistEntry.findFirst({ where: { id: entryId }, select: { service: { select: { name: true } } } });
    if (row) return `um cliente (${row.service?.name ?? "serviço"})`;
  } catch {
    // só o texto fica mais pobre
  }
  return "um cliente";
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const listSchema = z.object({
  date: isoDate.nullish(),
  professionalId: z.string().min(1).nullish(),
  status: z.enum(["active", "all", "WAITING", "OFFERED", "ACCEPTED", "EXPIRED", "CANCELED", "FULFILLED"]).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export async function listWaitlistAction(tenantSlug: string, input: unknown): Promise<Result<Awaited<ReturnType<typeof listWaitlist>>>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    const data = listSchema.parse(input ?? {});
    return listWaitlist(tenant.id, data);
  });
}

const addSchema = z
  .object({
    contactId: z.string().min(1).optional(),
    newContact: z.object({ name: z.string().trim().min(1).max(120), phone: z.string().trim().min(1).max(30) }).optional(),
    serviceId: z.string().min(1),
    professionalId: z.string().min(1).nullable().optional(),
    date: isoDate,
    period: z.enum(WAITLIST_PERIODS).default("ANY"),
    windowStartMin: z.number().int().min(0).max(1439).nullable().optional(),
    windowEndMin: z.number().int().min(1).max(1440).nullable().optional(),
  })
  .refine((v) => !!v.contactId !== !!v.newContact, { message: "Escolha um cliente ou informe nome e telefone de um novo." });

export async function addWaitlistEntryAction(tenantSlug: string, input: unknown): Promise<Result<{ id: string; alreadyExisted: boolean }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const data = addSchema.parse(input);

    let contactId = data.contactId;
    if (!contactId && data.newContact) {
      try {
        contactId = (await createContact(tenant.id, data.newContact)).id;
      } catch (error) {
        // Mesmo telefone já cadastrado: usa o cliente que já existe, sem duplicar.
        const existing = error instanceof DomainError && error.code === "CONTACT_EXISTS" ? (error.details as { contactId?: string } | undefined)?.contactId : undefined;
        if (!existing) throw error;
        contactId = existing;
      }
    }

    const { entry, alreadyExisted } = await createWaitlistEntry(tenant.id, {
      contactId: contactId as string,
      serviceId: data.serviceId,
      professionalId: data.professionalId ?? null,
      date: data.date,
      period: data.period,
      windowStartMin: data.windowStartMin ?? null,
      windowEndMin: data.windowEndMin ?? null,
      source: "PANEL",
    });
    if (!alreadyExisted) {
      const label = await waitlistLabel(tenant.id, entry.id);
      await recordAudit({
        tenantId: tenant.id,
        actor: memberActor(ctx),
        action: "waitlist.added",
        targetType: "waitlist_entry",
        targetId: entry.id,
        summary: `Colocou ${label} na lista de espera.`,
      });
    }
    return { id: entry.id, alreadyExisted };
  });
}

export async function removeWaitlistEntryAction(tenantSlug: string, entryId: string): Promise<Result<{ removed: boolean }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const id = z.string().min(1).parse(entryId);
    const label = await waitlistLabel(tenant.id, id);
    const result = await removeWaitlistEntry(tenant.id, id);
    if (result.removed) {
      await recordAudit({ tenantId: tenant.id, actor: memberActor(ctx), action: "waitlist.removed", targetType: "waitlist_entry", targetId: id, summary: `Tirou ${label} da lista de espera.` });
    }
    return result;
  });
}

/** "Oferecer encaixe": manda agora a oferta do primeiro horário livre que cabe no pedido dessa pessoa. */
export async function offerWaitlistEntryAction(tenantSlug: string, entryId: string): Promise<Result<{ slotStart: string }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const id = z.string().min(1).parse(entryId);
    const { slotStart } = await offerEntryManually(tenant.id, id);
    const label = await waitlistLabel(tenant.id, id);
    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "waitlist.offered",
      targetType: "waitlist_entry",
      targetId: id,
      summary: `Ofereceu o encaixe de ${formatDateTimeBr(slotStart, tenant.timezone)} para ${label}.`,
    });
    return { slotStart: slotStart.toISOString() };
  });
}
