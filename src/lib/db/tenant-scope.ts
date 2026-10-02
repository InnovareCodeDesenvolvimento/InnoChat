/**
 * Lógica pura de injeção de `tenantId` nos argumentos de uma operação do
 * Prisma Client. Separada de `tenant-client.ts` (que monta a extension de
 * verdade) para ser testável sem precisar instanciar um PrismaClient nem
 * depender do `schema.prisma` (Cronos) já existir.
 *
 * Ver docs/arquitetura.md §5 — "O acesso passa por forTenant(tenantId)... o
 * tenantId nunca vem da requisição".
 */

/**
 * Lista fechada e explícita dos models tenant-scoped que têm coluna
 * `tenantId` própria em `prisma/schema.prisma` (Cronos) — é isso que permite
 * ao mecanismo genérico abaixo injetar `where: { tenantId }` /
 * `data: { tenantId }` automaticamente. Nomes de MODEL (PascalCase), não o
 * nome de propriedade do client (camelCase).
 *
 * NÃO estão aqui, de propósito:
 * - Globais (arquitetura.md §5, §11), sempre via `getPrisma()`: `User`,
 *   `PlatformSettings`, `AuthToken`, `Plan` (catálogo de planos, cross-tenant
 *   por natureza).
 * - `ProviderEvent`: global (dedupe de webhook de pagamento por provedor, sem
 *   noção de tenant).
 * - `TrialClaim`: TEM `tenantId` próprio, mas fica de fora DE PROPÓSITO — a
 *   verificação de "este número já usou trial" (Fase 7, §7.3 regra 4) precisa
 *   ser CROSS-tenant. Colocar aqui faria `forTenant()` filtrar por tenant e
 *   quebrar exatamente a checagem que este model existe para fazer (ver
 *   comentário em `prisma/schema.prisma` no model `TrialClaim`).
 * - Onda 0 (melhorias 2026-10), globais ou lidos cross-tenant pelo Admin, sempre via `getPrisma()`:
 *   `ErrorGroup`, `ErrorEvent`, `BackupConfig`, `BackupRun`, `BackupDriveOauthNonce`,
 *   `TwoFactorRecoveryCode`, `Coupon`, `CouponPlan`. `AuditLog` e `CouponRedemption` TÊM `tenantId`
 *   mas ficam de fora (o Admin lê todas as empresas; a tela da empresa filtra `tenantId` à mão).
 *   `WaitlistEntry` é o único novo que ENTRA na lista (tenant-scoped puro).
 * - Tenant-scoped SEM coluna `tenantId` própria — o isolamento é por relação
 *   (join até o pai que tem `tenantId`), então este mecanismo genérico não
 *   serve: `ProfessionalService` (via `professionalId` → `Professional`),
 *   `WorkingHour` (via `professionalId` → `Professional`),
 *   `AppointmentEvent` (via `appointmentId` → `Appointment`), `ChatSession`
 *   (via `whatsappInstanceId` → `WhatsappInstance`), `InboundEvent` (idem),
 *   `Invoice` (via `subscriptionId` → `Subscription`).
 *   Quem consultar esses models precisa filtrar pelo pai já resolvido para o
 *   tenant certo (ex.: carregar o `Professional` com `forTenant()` primeiro),
 *   nunca confiar em um filtro direto por essas tabelas.
 */
export const TENANT_SCOPED_MODELS = [
  "Membership",
  "Service",
  "Professional",
  "ScheduleException",
  "Contact",
  "Appointment",
  "WhatsappInstance",
  "BotText",
  "Subscription",
  "ChatMessage",
  "HandoffRequest",
  "WaitlistEntry",
] as const;

export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

export function isTenantScopedModel(model: string | undefined): model is TenantScopedModel {
  return !!model && (TENANT_SCOPED_MODELS as readonly string[]).includes(model);
}

type AnyArgs = Record<string, unknown>;

/** Operações que filtram/afetam linhas via `where`. */
const WHERE_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
  "update",
  "delete",
]);

/**
 * Reescreve os argumentos de uma operação do Prisma Client para injetar
 * `tenantId`, sempre SOBRESCREVENDO qualquer valor que o chamador tenha
 * passado — nunca confiamos em tenantId vindo de fora (arquitetura.md §5:
 * "o tenantId nunca vem da requisição").
 *
 * Lança para qualquer operação não coberta explicitamente. É proposital:
 * melhor quebrar em desenvolvimento/teste do que deixar passar sem escopo
 * uma operação nova que ninguém pensou em tratar aqui.
 */
export function scopeArgsToTenant(params: {
  model: string;
  operation: string;
  args: AnyArgs;
  tenantId: string;
}): AnyArgs {
  const { operation, args, tenantId, model } = params;

  if (WHERE_OPERATIONS.has(operation)) {
    const where = (args.where as AnyArgs | undefined) ?? {};
    return { ...args, where: { ...where, tenantId } };
  }

  if (operation === "create") {
    const data = (args.data as AnyArgs | undefined) ?? {};
    return { ...args, data: { ...data, tenantId } };
  }

  if (operation === "createMany" || operation === "createManyAndReturn") {
    const list = Array.isArray(args.data) ? args.data : [args.data];
    return {
      ...args,
      data: list.map((item) => ({ ...(item as AnyArgs), tenantId })),
    };
  }

  if (operation === "upsert") {
    const where = (args.where as AnyArgs | undefined) ?? {};
    const create = (args.create as AnyArgs | undefined) ?? {};
    return { ...args, where: { ...where, tenantId }, create: { ...create, tenantId } };
  }

  throw new Error(
    `forTenant: a operação "${operation}" no model "${model}" não tem regra de isolamento de tenant ` +
      `definida em src/lib/db/tenant-scope.ts. Adicione o caso antes de usar — um model tenant-scoped ` +
      "nunca pode rodar uma operação sem escopo.",
  );
}
