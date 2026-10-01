import { DIREITOS_RESERVADOS } from "@/lib/app-info";

/**
 * Layout base dos e-mails transacionais do InnoChat — HTML "email-safe": tabelas, estilos
 * inline, 600px fluido no celular, fontes do sistema, botão à prova de balas (VML para o
 * Outlook desktop), preheader oculto e dark mode (`color-scheme` + `prefers-color-scheme` para
 * Apple Mail/iOS/Outlook.com; o Gmail inverte sozinho, por isso o cabeçalho já é escuro e o
 * botão azul mantém contraste nos dois modos).
 *
 * TODO dado dinâmico passa por `esc()` — nome de empresa, URL, código Pix. Nunca concatene
 * texto vindo de fora sem escapar (XSS/injeção de HTML no e-mail).
 */

/** Dados de marca/jurídicos resolvidos em runtime (ver `context.ts`). Tudo opcional: sem base URL, o logo vira texto. */
export type EmailContext = {
  /** `PlatformSettings.publicBaseUrl`/cabeçalhos — base das imagens `/marca/*` e dos links `/termos`, `/privacidade`. */
  baseUrl?: string | null;
  /** Empresa operadora (razão social e CNPJ); campo vazio é omitido do rodapé. */
  legal?: { companyLegalName?: string | null; companyCnpj?: string | null } | null;
};

export const EMAIL_COLORS = {
  navy: "#0b1e46",
  primary: "#2563eb",
  pageBg: "#eef2f8",
  card: "#ffffff",
  title: "#0f172a",
  text: "#334155",
  muted: "#64748b",
  box: "#f1f5f9",
  border: "#e2e8f0",
} as const;

const C = EMAIL_COLORS;
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
const MONO = "SFMono-Regular,Menlo,Consolas,'Liberation Mono','Courier New',monospace";
const OPERATOR_URL = "https://innovarecode.com.br";

export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Só http(s) vira `href`; qualquer outra coisa (javascript:, data:) cai em "#". */
function safeHref(url: string): string {
  return /^https?:\/\//i.test(url.trim()) ? esc(url.trim()) : "#";
}

function withBase(ctx: EmailContext, path: string): string | null {
  const base = ctx.baseUrl?.trim().replace(/\/+$/, "");
  return base && /^https?:\/\//i.test(base) ? `${base}${path}` : null;
}

// ---------------------------------------------------------------------------
// Blocos de conteúdo (cada um devolve uma <tr> pronta para o card)
// ---------------------------------------------------------------------------

export function heading(text: string): string {
  return `<tr><td class="em-title" style="padding:0 0 12px 0;font-family:${FONT};font-size:24px;line-height:30px;font-weight:700;color:${C.title};">${esc(text)}</td></tr>`;
}

export function paragraph(text: string): string {
  const html = esc(text).replace(/\n/g, "<br>");
  return `<tr><td class="em-text" style="padding:0 0 16px 0;font-family:${FONT};font-size:16px;line-height:25px;color:${C.text};">${html}</td></tr>`;
}

/** Botão à prova de balas: VML no Outlook desktop, `<a>` com padding e fundo nos demais. */
export function button(url: string, label: string): string {
  const href = safeHref(url);
  const width = Math.max(220, label.length * 10 + 56);
  return `<tr><td align="left" style="padding:8px 0 24px 0;">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:50px;v-text-anchor:middle;width:${width}px;" arcsize="16%" stroke="f" fillcolor="${C.primary}"><w:anchorlock/><center style="font-family:Arial,sans-serif;font-size:16px;font-weight:bold;color:#ffffff;">${esc(label)}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${C.primary}" style="border-radius:8px;background-color:${C.primary};"><a href="${href}" target="_blank" class="em-btn" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;line-height:22px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;background-color:${C.primary};">${esc(label)}</a></td></tr></table><!--<![endif]-->
</td></tr>`;
}

/** Link em texto para quando o botão não funcionar. */
export function fallbackLink(url: string): string {
  const href = safeHref(url);
  return `<tr><td class="em-muted" style="padding:0 0 8px 0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};">Se o botão não funcionar, copie e cole este endereço no navegador:<br><a href="${href}" class="em-link" style="color:${C.primary};word-break:break-all;overflow-wrap:anywhere;">${esc(url)}</a></td></tr>`;
}

export function note(text: string): string {
  return `<tr><td class="em-muted" style="padding:0 0 8px 0;font-family:${FONT};font-size:14px;line-height:22px;color:${C.muted};">${esc(text).replace(/\n/g, "<br>")}</td></tr>`;
}

function boxWrap(inner: string): string {
  return `<tr><td style="padding:0 0 20px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-box" bgcolor="${C.box}" style="background-color:${C.box};border:1px solid ${C.border};border-radius:12px;"><tr><td class="em-boxpad" style="padding:20px 22px;">${inner}</td></tr></table></td></tr>`;
}

