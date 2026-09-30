import { z } from "zod";
import { ClaimProcessResponseSchema, UpdateSessionRequestSchema } from "./schemas";

/**
 * Contratos zod da conversa no bot v2 (docs/bot-v2-plano.md §3.4, bloco B-2). Fonte única para a
 * validação das rotas `messages/claim`, `sessions/{id}` e `sessions/{id}/release` e para o OpenAPI
 * (`scripts/generate-openapi.mjs`). Importa de `schemas.ts` só para leitura (o arquivo é da B-1).
 * Mesma convenção de nomes de `schemas.ts`: `...Schema` (request) e `...ResponseSchema` (response).
 */

/** `PUT /sessions/{id}` — o corpo v1 mais `handoffReason` (fluxo v2). */
export const UpdateSessionV2RequestSchema = UpdateSessionRequestSchema.extend({
  handoffReason: z
    .literal("CLIENT_REQUEST")
    .optional()
    .describe("Com handoff=true: o cliente pediu atendente (pausa handoffResumeMinutes). Ausente = fluxo v1 (LEGACY_FLOW, pausa humanPauseMin)."),
}).describe("Corpo de PUT /sessions/{id}");

/** `POST /sessions/{id}/release` — `notify` (padrão true) desliga o aviso TECH_ERROR. */
export const ReleaseSessionV2RequestSchema = z
  .object({
    lockToken: z.string().min(1),
    notify: z.boolean().optional().describe("Padrão true. false = só libera a trava, sem avisar o cliente."),
  })
  .describe("Corpo de POST /sessions/{id}/release");

export const ReleaseSessionV2ResponseSchema = z
  .object({
    released: z.literal(true),
    notified: z
      .boolean()
      .describe(
        "true = o TECH_ERROR foi enviado ao cliente. Só se a trava era a da execução que morreu, última mensagem do cliente há <= 5 min, " +
          "nenhum aviso igual nos últimos 10 min, sessão fora de HUMAN, bot não pausado e assinatura ativa.",
      ),
  })
  .describe("200, sempre idempotente");

/** Resposta `process` do claim com `X-InnoChat-Flow: 2`: a v1 mais os campos do bloco B-2. */
export const ClaimProcessV2ResponseSchema = ClaimProcessResponseSchema.extend({
  flow: z.literal(2),
  contact: ClaimProcessResponseSchema.shape.contact.extend({ firstName: z.string().nullable() }),
  session: ClaimProcessResponseSchema.shape.session.extend({
    previous: z
      .object({ state: z.string(), context: z.unknown(), idleMin: z.number().int() })
      .nullable()
      .describe("Estado e contexto ANTERIORES ao reset, se a sessão expirou há no máximo 24 h."),
    resumedFromHuman: z.enum(["CLIENT_MENU", "TIMEOUT"]).nullable().describe("O bot acabou de voltar do atendente."),
  }),
  tenant: ClaimProcessResponseSchema.shape.tenant.extend({
    today: z.string().describe("YYYY-MM-DD no fuso da empresa."),
    nowLocal: z.string().describe("HH:mm no fuso da empresa."),
    openNow: z.boolean().describe("A equipe está no expediente agora."),
    teamNextOpenLabel: z.string().nullable(),
    handoffUntilLabel: z.string().describe("Quando o bot volta se ninguém responder (agora + handoffResumeMinutes)."),
    changeLeadLabel: z.string(),
    lastBookableDate: z.string().describe("YYYY-MM-DD."),
    slotGranularityMin: z.number().int(),
  }),
}).describe("200 — processar, com X-InnoChat-Flow: 2");
