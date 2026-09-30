/**
 * Tipos do motor do bot v2 (plano §3.2). Sem imports fora desta pasta: o motor é compilado
 * em IIFE e colado nos Code nodes do n8n (`Interpretar` e `Montar mensagem`).
 */

export type Vars = Record<string, string | number | null | undefined>;
export type Texts = Record<string, string>;
export type EngineClock = {
  /** YYYY-MM-DD no fuso do tenant. */
  today: string;
  /** HH:mm no fuso do tenant. */
  nowLocal: string;
};
export type OptionV2 = {
  n: number;
  id: string;
  title: string;
  detail?: string | null;
  match?: string;
  aliases?: string[];
  /**
   * Igual a `title`. Gravado no context para o Interpretar v1 ler a sessão se o fluxo for
   * revertido (plano §5.3). `buildOptions` sempre preenche.
   */
  label?: string;
};
export type LegacyOption = { n: number; id: string; label: string };
export type Period = "morning" | "afternoon" | "evening";
export type ParsedInput = {
  raw: string;
  norm: string;
  number: number | null;
  date: string | null;
  time: string | null;
  period: Period | null;
  yes: boolean;
  no: boolean;
};
export type Command = "MENU" | "BACK" | "EXIT" | "HUMAN" | "HELP" | "GREETING" | "THANKS";
export type Intent =
  | { kind: "media" }
  | { kind: "command"; command: Command }
  | { kind: "option"; option: OptionV2; via: "number" | "alias" | "text" }
  | { kind: "ambiguous"; candidates: OptionV2[] }
  | { kind: "date"; date: string; time: string | null }
  | { kind: "time"; time: string }
  | { kind: "period"; period: Period }
  | { kind: "name"; name: string }
  | { kind: "name_invalid"; reason: "TOO_LONG" | "INVALID" }
  | { kind: "invalid" };
export type Route =
  | "MEDIA"
  | "CMD_MENU"
  | "CMD_BACK"
  | "CMD_EXIT"
  | "CMD_HUMAN"
  | "CMD_HELP"
  | "CMD_CONTINUE"
  | "CMD_THANKS"
  | "REPROMPT"
  | "INVALID_1"
  | "INVALID_2"
  | "AMBIGUOUS"
  | "FRESH"
  | "RESUME"
  | "STATE";
export type Block = {
  key: string;
  vars?: Vars;
  options?: OptionV2[];
  footer?: "MENU_HINT" | "FOOTER_HINT";
  /**
   * Este bloco abre uma NOVA mensagem do WhatsApp (o envio faz um POST por mensagem, em ordem).
   * Os blocos seguintes ficam nela até o próximo `newMessage`. No primeiro bloco não tem efeito.
   */
  newMessage?: boolean;
};
