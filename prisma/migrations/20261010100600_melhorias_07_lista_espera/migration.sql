-- Onda 0, item 7: lista de espera / encaixe. So tabela nova (aditiva).

CREATE TABLE "waitlist_entries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "professionalId" TEXT,
    "desiredDate" DATE NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'ANY',
    "windowStartMin" INTEGER,
    "windowEndMin" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "offeredSlotStart" TIMESTAMPTZ,
    "offeredProfessionalId" TEXT,
    "offeredAt" TIMESTAMPTZ,
    "offerExpiresAt" TIMESTAMPTZ,
    "appointmentId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'BOT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waitlist_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "waitlist_entries_appointmentId_key" ON "waitlist_entries"("appointmentId");
CREATE INDEX "waitlist_entries_tenantId_serviceId_desiredDate_status_crea_idx" ON "waitlist_entries"("tenantId", "serviceId", "desiredDate", "status", "createdAt");
CREATE INDEX "waitlist_entries_status_offerExpiresAt_idx" ON "waitlist_entries"("status", "offerExpiresAt");

ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "professionals"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_offeredProfessionalId_fkey" FOREIGN KEY ("offeredProfessionalId") REFERENCES "professionals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Conjuntos fechados.
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_status_check"
  CHECK ("status" IN ('WAITING', 'OFFERED', 'ACCEPTED', 'EXPIRED', 'CANCELED', 'FULFILLED'));
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_period_check"
  CHECK ("period" IN ('ANY', 'MORNING', 'AFTERNOON', 'EVENING'));
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_source_check" CHECK ("source" IN ('BOT', 'PANEL'));
-- Janela fina: os dois limites ou nenhum, dentro do dia, inicio antes do fim.
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_window_check" CHECK (
  ("windowStartMin" IS NULL AND "windowEndMin" IS NULL)
  OR ("windowStartMin" IS NOT NULL AND "windowEndMin" IS NOT NULL
      AND "windowStartMin" >= 0 AND "windowEndMin" <= 1440 AND "windowStartMin" < "windowEndMin")
);
-- Oferta em aberto tem horario, instante da oferta e prazo. (offeredProfessionalId fica fora de proposito:
-- e SET NULL se o profissional for apagado, e a CHECK barraria essa exclusao.)
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_offered_shape_check" CHECK (
  "status" <> 'OFFERED'
  OR ("offeredSlotStart" IS NOT NULL AND "offeredAt" IS NOT NULL AND "offerExpiresAt" IS NOT NULL)
);

-- No maximo 1 entrada ativa por contato + servico + dia + profissional (ou "qualquer"): impede o bot de
-- enfileirar a mesma pessoa duas vezes.
CREATE UNIQUE INDEX "waitlist_entries_one_active_per_contact_key"
  ON "waitlist_entries" ("tenantId", "contactId", "serviceId", "desiredDate", COALESCE("professionalId", ''))
  WHERE "status" IN ('WAITING', 'OFFERED');

-- O mesmo horario de um profissional nao pode estar oferecido a duas pessoas ao mesmo tempo.
CREATE UNIQUE INDEX "waitlist_entries_one_open_offer_per_slot_key"
  ON "waitlist_entries" ("tenantId", "offeredProfessionalId", "offeredSlotStart")
  WHERE "status" = 'OFFERED' AND "offeredProfessionalId" IS NOT NULL;
