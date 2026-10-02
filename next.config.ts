import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

/**
 * Cabeçalhos de segurança (revisão 2026-09-28, achado ALTA — nenhum configurado antes).
 *
 * CSP sem nonce (`docs` da versão instalada do Next, `node_modules/next/dist/docs/01-app/
 * 02-guides/content-security-policy.md`, seção "Without Nonces"): a alternativa com nonce via
 * `proxy.ts` (Next 16 renomeou `middleware.ts` → `proxy.ts`, ver
 * `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`) exige que TODA página
 * seja dinamicamente renderizada (nonce só existe por requisição) — o painel tem páginas que
 * hoje podem ser estaticamente otimizadas (ex.: `/login`), e forçar tudo a dinâmico só para
 * viabilizar nonce seria trocar uma correção de segurança por uma regressão de performance sem
 * necessidade. Em vez disso, `script-src`/`style-src` usam `'unsafe-inline'`, exatamente como a
 * doc recomenda para quem não usa nonce — o App Router injeta scripts inline de hidratação
 * (payload dos Server Components) e este projeto usa `style={{...}}` em componentes de UI
 * (`agenda-client.tsx`), então bloquear inline quebraria a página com CSP puro. Reduz a defesa
 * de CSP contra XSS "novo" (ainda cobre clickjacking via `frame-ancestors`, e restringe origem
 * de scripts externos — `script-src 'self'` já bloqueia qualquer <script src> de terceiro), mas
 * é a opção documentada e sem regressão.
 *
 * `form-action` inclui `https://accounts.google.com`: o botão "Entrar com Google" é um formulário cuja
 * resposta redireciona para o Google (navegadores aplicam `form-action` também ao redirecionamento).
 *
 * Pixel do Meta (melhoria 5): `fbevents.js` vem de `connect.facebook.net`; os eventos saem por
 * `www.facebook.com` (imagem de 1px e beacon). A lista vale para o site todo, mas o script só é pedido
 * nas páginas públicas de venda e só depois do "Aceitar" do banner de cookies.
 *
 * `img-src` inclui `data:` porque o QR code do Pix (Mercado Pago) e o QR da Evolution vêm como
 * imagem base64 embutida, nunca por URL externa. Fontes são `next/font` (self-hosted, sem
 * domínio externo) — `font-src 'self'` já cobre.
 */
const isDev = process.env.NODE_ENV === "development";

const cspHeader = `
  default-src 'self';
  script-src 'self' 'unsafe-inline' https://connect.facebook.net${isDev ? " 'unsafe-eval'" : ""};
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: https://www.facebook.com;
  font-src 'self';
  connect-src 'self' https://www.facebook.com https://connect.facebook.net;
  object-src 'none';
  base-uri 'self';
  form-action 'self' https://accounts.google.com;
  frame-ancestors 'none';
  upgrade-insecure-requests;
`
  .replace(/\s{2,}/g, " ")
  .trim();

// Versão e data do build injetadas no bundle (fonte única: `version` do package.json) — ver
// `src/lib/app-info.ts`. `env` no next.config continua suportado no Next 16 (docs `next-config-js/env`).
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version: string };

const nextConfig: NextConfig = {
  // Permite buildar/servir em outra pasta (`NEXT_DIST_DIR=.next-x`) sem pisar num `next start`/dev
  // rodando em `.next` — usado nas verificações paralelas da equipe. Padrão inalterado.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  env: {
    NEXT_PUBLIC_APP_VERSION: pkg.version,
    NEXT_PUBLIC_BUILD_DATE: new Date().toISOString().slice(0, 10),
  },

  // Exigido pelo Dockerfile (build standalone) — gera .next/standalone com o server mínimo para
  // rodar sem o node_modules completo na imagem final.
  output: "standalone",

  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: cspHeader },
          // Backstop para navegadores que não seguem `frame-ancestors` — mesma defesa contra
          // clickjacking do painel (agendamentos, dados de clientes, configurações).
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // 2 anos + subdomínios: domínio público único (docs/arquitetura.md §14), sem
          // necessidade de servir nada em HTTP depois do primeiro acesso HTTPS.
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          // Enxuto: nenhuma feature de hardware/sensor é usada pelo painel.
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
