import { forTenant } from "@/lib/db/tenant-client";
import { queryContactsWithStats, type ContactFilter, type ContactStatsRow } from "@/lib/db/contact-queries";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { DomainError } from "@/lib/errors";
import {
  normalizePhoneFromJid,
  parseBrazilianPhoneToE164,
  phoneE164ToLikelyWhatsappJid,
  whatsappJidCandidatesForPhone,
} from "@/core/whatsapp/phone";

const ANON_WAJID_PREFIX = "anon:";
const PANEL_JID_SUFFIX = "@panel.local";
const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;
const APPOINTMENTS_HISTORY_LIMIT = 50;

export type { ContactFilter };

export type ContactSource = "WHATSAPP" | "PANEL";

export type ContactListItem = {
  id: string;
  displayName: string;
  name: string | null;
  pushName: string | null;
  phoneE164: string | null;
  source: ContactSource;
  appointmentsCount: number;
  noShowCount: number;
  lastAppointmentAt: string | null;
  nextAppointmentAt: string | null;
  botPaused: boolean;
  createdAt: string;
};

export type ContactAppointmentRow = {
  id: string;
  startsAt: string;
  serviceName: string;
  professionalName: string;
  status: "SCHEDULED" | "CANCELED" | "COMPLETED" | "NO_SHOW";
  source: "WHATSAPP" | "PANEL";
};

export type ContactDetail = ContactListItem & {
  notes: string | null;
  botPausedUntil: string | null;
  appointments: ContactAppointmentRow[];
};

/**
 * `source` é derivado inteiramente da FORMA do `waJid` — não existe (nem foi pedido) um campo
 * separado de "origem de cadastro". Consequência que vale registrar: um `Contact` criado por
 * `createContact` (painel, telefone real) recebe de propósito um `waJid` no formato
 * `@s.whatsapp.net` (ver `phoneE164ToLikelyWhatsappJid`, `core/whatsapp/phone.ts`) — para não
 * duplicar quando esse cliente mandar a primeira mensagem — e por isso aparece como
 * `source: "WHATSAPP"` mesmo tendo sido cadastrado manualmente. Só o padrão antigo
 * `@panel.local` (cadastro embutido em `createAppointmentAction` sem telefone, ou telefone ainda
 * não confirmado) aparece como `"PANEL"`. Ver PENDÊNCIAS no handoff da Vega.
 */
function contactSource(waJid: string): ContactSource {
  return waJid.endsWith(PANEL_JID_SUFFIX) ? "PANEL" : "WHATSAPP";
}

function isAnonymized(waJid: string): boolean {
  return waJid.startsWith(ANON_WAJID_PREFIX);
}

/**
 * Fallback de exibição só para nome — telefone formatado (padrão BR simples). Duplica
 * intencionalmente um recorte da formatação de `src/components/lib/format-phone.ts`: módulos de
 * domínio não importam de `src/components/` (docs/arquitetura.md §10, "app → modules → core"),
 * então este helper local e pequeno é o preço dessa separação de camadas.
 */
function formatPhoneForDisplayName(phoneE164: string): string {
  const digits = phoneE164.replace(/^\+/, "");
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    const middle = rest.length === 9 ? rest.slice(0, 5) : rest.slice(0, 4);
    const end = rest.length === 9 ? rest.slice(5) : rest.slice(4);
    return `(${ddd}) ${middle}-${end}`;
  }
  return `+${digits}`;
}

function computeDisplayName(name: string | null, pushName: string | null, phoneE164: string | null): string {
  if (name) return name;
  if (pushName) return pushName;
  if (phoneE164) return formatPhoneForDisplayName(phoneE164);
  return "Cliente sem nome";
}

