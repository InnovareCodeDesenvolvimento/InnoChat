import { z } from "zod";

/**
 * Contratos zod da API interna do bot (docs/arquitetura.md §6.1–6.5, §6.8). Fonte única para:
 * 1) validação de entrada nas rotas (`src/app/api/internal/v1/**`);
 * 2) geração do OpenAPI (`scripts/generate-openapi.mjs` → `docs/api-interna.openapi.json`).
 *
 * Nomes exportados terminam em `Schema` (request) ou `ResponseSchema` (response) — o gerador
 * varre este módulo por convenção de nome, então mudar o padrão aqui exige atualizar o script.
 */

const isoDateOnly = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// POST /messages/claim (§6.2)
// ---------------------------------------------------------------------------

export const ClaimRequestSchema = z
  .object({ payload: z.unknown().describe("Corpo bruto do webhook da Evolution API v2 (messages.upsert ou connection.update).") })
  .describe("Corpo de POST /messages/claim");

const optionSchema = z.object({ id: z.string(), label: z.string() });

export const ClaimProcessResponseSchema = z
  .object({
    action: z.literal("process"),
    inboundEventId: z.string(),
    instance: z.object({ name: z.string(), sandbox: z.boolean() }),
    to: z.string().describe("Dígitos do JID exatamente como recebidos (§6.9)."),
    message: z.union([z.object({ type: z.literal("text"), text: z.string() }), z.object({ type: z.literal("media") })]),
    contact: z.object({ id: z.string(), name: z.string().nullable(), pushName: z.string().nullable() }),
    session: z.object({
      id: z.string(),
      state: z.string(),
      context: z.record(z.string(), z.unknown()),
      invalidCount: z.number().int(),
      version: z.number().int(),
      lockToken: z.string(),
      expired: z.boolean(),
    }),
    tenant: z.object({ name: z.string(), askProfessional: z.boolean(), timezone: z.string() }),
    texts: z.record(z.string(), z.string()),
  })
  .describe("200 — processar (§6.2)");

export const ClaimBusyResponseSchema = z.object({ action: z.literal("busy"), retryAfterMs: z.number().int() }).describe("200 — tentar de novo (§6.2)");

export const ClaimIgnoreResponseSchema = z
  .object({
    action: z.literal("ignore"),
    reason: z.enum([
      "DUPLICATE",
      "STALE",
      "GROUP",
      "UNSUPPORTED_EVENT",
      "FROM_ME_ECHO",
      "HUMAN_TOOK_OVER",
      "HUMAN_MODE",
      "BOT_PAUSED",
      "TENANT_SUSPENDED",
      "UNRESOLVABLE_SENDER",
    ]),
  })
  .describe("200 — nada a fazer (§6.2)");

// ---------------------------------------------------------------------------
// Sessão (§6.3)
// ---------------------------------------------------------------------------

export const UpdateSessionRequestSchema = z
  .object({
    lockToken: z.string().min(1),
    version: z.number().int().min(0),
    state: z.string().min(1).max(64),
    context: z.record(z.string(), z.unknown()).default({}),
    invalidCount: z.number().int().min(0).default(0),
    outbound: z.array(z.string()).max(10),
    handoff: z.boolean().default(false),
  })
  .describe("Corpo de PUT /sessions/{id}");

export const UpdateSessionResponseSchema = z.object({ version: z.number().int() }).describe("200 (§6.3)");

export const ReleaseSessionRequestSchema = z.object({ lockToken: z.string().min(1) }).describe("Corpo de POST /sessions/{id}/release");
export const ReleaseSessionResponseSchema = z.object({ released: z.literal(true) }).describe("200, sempre idempotente (§6.3)");

// ---------------------------------------------------------------------------
// Catálogo e disponibilidade (§6.4) — todas GET, sem corpo.
// ---------------------------------------------------------------------------

export const CatalogServicesQuerySchema = z.object({ contactId: z.string().min(1).optional() });
export const CatalogServicesResponseSchema = z
  .object({
    options: z.array(
      optionSchema.extend({
        durationMin: z.number().int(),
        name: z.string(),
        durationLabel: z.string().describe('Ex.: "1h", "40 min", "1h30".'),
        priceLabel: z.string().nullable().describe('Ex.: "R$ 80,00"; null = sem preço.'),
      }),
    ),
    limit: z
      .object({ max: z.number().int().describe("0 = sem limite."), count: z.number().int(), reached: z.boolean() })
      .optional()
      .describe("Só com ?contactId (limite de agendamentos futuros, bot v2)."),
  })
  .describe("200 GET /catalog/services — só serviços com profissional ativo e com expediente");

