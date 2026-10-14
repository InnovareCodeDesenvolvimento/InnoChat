import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";

/**
 * Auto-reparo de migrations que faltaram no banco (incidente 2026-10-14, v1.11.0).
 *
 * Causa: o `npx prisma migrate deploy` no boot do container (Dockerfile linha 128) roda
 * DENTRO da imagem publicada. Se a imagem foi construída antes do commit que adiciona
 * a migration, ela não tem a pasta `prisma/migrations/` com a migration nova. Aí o
 * `migrate deploy` retorna "No pending migrations to apply" — mentira: a coluna existe no
 * `schema.prisma` mas não no banco, e qualquer SELECT na tabela afetada quebra com
 * `column does not exist`. A UI de auth degrada silenciosamente (botão do Sonnet 5
 * some), rotas admin dão 500.
 *
 * Este módulo detecta, antes do servidor começar a responder, se as colunas/tabelas
 * de migrations recentes existem. Se faltar, aplica o SQL embarcado (não depende de
 * `prisma/migrations/` estar na imagem). Idempotente: roda em todo boot mas só faz
 * trabalho quando precisa.
 *
 * O que está aqui é só o que v1.11.0 precisa e que cabe ser aplicado sem o Prisma
 * Client saber a forma exata. A cada migration nova, acrescente um bloco `check` +
 * `apply` no array `MIGRATIONS_TO_REPAIR` — com o `version` (a string que a migration
 * Prisma registra em `_prisma_migrations.migration_name`) e o SQL puro. Mantenha
 * pequeno: este arquivo é a rede de segurança para "imagem velha publicada sem
 * migration"; a regra continua sendo rebuild após push.
 *
 * Se este arquivo crescer muito (>5 entries), pare e refatore: a proteção real é
 * o rebuild do Easypanel, não este código.
 */

