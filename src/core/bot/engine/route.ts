import type { Intent, Route } from "./types";

/** Estados de que uma sessão expirada pode ser retomada (spec §2.7). */
const RESUMABLE_STATES = [
  "SELECT_PROFESSIONAL",
  "SELECT_DAY",
  "NEXT_SLOTS",
  "SELECT_TIME",
  "ASK_NAME",
  "CONFIRM",
  "CONFIRM_EDIT",
];

/** `previous` do claim v2 é retomável se o estado é de agendamento e há serviço escolhido. */
export function isResumable(previous: { state: string; context: unknown } | null): boolean {
  if (!previous || !RESUMABLE_STATES.includes(previous.state)) return false;
  const ctx = previous.context;
  if (!ctx || typeof ctx !== "object") return false;
  const serviceId = (ctx as Record<string, unknown>).serviceId;
  return typeof serviceId === "string" && serviceId.length > 0;
}

type RouteResult = { route: Route; invalidCount: number; greet: boolean };

function result(route: Route, invalidCount: number, greet = false): RouteResult {
  return { route, invalidCount, greet };
}

/**
 * Decide a rota do Switch "Rota" do fluxo (spec §2.4.1 regra 2, §2.4.3).
 *
 * - `fresh` (sessão nova, expirada ou voltando do humano): "menu"/"0" → FRESH (descartam a
 *   retomada); saudação ou qualquer outra coisa com retomada possível → RESUME; senão a
 *   mensagem foi avaliada contra o MAIN_MENU (o chamador chama `interpret` com
 *   `state = "MAIN_MENU"`): opção → STATE direto (corrige BUG-13); nada casou → FRESH com
 *   saudação, sem contar inválido. Pedido de atendente e "sair" nunca são engolidos pela oferta
 *   de retomada.
 * - Fora disso: comandos zeram `invalidCount`; inválido soma; a 2ª seguida é INVALID_2 e zera.
 * - `name_invalid` devolve STATE (o ramo de ASK_NAME escolhe NAME_INVALID/NAME_TOO_LONG pelo
 *   `reason`) mas conta como inválido; na 2ª seguida vira INVALID_2.
 * - Mídia e ambígua não contam e mantêm o `invalidCount`.
 */
export function routeFor(input: {
  intent: Intent;
  state: string;
  invalidCount: number;
  fresh: boolean;
  resumable: boolean;
}): RouteResult {
  const { intent, state, fresh, resumable } = input;
  const count = input.invalidCount;

  if (intent.kind === "media") return result("MEDIA", count);

  if (fresh) {
    if (intent.kind === "command") {
      switch (intent.command) {
        case "HUMAN": return result("CMD_HUMAN", 0);
        case "EXIT": return result("CMD_EXIT", 0);
        case "HELP": return result("CMD_HELP", 0);
        case "MENU":
          return result("FRESH", 0, true);
        case "GREETING":
          // "oi" com retomada possível oferece continuar (CA-27); só "menu"/"0" descartam a retomada.
          return resumable ? result("RESUME", 0, true) : result("FRESH", 0, true);
        default:
          break;
      }
    }
    if (resumable) return result("RESUME", 0, true);
    if (intent.kind === "option" || intent.kind === "date" || intent.kind === "time" || intent.kind === "period") {
      return result("STATE", 0);
    }
    if (intent.kind === "ambiguous") return result("AMBIGUOUS", 0);
    return result("FRESH", 0, true);
  }

  switch (intent.kind) {
    case "command":
      switch (intent.command) {
        case "MENU": return result("CMD_MENU", 0);
        case "BACK": return result("CMD_BACK", 0);
        case "EXIT": return result("CMD_EXIT", 0);
        case "HUMAN": return result("CMD_HUMAN", 0);
        case "HELP": return result("CMD_HELP", 0);
        case "GREETING":
          return state === "MAIN_MENU" ? result("CMD_MENU", 0, true) : result("CMD_CONTINUE", 0);
        case "THANKS":
          return state === "POST_ACTION" || state === "MAIN_MENU"
            ? result("CMD_THANKS", 0)
            : result("REPROMPT", 0);
      }
      return result("REPROMPT", 0);
    case "ambiguous":
      return result("AMBIGUOUS", count);
    case "name_invalid":
      return count + 1 >= 2 ? result("INVALID_2", 0) : result("STATE", count + 1);
    case "invalid":
      return count + 1 >= 2 ? result("INVALID_2", 0) : result("INVALID_1", count + 1);
    default:
      return result("STATE", 0);
  }

}
