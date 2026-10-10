/**
 * Máscara de digitação do WhatsApp brasileiro: "(84) 99999-8888" (celular) ou "(84) 3113-2584" (fixo).
 * Só apresentação — quem decide se o número vale é `normalizeBrPhoneToE164`. Se a pessoa colar um
 * número com +55, o DDI é descartado antes de formatar.
 */
export function maskBrPhone(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+55") && digits.length > 11) digits = digits.slice(2);
  digits = digits.slice(0, 11);
  if (digits.length === 0) return "";
  if (digits.length <= 2) return `(${digits}`;
  const ddd = digits.slice(0, 2);
  const rest = digits.slice(2);
  if (rest.length <= 4) return `(${ddd}) ${rest}`;
  if (digits.length <= 10) return `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  return `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
}