function toListItem(row: ContactStatsRow, now: Date): ContactListItem {
  return {
    id: row.id,
    displayName: computeDisplayName(row.name, row.pushName, row.phoneE164),
    name: row.name,
    pushName: row.pushName,
    phoneE164: row.phoneE164,
    source: contactSource(row.waJid),
    appointmentsCount: row.appointmentsCount,
    noShowCount: row.noShowCount,
    lastAppointmentAt: row.lastAppointmentAt?.toISOString() ?? null,
    nextAppointmentAt: row.nextAppointmentAt?.toISOString() ?? null,
    botPaused: !!row.botPausedUntil && row.botPausedUntil > now,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Cursor opaco = offset numérico em base64 — NÃO é um keyset cursor de verdade. A ordenação
 * pedida (próximo agendamento primeiro, depois mais recente) é dinâmica demais para uma chave de
 * corte estável sem materializar as colunas agregadas; para o volume de uma lista de clientes de
 * uma empresa (painel administrativo, não feed público de alto tráfego), o custo de OFFSET é
 * aceitável. Risco conhecido e aceito: inserções/remoções concorrentes ENQUANTO o usuário pagina
 * podem pular ou repetir uma linha — nunca vazam dados de outro tenant nem geram erro.
 */
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf-8").toString("base64");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = Number(Buffer.from(cursor, "base64").toString("utf-8"));
  if (!Number.isInteger(decoded) || decoded < 0) {
    throw new DomainError("INVALID_PAYLOAD", "Cursor de paginação inválido.");
  }
  return decoded;
}

export async function listContacts(
  tenantId: string,
  params: { q?: string; filter?: ContactFilter; cursor?: string; limit?: number },
): Promise<{ items: ContactListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const offset = decodeCursor(params.cursor);
  const now = new Date();

  const { rows, hasMore } = await queryContactsWithStats({
    tenantId,
    q: params.q,
    filter: params.filter ?? "all",
    offset,
    limit,
    now,
  });

  return {
    items: rows.map((row) => toListItem(row, now)),
    nextCursor: hasMore ? encodeCursor(offset + limit) : null,
  };
}

async function loadOwnedContact(tenantId: string, id: string) {
  const contact = await forTenant(tenantId).contact.findFirst({ where: { id } });
  if (!contact || isAnonymized(contact.waJid)) {
    throw new DomainError("NOT_FOUND", "Cliente não encontrado.");
  }
  return contact;
}

export async function getContact(tenantId: string, id: string): Promise<ContactDetail> {
  const now = new Date();
  const contact = await loadOwnedContact(tenantId, id);

  const [{ rows }, appointments] = await Promise.all([
    queryContactsWithStats({ tenantId, filter: "all", offset: 0, limit: 1, now, q: undefined }).then((result) => ({
      rows: result.rows.filter((row) => row.id === id),
    })),
    forTenant(tenantId).appointment.findMany({
      where: { contactId: id },
      include: { service: true, professional: true },
      orderBy: { startsAt: "desc" },
      take: APPOINTMENTS_HISTORY_LIMIT,
    }),
  ]);

  // Contato existe (confirmado por `loadOwnedContact`) mas pode não ter nenhuma linha agregada
  // ainda (nunca teve agendamento) — nesse caso monta o item com zeros, sem outra ida ao banco.
  const statsRow: ContactStatsRow =
    rows[0] ??
    ({
      id: contact.id,
      name: contact.name,
      pushName: contact.pushName,
      phoneE164: contact.phoneE164,
      waJid: contact.waJid,
      botPausedUntil: contact.botPausedUntil,
      createdAt: contact.createdAt,
      appointmentsCount: 0,
      noShowCount: 0,
      lastAppointmentAt: null,
      nextAppointmentAt: null,
    } satisfies ContactStatsRow);

  return {
    ...toListItem(statsRow, now),
    notes: contact.notes,
    botPausedUntil: contact.botPausedUntil?.toISOString() ?? null,
    appointments: appointments.map((appt) => ({
      id: appt.id,
      startsAt: appt.startsAt.toISOString(),
      serviceName: appt.service.name,
      professionalName: appt.professional.name,
      status: appt.status,
      source: appt.source,
    })),
  };
}

/**
 * Procura um `Contact` já existente com este telefone — real (WhatsApp, comparando todas as
 * formas plausíveis de `waJid`, ver `whatsappJidCandidatesForPhone`) ou de painel
 * (`phoneE164` exato, único campo em que um contato de painel grava o telefone). Usado tanto na
 * criação (`CONTACT_EXISTS`) quanto ao trocar o telefone de um contato de painel existente.
 */
async function findDuplicateByPhone(tenantId: string, phoneE164: string, excludeId?: string) {
  const candidateJids = whatsappJidCandidatesForPhone(phoneE164);
  return forTenant(tenantId).contact.findFirst({
    where: {
      NOT: { waJid: { startsWith: ANON_WAJID_PREFIX } },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [{ phoneE164 }, { waJid: { in: candidateJids } }],
    },
  });
}

export async function createContact(
  tenantId: string,
  input: { name: string; phone: string; notes?: string },
): Promise<{ id: string }> {
  const phoneE164 = parseBrazilianPhoneToE164(input.phone);
  if (!phoneE164) {
    throw new DomainError("INVALID_PAYLOAD", "Telefone inválido. Use um número de celular brasileiro com DDD.");
  }

  const duplicate = await findDuplicateByPhone(tenantId, phoneE164);
  if (duplicate) {
    throw new DomainError("CONTACT_EXISTS", "Já existe um cliente cadastrado com esse telefone.", {
      contactId: duplicate.id,
    });
  }

  const waJid = phoneE164ToLikelyWhatsappJid(phoneE164);
  try {
    const created = await forTenant(tenantId).contact.create({
      data: { tenantId, waJid, phoneE164, name: input.name, notes: input.notes ?? null },
    });
    return { id: created.id };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Corrida rara: outra requisição criou o MESMO waJid entre o check acima e este create —
      // a constraint única (tenantId, waJid) é o backstop final (mesmo padrão de claim.ts).
      const existing = await forTenant(tenantId).contact.findFirst({ where: { waJid } });
      if (existing) {
        throw new DomainError("CONTACT_EXISTS", "Já existe um cliente cadastrado com esse telefone.", {
          contactId: existing.id,
        });
      }
    }
    throw error;
  }
}