export const CatalogProfessionalsResponseSchema = z
  .object({ options: z.array(optionSchema), skip: z.boolean() })
  .describe("200 GET /catalog/services/{serviceId}/professionals");

export const AvailabilityDaysQuerySchema = z.object({
  serviceId: z.string().min(1),
  professionalId: z.string().min(1).optional(),
  // Omitido = "hoje no fuso do tenant" (resolvido em `listAvailabilityDayOptions`, que já
  // carrega o tenant para outras coisas — evita o n8n precisar saber o fuso só para montar isto).
  from: z.string().regex(isoDateOnly, "from precisa estar no formato YYYY-MM-DD").optional(),
  // Omitido: 6 com `X-InnoChat-Flow: 2`, 7 sem o header (v1). Resolvido na rota.
  limit: z.coerce.number().int().min(1).max(7).optional(),
});
export const AvailabilityDaysResponseSchema = z
  .object({
    options: z.array(optionSchema.extend({ relativeLabel: z.string().describe('Ex.: "Hoje · Qua 30/09".') })),
    hasMore: z.boolean(),
    nextFrom: z.string().nullable().describe("Dia SEGUINTE ao último mostrado (BUG-05); null sem próxima página."),
    lastBookableDate: optionSchema,
  })
  .describe("200 GET /availability/days");

export const AvailabilitySlotsQuerySchema = z.object({
  serviceId: z.string().min(1),
  professionalId: z.string().min(1).optional(),
  date: z.string().regex(isoDateOnly, "date precisa estar no formato YYYY-MM-DD"),
  offset: z.coerce.number().int().min(0).default(0),
  // Omitido: 3 com `near`; senão 7 com `X-InnoChat-Flow: 2` e 8 no v1. Resolvido na rota.
  limit: z.coerce.number().int().min(1).max(8).optional(),
  period: z.enum(["morning", "afternoon", "evening"]).optional(),
  near: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "near precisa estar no formato HH:mm").optional(),
});
export const AvailabilitySlotsResponseSchema = z
  .object({
    options: z.array(optionSchema),
    hasMore: z.boolean(),
    exact: z.boolean().optional().describe("Só com near: options[0] é exatamente near."),
    dateLabel: z.string(),
    dateRelativeLabel: z.string(),
    dateLongLabel: z.string(),
    reason: z.enum(["PAST", "BEYOND_HORIZON", "CLOSED", "FULL"]).nullable().describe("Preenchido só com options vazio."),
    nextDay: optionSchema.extend({ relativeLabel: z.string() }).nullable(),
  })
  .describe("200 GET /availability/slots");

export const AvailabilityNextQuerySchema = z.object({
  serviceId: z.string().min(1),
  professionalId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(10).default(6),
});
export const AvailabilityNextResponseSchema = z
  .object({ options: z.array(z.object({ id: z.string().describe("ISO UTC"), label: z.string().describe('Ex.: "Hoje · 16:30".'), date: z.string() })) })
  .describe("200 GET /availability/next");

// ---------------------------------------------------------------------------
// Escrita: contato e agendamento (§6.5)
// ---------------------------------------------------------------------------

export const UpdateContactRequestSchema = z.object({ name: z.string().min(1).max(60) }).describe("Corpo de PATCH /contacts/{contactId}");

export const ContactAppointmentsQuerySchema = z.object({ upcoming: z.coerce.boolean().default(true) });

// Estende `optionSchema` com os dados que hoje o n8n extraía por regex do `label` (ver
// "PARA O PRÓXIMO" do handoff da Vega, Fase 4b) — aditivo, `id`/`label` continuam iguais.
const appointmentOptionSchema = optionSchema.extend({
  serviceId: z.string(),
  professionalId: z.string(),
  servico: z.string(),
  profissional: z.string(),
  data: z.string().describe("Rótulo formatado no fuso do tenant, ex.: \"Ter 30/09\" (core/bot/format.ts)."),
  hora: z.string().describe("Rótulo formatado no fuso do tenant, ex.: \"14:30\" (core/bot/format.ts)."),
  startsAt: z.string().describe("ISO 8601 em UTC."),
  canChange: z.boolean().describe("startsAt - agora >= cancelMinLeadMin."),
  changeDeadlineLabel: z.string(),
  durationLabel: z.string(),
  priceLabel: z.string().nullable(),
  dataLonga: z.string(),
  relativeLabel: z.string(),
});
export const ContactAppointmentsResponseSchema = z
  .object({ options: z.array(appointmentOptionSchema) })
  .describe("200 GET /contacts/{contactId}/appointments");