function label(text: string): string {
  return `<div class="em-muted" style="font-family:${FONT};font-size:12px;line-height:16px;letter-spacing:0.06em;text-transform:uppercase;font-weight:700;color:${C.muted};">${esc(text)}</div>`;
}

/** "Cartão de fatura": valor em destaque + vencimento (ou outra data). */
export function invoiceCard(params: { tenantName: string; amount: string; dateLabel: string; dateValue: string }): string {
  return boxWrap(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td colspan="2" class="em-muted" style="padding:0 0 14px 0;font-family:${FONT};font-size:14px;line-height:20px;color:${C.muted};">${esc(params.tenantName)}</td></tr>
<tr>
<td valign="top" style="padding:0 12px 0 0;">${label("Valor")}<div class="em-title" style="padding-top:4px;font-family:${FONT};font-size:28px;line-height:34px;font-weight:700;color:${C.title};">${esc(params.amount)}</div></td>
<td valign="top" align="right" style="padding:0;">${label(params.dateLabel)}<div class="em-title" style="padding-top:4px;font-family:${FONT};font-size:18px;line-height:34px;font-weight:700;color:${C.title};">${esc(params.dateValue)}</div></td>
</tr></table>`);
}

/** Linhas "rótulo — valor" (recibo). */
export function factsCard(rows: Array<{ label: string; value: string; strong?: boolean }>): string {
  const trs = rows
    .map((r, i) => {
      const top = i === 0 ? "0" : "10px";
      return `<tr><td class="em-muted" style="padding:${top} 12px 0 0;font-family:${FONT};font-size:14px;line-height:22px;color:${C.muted};">${esc(r.label)}</td><td align="right" class="em-title" style="padding:${top} 0 0 0;font-family:${FONT};font-size:${r.strong ? 18 : 15}px;line-height:22px;font-weight:700;color:${C.title};">${esc(r.value)}</td></tr>`;
    })
    .join("");
  return boxWrap(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${trs}</table>`);
}

/** Pix copia e cola: monoespaçado, quebrável em qualquer largura. */
export function pixBlock(code: string): string {
  return boxWrap(`${label("Pix copia e cola")}
<div class="em-title em-mono" style="margin-top:10px;padding:12px 14px;background-color:#ffffff;border:1px dashed #94a3b8;border-radius:8px;font-family:${MONO};font-size:13px;line-height:19px;color:${C.title};word-break:break-all;overflow-wrap:anywhere;">${esc(code)}</div>
<div class="em-muted" style="padding-top:10px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};">Copie o código acima e cole no app do seu banco, na opção Pix &gt; Pix copia e cola.</div>`);
}

/** O Inno "falando": avatar pequeno + uma frase de apoio. Sem base URL, só a frase. */
export function innoSays(text: string, ctx: EmailContext): string {
  const avatar = withBase(ctx, "/marca/email-inno-avatar.png");
  const img = avatar
    ? `<td valign="middle" width="56" style="padding:0 14px 0 0;"><img src="${esc(avatar)}" width="56" height="56" alt="Inno" style="display:block;width:56px;height:56px;border:0;border-radius:28px;"></td>`
    : "";
  return `<tr><td style="padding:8px 0 8px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-box" bgcolor="${C.box}" style="background-color:${C.box};border-radius:12px;"><tr><td style="padding:14px 16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${img}<td valign="middle" class="em-text" style="font-family:${FONT};font-size:14px;line-height:21px;color:${C.text};"><strong class="em-title" style="color:${C.title};">Inno</strong><br>${esc(text)}</td></tr></table></td></tr></table></td></tr>`;
}

// ---------------------------------------------------------------------------
// Casca (cabeçalho + card + rodapé)
// ---------------------------------------------------------------------------

function footerLegalLine(ctx: EmailContext): string | null {
  const name = ctx.legal?.companyLegalName?.trim();
  const cnpj = ctx.legal?.companyCnpj?.trim();
  const parts = [name, cnpj ? `CNPJ ${cnpj}` : null].filter(Boolean) as string[];
  return parts.length ? parts.join(" · ") : null;
}