export async function updateContact(
  tenantId: string,
  id: string,
  input: { name?: string; phone?: string; notes?: string },
): Promise<{ id: string }> {
  const contact = await loadOwnedContact(tenantId, id);

  let phoneUpdate: { phoneE164: string; waJid: string } | undefined;
  if (input.phone !== undefined) {
    // O `waJid` É a identidade de um contato que já tem cara de WhatsApp real (mesmo que tenha
    // sido só uma adivinhança na criação, ver comentário de `contactSource` acima) — trocar o
    // telefone sem trocar o `waJid` junto faria o bot nunca mais casar a próxima mensagem deste
    // cliente com este `Contact`. Só permite editar o telefone de um contato ainda `@panel.local`
    // (nunca teve telefone "comprometido" com um `waJid` de WhatsApp).
    if (contactSource(contact.waJid) === "WHATSAPP") {
      throw new DomainError("PHONE_LOCKED", "O telefone deste cliente veio do WhatsApp e não pode ser alterado por aqui.");
    }

    const phoneE164 = parseBrazilianPhoneToE164(input.phone);
    if (!phoneE164) {
      throw new DomainError("INVALID_PAYLOAD", "Telefone inválido. Use um número de celular brasileiro com DDD.");
    }
    const duplicate = await findDuplicateByPhone(tenantId, phoneE164, id);
    if (duplicate) {
      throw new DomainError("CONTACT_EXISTS", "Já existe um cliente cadastrado com esse telefone.", {
        contactId: duplicate.id,
      });
    }
    phoneUpdate = { phoneE164, waJid: phoneE164ToLikelyWhatsappJid(phoneE164) };
  }

  const updated = await forTenant(tenantId).contact.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(phoneUpdate ?? {}),
      ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
    },
  });
  return { id: updated.id };
}

const INDEFINITE_PAUSE_YEARS = 100;

export async function setContactBotPaused(
  tenantId: string,
  id: string,
  input: { paused: boolean; hours?: number },
): Promise<{ botPausedUntil: string | null }> {
  await loadOwnedContact(tenantId, id);

  if (!input.paused) {
    // Retomar zera tanto o `Contact.botPausedUntil` quanto o `humanUntil` das `ChatSession` deste
    // contato — sem isso, uma sessão em modo humano continuaria ignorando o bot até o prazo
    // antigo mesmo com o cliente "retomado" no painel.
    const db = forTenant(tenantId);
    await db.$transaction([
      db.contact.update({ where: { id }, data: { botPausedUntil: null } }),
      db.chatSession.updateMany({ where: { contactId: id }, data: { humanUntil: null, state: "MAIN_MENU" } }),
      // Bot v2: "Retomar bot" também encerra o pedido de atendente aberto (some do "em atendimento").
      db.handoffRequest.updateMany({ where: { contactId: id, endedAt: null }, data: { endedAt: new Date(), endReason: "PANEL_RESUME" } }),
    ]);
    return { botPausedUntil: null };
  }

  const now = new Date();
  const botPausedUntil =
    input.hours && input.hours > 0
      ? new Date(now.getTime() + input.hours * 60 * 60 * 1000)
      : new Date(now.getTime() + INDEFINITE_PAUSE_YEARS * 365 * 24 * 60 * 60 * 1000);

  await forTenant(tenantId).contact.update({ where: { id }, data: { botPausedUntil } });
  return { botPausedUntil: botPausedUntil.toISOString() };
}