export const CreateAppointmentRequestSchema = z
  .object({
    contactId: z.string().min(1),
    serviceId: z.string().min(1),
    professionalId: z.string().min(1).nullable(),
    startsAt: z.coerce.date().describe("ISO 8601 (ex.: 2026-09-30T17:30:00Z)"),
    idempotencyKey: z.string().min(1).max(190),
    instanceName: z.string().min(1).optional(),
    contactName: z.string().max(200).optional().describe("Nome digitado na conversa; validado (422 INVALID_NAME) e gravado com a reserva."),
  })
  .describe("Corpo de POST /appointments");

const alternativesSchema = z.object({
  date: z.string(),
  dateISO: z.string(),
  dateRelativeLabel: z.string(),
  options: z.array(optionSchema),
});

export const AppointmentSummarySchema = z.object({
  id: z.string(),
  summary: z.object({
    servico: z.string(),
    profissional: z.string(),
    data: z.string(),
    hora: z.string(),
    duracao: z.string(),
    preco: z.string().nullable(),
    data_longa: z.string(),
  }),
});
export const CreateAppointmentResponseSchema = z.object({ appointment: AppointmentSummarySchema }).describe("201/200 (§6.5)");
export const SlotTakenResponseSchema = z.object({ alternatives: alternativesSchema }).describe("409 SLOT_TAKEN (§6.5)");

export const CancelAppointmentRequestSchema = z
  .object({ contactId: z.string().min(1), idempotencyKey: z.string().min(1).max(190).optional() })
  .describe("Corpo de POST /appointments/{id}/cancel");

export const RescheduleAppointmentRequestSchema = z
  .object({ contactId: z.string().min(1), startsAt: z.coerce.date().describe("ISO 8601 (ex.: 2026-09-30T17:30:00Z)"), idempotencyKey: z.string().min(1).max(190).optional() })
  .describe("Corpo de POST /appointments/{id}/reschedule");

// ---------------------------------------------------------------------------
// Lista de espera (melhoria 7)
// ---------------------------------------------------------------------------

export const WaitlistJoinRequestSchema = z
  .object({
    contactId: z.string().min(1),
    serviceId: z.string().min(1),
    professionalId: z.string().min(1).nullable().optional().describe("Nulo, ausente ou \"any\" = qualquer profissional."),
    date: z.string().regex(isoDateOnly).describe("Dia desejado, YYYY-MM-DD no fuso da empresa."),
    period: z.enum(["morning", "afternoon", "evening"]).nullable().optional().describe("Período pedido; ausente = qualquer horário."),
  })
  .describe("Corpo de POST /waitlist");

export const WaitlistLeaveRequestSchema = z.object({ contactId: z.string().min(1) }).describe("Corpo de POST /waitlist/{id}/leave");

export const WaitlistRespondRequestSchema = z
  .object({ contactId: z.string().min(1), accept: z.boolean().describe("true = SIM (marca o horário); false = NÃO (sai da fila).") })
  .describe("Corpo de POST /waitlist/{id}/respond");

// ---------------------------------------------------------------------------
// Outros (§6.8)
// ---------------------------------------------------------------------------

export const ConnectionEventRequestSchema = z.object({ payload: z.unknown() }).describe("Corpo de POST /connection-events");
export const ConnectionEventResponseSchema = z.object({ applied: z.boolean() }).describe("200 sempre (§6.8)");

export const SandboxOutboxRequestSchema = z
  .object({ sessionId: z.string().min(1), messages: z.array(z.string()).min(1).max(3) })
  .describe("Corpo de POST /sandbox/outbox");
export const SandboxOutboxResponseSchema = z.object({ accepted: z.number().int() });

export const ErrorResponseSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }) })
  .describe("Envelope de erro único de toda a API interna (§6.1)");