const MIGRATIONS_TO_REPAIR: Array<{
  version: string;
  description: string;
  check: (prisma: ReturnType<typeof getPrisma>) => Promise<boolean>;
  apply: (prisma: ReturnType<typeof getPrisma>) => Promise<void>;
}> = [
  {
    version: "20261014160000_rescue_leads_phase1",
    description: "User.lastSeenAt, RescueLead, purpose em PlatformWhatsappConnection, flags em PlatformSettings",
    check: async (prisma) => {
      // Se a coluna purpose existe em platform_whatsapp_connections, a migration está aplicada.
      const result = await prisma.$queryRawUnsafe<Array<{ column_exists: boolean }>>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'platform_whatsapp_connections'
             AND column_name = 'purpose'
         ) AS column_exists;`
      );
      return Boolean(result[0]?.column_exists);
    },
    apply: async (prisma) => {
      // Aplica só o que falta (idempotência real). Cada bloco é seguro rodar 2x porque
      // checa antes. Mantemos a migration em pequenos passos para isolar problemas.
      await ensureEnum(prisma, "RescueLeadStatus", [
        "PENDING", "MESSAGE_1_SENDING", "MESSAGE_1_SENT",
        "MESSAGE_2_SENDING", "MESSAGE_2_SENT", "RESPONDED",
        "CONVERTED", "OPTED_OUT", "EXPIRED", "SKIPPED",
      ]);
      await ensureColumn(prisma, "users", "lastSeenAt", "TIMESTAMP(3)");
      await ensureIndex(prisma, "users_lastSeenAt_idx", `CREATE INDEX "users_lastSeenAt_idx" ON "users"("lastSeenAt");`);
      await ensureColumn(prisma, "platform_settings", "rescueWhatsappEnabled", "BOOLEAN NOT NULL DEFAULT false");
      await ensureColumn(prisma, "platform_settings", "rescueQuietHoursStart", "INTEGER NOT NULL DEFAULT 20");
      await ensureColumn(prisma, "platform_settings", "rescueQuietHoursEnd", "INTEGER NOT NULL DEFAULT 8");
      await ensureCheckConstraint(
        prisma,
        "platform_settings",
        "platform_settings_rescue_quiet_hours_check",
        `CHECK ("rescueQuietHoursStart" >= 0 AND "rescueQuietHoursStart" <= 23 AND "rescueQuietHoursEnd" >= 0 AND "rescueQuietHoursEnd" <= 23)`,
      );
      await ensureColumn(prisma, "platform_whatsapp_connections", "purpose", "TEXT NOT NULL DEFAULT 'BILLING'");
      await ensureCheckConstraint(
        prisma,
        "platform_whatsapp_connections",
        "platform_whatsapp_connections_purpose_check",
        `CHECK ("purpose" IN ('BILLING', 'RESCUE'))`,
      );
      await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "platform_whatsapp_connections_one_active";`);
      await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "platform_whatsapp_connections_one_pending";`);
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "platform_whatsapp_connections_one_active" ON "platform_whatsapp_connections" ("purpose") WHERE "role" = 'ACTIVE';`
      );
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "platform_whatsapp_connections_one_pending" ON "platform_whatsapp_connections" ("purpose") WHERE "role" = 'PENDING';`
      );
      await prisma.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "platform_whatsapp_connections_purpose_role_idx" ON "platform_whatsapp_connections"("purpose", "role");`
      );
      await ensureTable(
        prisma,
        "rescue_leads",
        `CREATE TABLE "rescue_leads" (
          "id" TEXT NOT NULL,
          "userId" TEXT NOT NULL,
          "tenantId" TEXT NOT NULL,
          "phoneE164" TEXT NOT NULL,
          "status" "RescueLeadStatus" NOT NULL DEFAULT 'PENDING',
          "step1ScheduledAt" TIMESTAMP(3) NOT NULL,
          "step1SentAt" TIMESTAMP(3),
          "step2ScheduledAt" TIMESTAMP(3),
          "step2SentAt" TIMESTAMP(3),
          "nextRunAt" TIMESTAMP(3),
          "attempts" INTEGER NOT NULL DEFAULT 0,
          "lastErrorCode" TEXT,
          "optedOutAt" TIMESTAMP(3),
          "convertedAt" TIMESTAMP(3),
          "respondedAt" TIMESTAMP(3),
          "platformConnectionId" TEXT,
          "senderPhoneE164" TEXT,
          "providerMessageId1" TEXT,
          "providerMessageId2" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          CONSTRAINT "rescue_leads_pkey" PRIMARY KEY ("id")
        );`
      );
      await ensureIndex(prisma, "rescue_leads_userId_key", `CREATE UNIQUE INDEX "rescue_leads_userId_key" ON "rescue_leads"("userId");`);
      await ensureIndex(prisma, "rescue_leads_status_nextRunAt_idx", `CREATE INDEX "rescue_leads_status_nextRunAt_idx" ON "rescue_leads"("status", "nextRunAt");`);
      await ensureIndex(prisma, "rescue_leads_phoneE164_idx", `CREATE INDEX "rescue_leads_phoneE164_idx" ON "rescue_leads"("phoneE164");`);
      await ensureIndex(prisma, "rescue_leads_tenantId_idx", `CREATE INDEX "rescue_leads_tenantId_idx" ON "rescue_leads"("tenantId");`);
      await ensureCheckConstraint(prisma, "rescue_leads", "rescue_leads_phoneE164_format_check", `CHECK ("phoneE164" ~ '^[0-9]{12,13}$')`);
      await ensureCheckConstraint(prisma, "rescue_leads", "rescue_leads_attempts_check", `CHECK ("attempts" >= 0)`);
      await ensureForeignKey(
        prisma,
        "rescue_leads",
        "rescue_leads_userId_fkey",
        `FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      );
      await ensureForeignKey(
        prisma,
        "rescue_leads",
        "rescue_leads_tenantId_fkey",
        `FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
      );
      await ensureForeignKey(
        prisma,
        "rescue_leads",
        "rescue_leads_platformConnectionId_fkey",
        `FOREIGN KEY ("platformConnectionId") REFERENCES "platform_whatsapp_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
      );
    },
  },
];

async function columnExists(prisma: ReturnType<typeof getPrisma>, table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_exists: boolean }>>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS column_exists;`,
    table, column,
  );
  return Boolean(rows[0]?.column_exists);
}

async function tableExists(prisma: ReturnType<typeof getPrisma>, table: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ table_exists: boolean }>>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS table_exists;`,
    table,
  );
  return Boolean(rows[0]?.table_exists);
}

async function indexExists(prisma: ReturnType<typeof getPrisma>, indexName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ index_exists: boolean }>>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1
     ) AS index_exists;`,
    indexName,
  );
  return Boolean(rows[0]?.index_exists);
}