const HEAD_CSS = `
:root{color-scheme:light dark;supported-color-schemes:light dark;}
body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
img{-ms-interpolation-mode:bicubic;}
@media (max-width:620px){
  .em-pad{padding:28px 20px !important;}
  .em-boxpad{padding:16px !important;}
  .em-outer{padding:0 !important;}
}
@media (prefers-color-scheme:dark){
  .em-bg{background-color:#0a1020 !important;}
  .em-card{background-color:#111a2e !important;}
  .em-title{color:#f1f5f9 !important;}
  .em-text{color:#cbd5e1 !important;}
  .em-muted{color:#94a3b8 !important;}
  .em-box{background-color:#1a2540 !important;border-color:#2a3a5c !important;}
  .em-mono{background-color:#0f172a !important;border-color:#475569 !important;}
  .em-link{color:#93c5fd !important;}
  .em-foot{border-color:#2a3a5c !important;}
}
[data-ogsc] .em-title{color:#f1f5f9 !important;}
[data-ogsc] .em-text{color:#cbd5e1 !important;}
[data-ogsc] .em-muted{color:#94a3b8 !important;}
[data-ogsc] .em-link{color:#93c5fd !important;}
[data-ogsb] .em-bg{background-color:#0a1020 !important;}
[data-ogsb] .em-card{background-color:#111a2e !important;}
[data-ogsb] .em-box{background-color:#1a2540 !important;}
[data-ogsb] .em-mono{background-color:#0f172a !important;}
`;

export function renderEmailHtml(params: { title: string; preheader: string; contentRows: string; footerReason: string; ctx?: EmailContext }): string {
  const ctx = params.ctx ?? {};
  const logo = withBase(ctx, "/marca/email-logo.png");
  const header = logo
    ? `<img src="${esc(logo)}" width="280" height="120" alt="InnoChat" style="display:block;width:280px;height:120px;max-width:100%;border:0;outline:none;text-decoration:none;font-family:${FONT};font-size:26px;font-weight:700;color:#ffffff;">`
    : `<span style="font-family:${FONT};font-size:28px;line-height:60px;font-weight:700;color:#ffffff;">InnoChat</span>`;
  const termos = withBase(ctx, "/termos");
  const privacidade = withBase(ctx, "/privacidade");
  const legalLine = footerLegalLine(ctx);
  const links = [
    termos ? `<a href="${esc(termos)}" class="em-link" style="color:${C.muted};text-decoration:underline;">Termos de uso</a>` : null,
    privacidade ? `<a href="${esc(privacidade)}" class="em-link" style="color:${C.muted};text-decoration:underline;">Política de privacidade</a>` : null,
  ].filter(Boolean);
  const filler = "&#847;&zwnj;&nbsp;".repeat(40);

  return `<!DOCTYPE html>
<html lang="pt-BR" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(params.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>${HEAD_CSS}</style>
</head>
<body class="em-bg" style="margin:0;padding:0;width:100%;background-color:${C.pageBg};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${C.pageBg};opacity:0;">${esc(params.preheader)}${filler}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-bg" bgcolor="${C.pageBg}" style="background-color:${C.pageBg};">
<tr><td align="center" class="em-outer" style="padding:24px 12px;">
<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td align="center" bgcolor="${C.navy}" style="background-color:${C.navy};border-radius:16px 16px 0 0;padding:16px 0 12px 0;border-bottom:4px solid ${C.primary};">${header}</td></tr>
<tr><td class="em-card em-pad" bgcolor="${C.card}" style="background-color:${C.card};padding:36px 40px 20px 40px;font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${params.contentRows}
</table>
</td></tr>
<tr><td class="em-card em-pad" bgcolor="${C.card}" style="background-color:${C.card};padding:0 40px 32px 40px;border-radius:0 0 16px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td class="em-foot" style="border-top:1px solid ${C.border};padding:20px 0 0 0;font-family:${FONT};font-size:12px;line-height:19px;color:${C.muted};"><span class="em-muted" style="color:${C.muted};">${esc(params.footerReason)}</span></td></tr>
<tr><td class="em-muted" style="padding:12px 0 0 0;font-family:${FONT};font-size:12px;line-height:19px;color:${C.muted};"><strong class="em-text" style="color:${C.text};">InnoChat</strong> · Desenvolvido por <a href="${OPERATOR_URL}" class="em-link" style="color:${C.primary};text-decoration:none;font-weight:700;">InnovareCode</a><br>${esc(DIREITOS_RESERVADOS)}${legalLine ? `<br>${esc(legalLine)}` : ""}${links.length ? `<br>${links.join(" &nbsp;·&nbsp; ")}` : ""}</td></tr>
</table>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>`;
}

/** Rodapé da versão texto — mesma informação do HTML. */
export function renderEmailText(params: { body: string; footerReason: string; ctx?: EmailContext }): string {
  const ctx = params.ctx ?? {};
  const lines = ["", "--", params.footerReason, "", `InnoChat · Desenvolvido por InnovareCode (${OPERATOR_URL})`, DIREITOS_RESERVADOS];
  const legalLine = footerLegalLine(ctx);
  if (legalLine) lines.push(legalLine);
  const termos = withBase(ctx, "/termos");
  const privacidade = withBase(ctx, "/privacidade");
  if (termos) lines.push(`Termos de uso: ${termos}`);
  if (privacidade) lines.push(`Política de privacidade: ${privacidade}`);
  return `${params.body.trim()}\n${lines.join("\n")}\n`;
}
