/**
 * Regras puras do Pixel do Meta (sem I/O, seguras para o servidor e para o navegador).
 * O mesmo validador roda no formulário do Admin e na gravação, e o ID só chega ao HTML público
 * depois de passar por aqui: o que entra num `<script>` precisa ser, sem exceção, só dígitos.
 */

/** ID do Pixel (Gerenciador de Eventos): só dígitos, 5 a 20 (o comum hoje tem 15 ou 16). */
const PIXEL_ID_RE = /^\d{5,20}$/;

export function isValidPixelId(value: string): boolean {
  return PIXEL_ID_RE.test(value);
}

/** Tira espaços e aceita o ID colado com pontos ou espaços no meio; devolve `""` se sobrar algo que não é dígito. */
export function normalizePixelId(raw: string): string {
  const compact = raw.replace(/[\s.]/g, "");
  return /^\d*$/.test(compact) ? compact : "";
}

/** Código do "Testar eventos" (ex.: TEST12345). Só letras e números, até 40. */
const TEST_CODE_RE = /^[A-Za-z0-9]{1,40}$/;

export function isValidTestEventCode(value: string): boolean {
  return TEST_CODE_RE.test(value);
}

/** Id de evento (dedup navegador x servidor): só o que um UUID ou um token curto usa. */
const EVENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidMetaEventId(value: unknown): value is string {
  return typeof value === "string" && EVENT_ID_RE.test(value);
}

/** Nomes de evento padrão que este sistema usa. */
export type MetaEventName = "PageView" | "Lead" | "CompleteRegistration" | "Purchase";
