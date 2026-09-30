#!/usr/bin/env node
/**
 * Gera `docs/api-interna.openapi.json` a partir dos schemas zod de `src/lib/api-internal/schemas.ts`
 * (docs/arquitetura.md §6.8: "A especificação completa sai do zod como OpenAPI"). Usa
 * `z.toJSONSchema()` (nativo do zod v4) para converter cada schema — sem dependência nova.
 *
 * Rodar com: `npm run generate:openapi` (ou `node scripts/generate-openapi.mjs`) sempre que um
 * schema em `src/lib/api-internal/schemas.ts` mudar. Não roda no build (é documentação, não
 * artefato de runtime) — quem mexer nos schemas precisa lembrar de rodar de novo.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";
import * as schemas from "../src/lib/api-internal/schemas.ts";
import * as conversa from "../src/lib/api-internal/schemas-conversa.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "docs", "api-interna.openapi.json");

function toSchema(zodSchema) {
  const jsonSchema = z.toJSONSchema(zodSchema, {
    target: "openapi-3.0",
    // `z.coerce.date()` (startsAt) não tem representação nativa em JSON Schema — sem isto,
    // z.toJSONSchema lança. "any" vira `{}` para esses campos; documentamos o formato esperado
    // (ISO 8601) na `description` de cada schema (ver src/lib/api-internal/schemas.ts).
    unrepresentable: "any",
  });
  // z.toJSONSchema devolve $schema/id que o OpenAPI não usa.
  delete jsonSchema.$schema;
  return jsonSchema;
}

const errorSchema = toSchema(schemas.ErrorResponseSchema);

function errorResponse(description, example) {
  return {
    description,
    content: { "application/json": { schema: errorSchema, ...(example ? { example } : {}) } },
  };
}

function jsonBody(zodSchema) {
  return { required: true, content: { "application/json": { schema: toSchema(zodSchema) } } };
}

function jsonResponse(description, zodSchema) {
  return { description, content: { "application/json": { schema: toSchema(zodSchema) } } };
}

const AUTH_HEADERS = [
  { name: "Authorization", in: "header", required: true, schema: { type: "string" }, description: "Bearer <INTERNAL_API_SECRET> (§6.1)" },
  { name: "X-InnoChat-Instance", in: "header", required: true, schema: { type: "string" }, description: "webhookToken da WhatsappInstance — resolve o tenant (§6.1)" },
  { name: "X-InnoChat-Flow", in: "header", required: false, schema: { type: "string", enum: ["2"] }, description: "Versão do fluxo do bot. \"2\" liga o contrato v2 (claim enriquecido, limite de agendamentos futuros); ausente = v1." },
];

const UNAUTHORIZED = errorResponse("Segredo ausente/errado ou instância não encontrada.", { error: { code: "UNAUTHORIZED", message: "Segredo inválido." } });
const NOT_FOUND = errorResponse("Id não pertence ao tenant da instância (§6.1) — nunca 403.", { error: { code: "NOT_FOUND", message: "Recurso não encontrado." } });
const INVALID_PAYLOAD = errorResponse("Corpo/query inválidos.", { error: { code: "INVALID_PAYLOAD", message: "Dados inválidos." } });

function op({ summary, description, requestBody, responses, query, pathParams }) {
  return {
    summary,
    description,
    parameters: [
      ...AUTH_HEADERS,
      ...(pathParams ?? []).map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
      ...(query ?? []),
    ],
    ...(requestBody ? { requestBody: jsonBody(requestBody) } : {}),
    responses: { "401": UNAUTHORIZED, ...responses },
  };
}

function q(name, description, required = false) {
  return { name, in: "query", required, schema: { type: "string" }, description };
}

const paths = {
  "/messages/claim": {
    post: op({
      summary: "Normaliza, deduplica, trava e carrega a sessão (§6.2)",
      requestBody: schemas.ClaimRequestSchema,
      responses: {
        "200": {
          description: "process (v1, ou v2 com X-InnoChat-Flow: 2) | busy | ignore — nunca 5xx para payload irreconhecível.",
          content: {
            "application/json": {
              schema: {
                oneOf: [toSchema(schemas.ClaimProcessResponseSchema), toSchema(conversa.ClaimProcessV2ResponseSchema), toSchema(schemas.ClaimBusyResponseSchema), toSchema(schemas.ClaimIgnoreResponseSchema)],
              },
            },
          },
        },
        "422": INVALID_PAYLOAD,
      },
    }),
  },
  "/sessions/{id}": {
    put: op({
      summary: "Grava e libera a trava da sessão (§6.3)",
      pathParams: ["id"],
      requestBody: conversa.UpdateSessionV2RequestSchema,
      responses: {
        "200": jsonResponse("OK", schemas.UpdateSessionResponseSchema),
        "404": NOT_FOUND,
        "409": errorResponse("Trava vencida ou versão divergente — o n8n não envia e encerra.", { error: { code: "LOCK_LOST", message: "A trava da sessão venceu ou a versão está desatualizada." } }),
        "422": INVALID_PAYLOAD,
      },
    }),
  },
  "/sessions/{id}/release": {
    post: op({
      summary: "Libera a trava sem gravar — sempre idempotente; pode avisar o cliente com TECH_ERROR (§6.3, spec bot v2 §3.11)",
      pathParams: ["id"],
      requestBody: conversa.ReleaseSessionV2RequestSchema,
      responses: { "200": jsonResponse("OK, sempre idempotente", conversa.ReleaseSessionV2ResponseSchema), "404": NOT_FOUND },
    }),
  },
  "/catalog/services": {
    get: op({ summary: "Catálogo de serviços ativos (§6.4)", responses: { "200": jsonResponse("OK", schemas.CatalogServicesResponseSchema) } }),
  },
  "/catalog/services/{serviceId}/professionals": {
    get: op({
      summary: "Profissionais aptos para o serviço (§6.4)",
      pathParams: ["serviceId"],
      responses: { "200": jsonResponse("OK", schemas.CatalogProfessionalsResponseSchema), "404": NOT_FOUND },
    }),
  },
  "/availability/days": {
    get: op({
      summary: "Dias com vaga (§6.4)",
      query: [q("serviceId", "", true), q("professionalId", "ausente = qualquer profissional"), q("from", "YYYY-MM-DD", true), q("limit", "padrão 7, máx. 7")],
      responses: { "200": jsonResponse("OK", schemas.AvailabilityDaysResponseSchema), "404": NOT_FOUND, "422": INVALID_PAYLOAD },
    }),
  },
  "/availability/slots": {
    get: op({
      summary: "Horários livres num dia (§6.4)",
      query: [q("serviceId", "", true), q("professionalId", "ausente = qualquer profissional"), q("date", "YYYY-MM-DD", true), q("offset", "padrão 0"), q("limit", "padrão 8, máx. 8")],
      responses: { "200": jsonResponse("OK", schemas.AvailabilitySlotsResponseSchema), "404": NOT_FOUND, "422": INVALID_PAYLOAD },
    }),
  },
  "/contacts/{contactId}": {
    patch: op({
      summary: "Atualiza o nome do contato (§6.5, ASK_NAME)",
      pathParams: ["contactId"],
      requestBody: schemas.UpdateContactRequestSchema,
      responses: { "200": { description: "OK" }, "404": NOT_FOUND, "422": errorResponse("Nome fora de 2–60 caracteres.", { error: { code: "INVALID_NAME", message: "O nome precisa ter entre 2 e 60 caracteres." } }) },
    }),
  },
  "/contacts/{contactId}/appointments": {
    get: op({
      summary: '"Meus agendamentos" do contato (§6.5)',
      pathParams: ["contactId"],
      query: [q("upcoming", "padrão true")],
      responses: { "200": jsonResponse("OK", schemas.ContactAppointmentsResponseSchema), "404": NOT_FOUND },
    }),
  },
  "/appointments": {
    post: op({
      summary: "Cria um agendamento (idempotente) (§6.5)",
      requestBody: schemas.CreateAppointmentRequestSchema,
      responses: {
        "201": jsonResponse("Criado", schemas.CreateAppointmentResponseSchema),
        "200": jsonResponse("Repetição — mesmo corpo do 201", schemas.CreateAppointmentResponseSchema),
        "404": NOT_FOUND,
        "409": errorResponse("Horário ocupado, com alternativas.", { error: { code: "SLOT_TAKEN", message: "Este horário já está ocupado.", details: { alternatives: { date: "Ter 30/09", options: [{ id: "2026-09-30T17:30:00Z", label: "14:30" }] } } } }),
        "422": errorResponse("Regra de agenda violada.", { error: { code: "RULE_VIOLATION", message: "Horário fora das regras de agenda.", details: { rule: "OUTSIDE_HOURS" } } }),
      },
    }),
  },
  "/appointments/{id}/cancel": {
    post: op({
      summary: "Cancela um agendamento (idempotente) (§6.5)",
      pathParams: ["id"],
      requestBody: schemas.CancelAppointmentRequestSchema,
      responses: {
        "200": { description: "OK, idempotente" },
        "404": NOT_FOUND,
        "409": errorResponse("Fora do prazo mínimo de cancelamento.", { error: { code: "TOO_LATE", message: "Prazo mínimo para cancelar já passou." } }),
      },
    }),
  },
  "/appointments/{id}/reschedule": {
    post: op({
      summary: "Remarca um agendamento (§6.5)",
      pathParams: ["id"],
      requestBody: schemas.RescheduleAppointmentRequestSchema,
      responses: {
        "200": { description: "OK" },
        "404": NOT_FOUND,
        "409": errorResponse("Horário ocupado (com alternativas) ou fora do prazo.", { error: { code: "SLOT_TAKEN", message: "Este horário já está ocupado." } }),
      },
    }),
  },
  "/connection-events": {
    post: op({
      summary: "Aplica connection.update da Evolution — sempre 200 (§6.8)",
      requestBody: schemas.ConnectionEventRequestSchema,
      responses: { "200": jsonResponse("Sempre 200", schemas.ConnectionEventResponseSchema) },
    }),
  },
  "/sandbox/outbox": {
    post: op({
      summary: "Guarda a saída de uma instância sandbox para a bateria de roteiros (§6.8, §8)",
      requestBody: schemas.SandboxOutboxRequestSchema,
      responses: { "200": jsonResponse("OK", schemas.SandboxOutboxResponseSchema), "403": errorResponse("Instância não é sandbox.", { error: { code: "FORBIDDEN", message: "Este endpoint só aceita instâncias sandbox." } }) },
    }),
    get: op({
      summary: "[Extensão além de §6.8] Lê o outbox sandbox — usado pela bateria de roteiros (Fase 6)",
      query: [q("sessionId", "filtra por sessão")],
      responses: { "200": { description: "OK" } },
    }),
  },
};

const document = {
  openapi: "3.0.3",
  info: {
    title: "InnoChat — API interna (n8n → painel)",
    version: "1.0.0",
    description:
      "Contrato consumido pelo workflow innochat-bot no n8n (docs/arquitetura.md §6). Gerado a partir " +
      "dos schemas zod em src/lib/api-internal/schemas.ts — rode `node scripts/generate-openapi.mjs` " +
      "depois de qualquer mudança nesses schemas.",
  },
  servers: [{ url: "https://<painel>/api/internal/v1", description: "Base da API interna (§6.1)" }],
  paths,
  components: { schemas: {} },
};

writeFileSync(OUT_PATH, `${JSON.stringify(document, null, 2)}\n`, "utf-8");
console.log(`OpenAPI gerado em ${OUT_PATH}`);
