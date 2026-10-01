import { getPrisma } from "@/lib/db/prisma";
import { formatPhoneDisplay } from "@/core/platform-whatsapp/rules";
import type { AdminNotification } from "./types";

/**
 * Itens do sino do Admin sobre o WhatsApp da plataforma (docs/regua-de-cobranca.md §2.4), DERIVADOS do
 * estado (mesmo desenho do resto de `platform-notifications`, sem tabela de notificação):
 *
 * - `PLATFORM_WHATSAPP_MISSING`: chave geral ligada e nenhuma conexão ACTIVE. Vale enquanto durar o
 *   estado (fora da janela de 30 dias, como `TICK_LATE`). Data = o que for mais recente entre a hora em
 *   que o admin ligou a chave e a última aposentadoria de número. Mostra quantos avisos foram pulados
 *   nas últimas 24 h por falta de número.
 * - `PLATFORM_WHATSAPP_DISCONNECTED`: número ativo caído. Id com o instante da queda: cada nova queda
 *   volta como não lida.
 * - `PLATFORM_WHATSAPP_REPLY`: um assinante respondeu ao número. Um item por mensagem (linha de
 *   `ProviderEvent` gravada pelo webhook próprio).
 */

type Item = Omit<AdminNotification, "read">;

const DAY_MS = 24 * 60 * 60 * 1000;
const SOURCE_CAP = 100;

export async function loadPlatformWhatsappItems(now: Date, from: Date): Promise<Item[]> {
  const prisma = getPrisma();
  const [settings, active, lastRetired, lastEnabled, replies] = await Promise.all([
    prisma.platformSettings.findUnique({ where: { id: 1 }, select: { platformWhatsappEnabled: true } }),
    prisma.platformWhatsappConnection.findFirst({ where: { role: "ACTIVE" }, select: { id: true, label: true, status: true, phoneE164: true, disconnectedAt: true } }),
    prisma.platformWhatsappConnection.findFirst({ where: { role: "RETIRED", activatedAt: { not: null } }, orderBy: { retiredAt: "desc" }, select: { retiredAt: true } }),
    prisma.providerEvent.findFirst({ where: { provider: "platform-whatsapp-enabled" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.providerEvent.findMany({
      where: { provider: "platform-whatsapp-reply", createdAt: { gte: from } },
      orderBy: { createdAt: "desc" },
      take: SOURCE_CAP,
      select: { id: true, createdAt: true, payload: true },
    }),
  ]);

  const items: Item[] = [];

  if (settings?.platformWhatsappEnabled && !active) {
    const candidates = [lastRetired?.retiredAt, lastEnabled?.createdAt].filter((d): d is Date => d instanceof Date);
    const since = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : now;
    const skipped = await prisma.billingNotice.count({
      where: { channel: "WHATSAPP", status: "SKIPPED", skippedReason: "NO_PLATFORM_NUMBER", updatedAt: { gte: new Date(now.getTime() - DAY_MS) } },
    });
    items.push({
      id: `pwa:missing:${since.getTime()}`,
      kind: "PLATFORM_WHATSAPP_MISSING",
      severity: "warning",
      title: "WhatsApp de cobrança sem número",
      body: `Os avisos de cobrança estão indo só por e-mail e pelo painel. Conecte um número em Configurações.${skipped > 0 ? ` ${skipped} aviso(s) de WhatsApp foram pulados nas últimas 24 horas.` : ""}`,
      href: "/admin/configuracoes",
      createdAt: since.toISOString(),
    });
  }

  if (active && active.status === "DISCONNECTED" && active.disconnectedAt) {
    items.push({
      id: `pwa:down:${active.id}:${active.disconnectedAt.getTime()}`,
      kind: "PLATFORM_WHATSAPP_DISCONNECTED",
      severity: "danger",
      title: "WhatsApp de cobrança caiu",
      body: `O número ${formatPhoneDisplay(active.phoneE164) ?? active.label} saiu do ar. Leia o QR de novo em Configurações. Enquanto isso, os avisos críticos esperam até 12 horas.`,
      href: "/admin/configuracoes",
      createdAt: active.disconnectedAt.toISOString(),
    });
  }

  for (const reply of replies) {
    const payload = reply.payload && typeof reply.payload === "object" ? (reply.payload as Record<string, unknown>) : {};
    const who =
      typeof payload.tenantName === "string" && payload.tenantName
        ? payload.tenantName
        : typeof payload.from === "string" && payload.from
          ? payload.from
          : "Um assinante";
    const preview = typeof payload.preview === "string" ? payload.preview : "";
    const optOut = payload.optOut === true;
    items.push({
      id: `pwa:reply:${reply.id}`,
      kind: "PLATFORM_WHATSAPP_REPLY",
      severity: optOut ? "info" : "warning",
      title: optOut ? "Assinante pediu para sair dos avisos" : "Assinante respondeu no WhatsApp de cobrança",
      body: optOut ? `${who} respondeu SAIR e não recebe mais avisos por WhatsApp.` : `${who} respondeu: "${preview}"`,
      href: "/admin/empresas",
      createdAt: reply.createdAt.toISOString(),
    });
  }

  return items;
}
