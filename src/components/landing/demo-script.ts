import { addDays } from "date-fns";
import { renderMessage } from "@/core/bot/engine/render";
import type { Block, OptionV2 } from "@/core/bot/engine/types";
import { DEFAULT_BOT_TEXTS_V2 } from "@/core/bot/texts-v2";
import { formatDayLabel, formatLeadLabel, formatLongDayLabel } from "@/core/bot/format";

/**
 * Roteiro da demonstração do celular na landing. As mensagens do BOT não são escritas aqui: saem
 * do próprio renderizador do bot v2 (`renderMessage`) alimentado com os textos padrão
 * (`DEFAULT_BOT_TEXTS_V2`), então a conversa mostrada é a que o cliente recebe de verdade — a
 * única coisa fictícia são os dados (empresa, cliente, serviço, datas).
 *
 * Datas relativas a "agora" no fuso de São Paulo, para o exemplo nunca parecer velho.
 */
export type DemoMessage = {
  id: string;
  from: "client" | "bot";
  text: string;
  time: string;
  /** Legenda de contexto acima da mensagem (ex.: o lembrete sai no dia anterior). */
  note?: string;
};

const TZ = "America/Sao_Paulo";
const COMPANY = "Studio Bella";
const CLIENT = "Camila";
const SERVICE = "Corte feminino";
const PROFESSIONAL = "Ana";

function opts(items: { title: string; detail?: string }[]): OptionV2[] {
  return items.map((item, index) => ({
    n: index + 1,
    id: `demo-${index + 1}`,
    title: item.title,
    detail: item.detail ?? null,
    label: item.title,
  })) as OptionV2[];
}

function render(blocks: Block[]): string {
  return renderMessage(blocks, DEFAULT_BOT_TEXTS_V2);
}

/** Próximos 3 dias úteis (sem domingo) a partir de amanhã. */
function nextDays(now: Date): Date[] {
  const days: Date[] = [];
  let cursor = addDays(now, 1);
  while (days.length < 3) {
    if (formatDayLabel(cursor, TZ).startsWith("Dom")) {
      cursor = addDays(cursor, 1);
      continue;
    }
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function buildDemoScript(now: Date = new Date()): DemoMessage[] {
  const days = nextDays(now);
  const chosen = days[0];
  const dayOptions = days.map((d) => ({ title: formatDayLabel(d, TZ) }));
  const dataLonga = formatLongDayLabel(chosen, TZ);
  const hora = "14:00";
  const vars = { nome: CLIENT, empresa: COMPANY };

  return [
    { id: "m1", from: "client", text: "oi", time: "09:41" },
    {
      id: "m2",
      from: "bot",
      time: "09:41",
      text: render([
        { key: "GREETING", vars },
        {
          key: "MENU_PROMPT",
          vars,
          options: opts([{ title: "Agendar horário" }, { title: "Meus agendamentos" }, { title: "Falar com atendente" }]),
          footer: "MENU_HINT",
        },
      ]),
    },
    { id: "m3", from: "client", text: "1", time: "09:42" },
    {
      id: "m4",
      from: "bot",
      time: "09:42",
      text: render([
        {
          key: "CHOOSE_SERVICE",
          vars,
          options: opts([
            { title: "Corte feminino", detail: "40 min" },
            { title: "Escova modelada", detail: "45 min" },
            { title: "Coloração", detail: "1h30" },
          ]),
          footer: "FOOTER_HINT",
        },
      ]),
    },
    { id: "m5", from: "client", text: "1", time: "09:42" },
    {
      id: "m6",
      from: "bot",
      time: "09:42",
      text: render([
        {
          key: "CHOOSE_DAY",
          vars: { ...vars, servico: SERVICE, profissional: PROFESSIONAL },
          options: opts([...dayOptions, { title: "Ver mais datas" }]),
          footer: "FOOTER_HINT",
        },
      ]),
    },
    { id: "m7", from: "client", text: "1", time: "09:43" },
    {
      id: "m8",
      from: "bot",
      time: "09:43",
      text: render([
        {
          key: "CHOOSE_TIME",
          vars: { ...vars, servico: SERVICE, profissional: PROFESSIONAL, data: dataLonga },
          options: opts([{ title: "09:00" }, { title: "10:30" }, { title: "14:00" }, { title: "16:30" }]),
          footer: "FOOTER_HINT",
        },
      ]),
    },
    { id: "m9", from: "client", text: "3", time: "09:43" },
    {
      id: "m10",
      from: "bot",
      time: "09:43",
      text: render([
        {
          key: "CONFIRM_SUMMARY",
          vars: {
            ...vars,
            servico: SERVICE,
            profissional: PROFESSIONAL,
            data_longa: dataLonga,
            hora,
            duracao: "40 min",
            preco: "R$ 80,00",
          },
          options: opts([{ title: "Confirmar" }, { title: "Corrigir dados" }]),
          footer: "FOOTER_HINT",
        },
      ]),
    },
    { id: "m11", from: "client", text: "1", time: "09:44" },
    {
      id: "m12",
      from: "bot",
      time: "09:44",
      text: render([
        {
          key: "BOOKED",
          vars: {
            ...vars,
            servico: SERVICE,
            profissional: PROFESSIONAL,
            data_longa: dataLonga,
            hora,
            prazo: formatLeadLabel(24 * 60),
          },
        },
      ]),
    },
    {
      id: "m13",
      from: "bot",
      time: "09:00",
      note: "No dia anterior, sem ninguém digitar nada",
      text: render([
        { key: "REMINDER", vars: { ...vars, servico: SERVICE, profissional: PROFESSIONAL, quando: "amanhã", hora } },
      ]),
    },
  ];
}