async function constraintExists(prisma: ReturnType<typeof getPrisma>, table: string, constraintName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.table_constraints
       WHERE table_schema = 'public' AND table_name = $1 AND constraint_name = $2
     ) AS exists;`,
    table, constraintName,
  );
  return Boolean(rows[0]?.exists);
}

async function enumExists(prisma: ReturnType<typeof getPrisma>, enumName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE t.typname = $1 AND n.nspname = 'public'
     ) AS exists;`,
    enumName,
  );
  return Boolean(rows[0]?.exists);
}

async function foreignKeyExists(prisma: ReturnType<typeof getPrisma>, table: string, fkName: string): Promise<boolean> {
  return constraintExists(prisma, table, fkName);
}

async function ensureColumn(prisma: ReturnType<typeof getPrisma>, table: string, column: string, definition: string): Promise<void> {
  if (await columnExists(prisma, table, column)) return;
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition};`);
}

async function ensureIndex(prisma: ReturnType<typeof getPrisma>, indexName: string, createSql: string): Promise<void> {
  if (await indexExists(prisma, indexName)) return;
  await prisma.$executeRawUnsafe(createSql);
}

async function ensureCheckConstraint(
  prisma: ReturnType<typeof getPrisma>,
  table: string,
  constraintName: string,
  body: string,
): Promise<void> {
  if (await constraintExists(prisma, table, constraintName)) return;
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD CONSTRAINT "${constraintName}" ${body};`);
}

async function ensureTable(
  prisma: ReturnType<typeof getPrisma>,
  tableName: string,
  createSql: string,
): Promise<void> {
  if (await tableExists(prisma, tableName)) return;
  await prisma.$executeRawUnsafe(createSql);
}

async function ensureEnum(
  prisma: ReturnType<typeof getPrisma>,
  enumName: string,
  values: string[],
): Promise<void> {
  if (await enumExists(prisma, enumName)) return;
  const valuesSql = values.map((v) => `'${v}'`).join(", ");
  await prisma.$executeRawUnsafe(`CREATE TYPE "${enumName}" AS ENUM (${valuesSql});`);
}

async function ensureForeignKey(
  prisma: ReturnType<typeof getPrisma>,
  table: string,
  fkName: string,
  body: string,
): Promise<void> {
  if (await foreignKeyExists(prisma, table, fkName)) return;
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD CONSTRAINT "${fkName}" ${body};`);
}

async function recordMigrationApplied(prisma: ReturnType<typeof getPrisma>, version: string): Promise<void> {
  // O Prisma registra cada migration aplicada em _prisma_migrations. Se esta tabela
  // existir e a migration não estiver lá, insere a linha para o `migrate status`
  // não reclamar. Se a tabela não existir, não cria — a migration Prisma
  // propriamente dita vai lidar quando rodar.
  try {
    const exists = await tableExists(prisma, "_prisma_migrations");
    if (!exists) return;
    const applied = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "_prisma_migrations" WHERE "migration_name" = $1 LIMIT 1;`,
      version,
    );
    if (applied.length > 0) return;
    // A coluna `checksum` é VARCHAR(64). Mantemos só o `version` (timestamp + nome = ≤ 50 chars).
    const checksum = `auto-repair:${version}`.slice(0, 64);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES (gen_random_uuid()::text, $1, NOW(), $2, NULL, NULL, NOW(), 1);`,
      checksum,
      version,
    );
  } catch {
    // Sem stress: o auto-reparo só registra; a migration Prisma pode detectar
    // divergência depois e resolver no próximo `migrate resolve`.
  }
}

export async function autoRepairMigrations(): Promise<{ checked: number; applied: string[] }> {
  const prisma = getPrisma();
  const applied: string[] = [];
  let checked = 0;
  for (const migration of MIGRATIONS_TO_REPAIR) {
    checked += 1;
    try {
      const alreadyApplied = await migration.check(prisma);
      if (alreadyApplied) continue;
      logger.warn("migrations.auto_repair.applying", { version: migration.version, description: migration.description });
      await migration.apply(prisma);
      await recordMigrationApplied(prisma, migration.version);
      applied.push(migration.version);
      logger.warn("migrations.auto_repair.applied", { version: migration.version });
    } catch (error) {
      logger.error("migrations.auto_repair.failed", {
        version: migration.version,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { checked, applied };
}
