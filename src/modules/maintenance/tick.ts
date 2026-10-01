import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { CANCELED_RETENTION_DAYS } from "@/core/billing";
import { recordMaintenanceTickRun } from "@/modules/platform/health-service";

/**
 * `POST /api/internal/v1/maintenance/tick` (docs/contratos.md — "Segurança"). Aplica a
 * retenção/anonimização de LGPD declarada em `docs/arquitetura.md` §11/§12, que estava só
 * documentada (revisão de segurança 2026-09-28, achado MÉDIA — nenhum job fazia isso).
 * Chamado periodicamente pelo `innochat-cron` (mesmo cron externo do `billing/tick`, fora deste
 * repo) — não criamos workflow novo no n8n aqui, só o endpoint que ele vai chamar.
 *
 * Duas ações, sempre nesta ordem:
 * 1. **Purga `InboundEvent`** com `createdAt` > 30 dias (§11: "purga após 30 dias"). Sem
 *    limite/paginação necessária: é um único `DELETE ... WHERE createdAt < ?`, o Postgres lida
 *    com qualquer volume numa chamada — não é uma listagem paginada para o client.
 * 2. **Anonimiza `Contact`** de tenants com `Subscription.status = CANCELED` há mais de 90 dias
 *    (§11: "dados guardados 90 dias e depois anonimizados"). Zera `name`/`pushName`/`phoneE164`/
 *    `lid` e substitui `waJid` (não-nulo, único por tenant) por um marcador `anon:<contactId>`
 *    — mantém a linha (e a integridade referencial com `Appointment` histórico), só remove o
 *    dado pessoal. Processado em lotes (`ANONYMIZE_BATCH_LIMIT` por chamada) — a próxima
 *    execução horária continua de onde parou; nunca uma varredura ilimitada numa chamada só.
 *
 * 3. **Purga `ChatMessage`** (histórico de conversas) com mais de 90 dias, em lotes; a anonimização
 *    de contato acima apaga as mensagens do contato. Falha isolada por try/catch.
 *
 * Idempotente por desenho: rodar 2x seguidas não tem efeito adicional (`InboundEvent` antigo já
 * foi apagado; `Contact` já anonimizado é reconhecido pelo prefixo `anon:` em `waJid` e pulado).
 */

const INBOUND_EVENT_RETENTION_DAYS = 30;
const CANCELED_ANONYMIZATION_DAYS = CANCELED_RETENTION_DAYS;
const ANONYMIZE_BATCH_LIMIT = 500;
const ANON_WAJID_PREFIX = "anon:";
const CHAT_MESSAGE_RETENTION_DAYS = 90;
const CHAT_PURGE_BATCH = 5000;
const CHAT_PURGE_MAX_BATCHES = 20;

export type MaintenanceTickSummary = {
  inboundEventsPurged: number;
  contactsAnonymized: number;
  chatMessagesPurged: number;
};

export async function runMaintenanceTick(now: Date = new Date()): Promise<MaintenanceTickSummary> {
  const prisma = getPrisma();

  const inboundEventCutoff = new Date(now.getTime() - INBOUND_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const purged = await prisma.inboundEvent.deleteMany({ where: { createdAt: { lt: inboundEventCutoff } } });

  const cancellationCutoff = new Date(now.getTime() - CANCELED_ANONYMIZATION_DAYS * 24 * 60 * 60 * 1000);
  const contactsToAnonymize = await prisma.contact.findMany({
    where: {
      tenant: { subscription: { status: "CANCELED", canceledAt: { lt: cancellationCutoff } } },
      NOT: { waJid: { startsWith: ANON_WAJID_PREFIX } },
    },
    select: { id: true },
    take: ANONYMIZE_BATCH_LIMIT,
  });

  let contactsAnonymized = 0;
  for (const contact of contactsToAnonymize) {
    // LGPD: o histórico de conversas do contato é apagado junto com a anonimização.
    await prisma.chatMessage.deleteMany({ where: { contactId: contact.id } });
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        waJid: `${ANON_WAJID_PREFIX}${contact.id}`,
        phoneE164: null,
        lid: null,
        name: null,
        pushName: null,
        // `notes` (Fase 8, gestão de clientes): pode conter dado pessoal digitado à mão pela
        // empresa — mesma política de anonimização dos outros campos identificáveis.
        notes: null,
      },
    });
    contactsAnonymized += 1;
  }

  // O motivo livre do cancelamento (texto digitado pelo dono, pode ter dado pessoal) também sai
  // junto com a anonimização dos 90 dias. Isolado: nunca impede o resto do tick.
  try {
    await prisma.subscription.updateMany({
      where: { status: "CANCELED", canceledAt: { lt: cancellationCutoff }, cancelReason: { not: null } },
      data: { cancelReason: null },
    });
  } catch (error) {
    logger.warn("maintenance.cancel_reason_clear_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
  }

  // Retenção do histórico de conversas (90 dias, política de privacidade). Em lotes (findMany +
  // deleteMany por id, no máximo CHAT_PURGE_MAX_BATCHES por chamada — o tick seguinte continua) e
  // isolado: falha aqui não impede o restante do tick.
  let chatMessagesPurged = 0;
  try {
    const chatCutoff = new Date(now.getTime() - CHAT_MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    for (let i = 0; i < CHAT_PURGE_MAX_BATCHES; i += 1) {
      const batch = await prisma.chatMessage.findMany({
        where: { createdAt: { lt: chatCutoff } },
        select: { id: true },
        take: CHAT_PURGE_BATCH,
      });
      if (batch.length === 0) break;
      const deleted = await prisma.chatMessage.deleteMany({ where: { id: { in: batch.map((m) => m.id) } } });
      chatMessagesPurged += deleted.count;
      if (batch.length < CHAT_PURGE_BATCH) break;
    }
  } catch (error) {
    logger.warn("maintenance.chat_messages_purge_failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  // Leituras individuais de notificação: a janela da central é de 30 dias, então marcas mais
  // antigas que isso nunca mais são consultadas. Não entra no summary (contrato do tick estável).
  // Roda DEPOIS da anonimização (LGPD) e com falha isolada: uma limpeza cosmética nunca pode
  // impedir a anonimização daquele tick (revisão do Órion, 2026-09-30).
  try {
    const readsCutoff = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
    await prisma.notificationRead.deleteMany({ where: { readAt: { lt: readsCutoff } } });
    await prisma.platformNotificationRead.deleteMany({ where: { readAt: { lt: readsCutoff } } });
  } catch (error) {
    logger.warn("maintenance.notification_reads_purge_failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  const summary: MaintenanceTickSummary = {
    inboundEventsPurged: purged.count,
    contactsAnonymized,
    chatMessagesPurged,
  };
  logger.info("maintenance.tick.completed", { ...summary });

  // Admin → Saúde (docs/contratos.md) — mesmo padrão do `billing/tick`: nunca falha o job por
  // isto, só loga se a persistência falhar.
  await recordMaintenanceTickRun(summary, now).catch((error) => {
    logger.warn("maintenance.tick.record_run_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
  });

  return summary;
}