export async function deleteContact(tenantId: string, id: string): Promise<{ mode: "deleted" | "anonymized" }> {
  const contact = await loadOwnedContact(tenantId, id);

  // LGPD: o histórico de conversas do cliente some em qualquer dos dois caminhos (o cascade do
  // banco já cobriria a exclusão, mas na anonimização a linha do contato permanece).
  await forTenant(tenantId).chatMessage.deleteMany({ where: { contactId: id } });

  const appointmentsCount = await forTenant(tenantId).appointment.count({ where: { contactId: id } });
  if (appointmentsCount === 0) {
    await forTenant(tenantId).contact.delete({ where: { id } });
    return { mode: "deleted" };
  }

  // Mesmo padrão de `src/modules/maintenance/tick.ts` (LGPD, anonimização em lote): mantém a
  // linha (preserva o histórico de `Appointment`), zera dado pessoal, marca o `waJid` com o
  // prefixo reconhecido em toda a base (`ANON_WAJID_PREFIX`) para nunca mais aparecer em listagem
  // nem em busca por duplicidade.
  await forTenant(tenantId).contact.update({
    where: { id },
    data: {
      waJid: `${ANON_WAJID_PREFIX}${contact.id}`,
      phoneE164: null,
      lid: null,
      name: null,
      pushName: null,
      notes: null,
      botPausedUntil: null,
    },
  });
  return { mode: "anonymized" };
}

const CSV_EXPORT_LIMIT = 5000;

/**
 * Escapa um campo do CSV e neutraliza injeção de fórmula (revisão do Órion, 2026-09-29): o
 * `pushName` vem do perfil de WhatsApp de qualquer pessoa, sem validação. Um nome como
 * `=HYPERLINK(...)` viraria fórmula ao abrir no Excel. Prefixar com apóstrofo faz a planilha
 * tratar o valor como texto.
 */
function csvEscape(raw: string): string {
  const value = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[";\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export async function exportContactsCsv(tenantId: string): Promise<{ filename: string; csv: string }> {
  const now = new Date();
  const header = ["Nome", "Telefone", "Agendamentos", "Faltas", "Último", "Próximo", "Criado em"];
  const lines = [header.join(";")];

  let offset = 0;
  // Reaproveita a mesma consulta paginada da listagem (nunca um `SELECT *` sem limite) — em
  // páginas de `MAX_LIST_LIMIT`, até `CSV_EXPORT_LIMIT` clientes por exportação.
  while (offset < CSV_EXPORT_LIMIT) {
    const { rows, hasMore } = await queryContactsWithStats({
      tenantId,
      filter: "all",
      offset,
      limit: MAX_LIST_LIMIT,
      now,
      q: undefined,
    });
    for (const row of rows) {
      const item = toListItem(row, now);
      lines.push(
        [
          csvEscape(item.displayName),
          csvEscape(item.phoneE164 ?? ""),
          String(item.appointmentsCount),
          String(item.noShowCount),
          item.lastAppointmentAt ?? "",
          item.nextAppointmentAt ?? "",
          item.createdAt,
        ].join(";"),
      );
    }
    if (!hasMore) break;
    offset += MAX_LIST_LIMIT;
  }

  // BOM UTF-8 (`﻿`) na frente — sem isso o Excel pt-BR abre acentos quebrados.
  const csv = `﻿${lines.join("\r\n")}`;
  const filename = `clientes-${now.toISOString().slice(0, 10)}.csv`;
  return { filename, csv };
}

// Reexportado para o resto do domínio (ex.: um futuro merge com contatos criados pelo bot) poder
// checar "este telefone já bate com um waJid conhecido" sem duplicar a lógica.
export { normalizePhoneFromJid };
