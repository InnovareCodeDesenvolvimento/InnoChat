import localFont from "next/font/local";

/**
 * Pares tipográficos dos 3 temas prontos (`Tenant.theme`, docs/design/direcoes.md).
 * Carregados uma única vez aqui (não em cada layout) e expostos como variáveis
 * CSS via `variable`. Qual variável cada tema realmente USA é decidido em
 * `globals.css` (`--panel-font-display`/`--panel-font-body` por `[data-theme]`) —
 * nenhum componente referencia estas variáveis diretamente.
 *
 * Todos os 3 root layouts (público, painel do tenant, admin da plataforma)
 * aplicam `fontVariables` no `<html>` para que a troca de tema não exija
 * recarregar fontes.
 *
 * Arquivos LOCAIS (`src/app/fonts/*.woff2`, subset latin, fontes variáveis de licença OFL baixadas
 * do Google Fonts em 2026-10-01): o `next/font/google` baixava as fontes durante o `next build` e
 * uma falha de rede no Easypanel derrubou o deploy da v1.2.1. Com os arquivos no repositório o
 * build não depende de rede. Para trocar/atualizar uma fonte, substitua o .woff2 e o intervalo de peso.
 */
const inter = localFont({
  src: "./fonts/inter.woff2",
  weight: "400 700",
  variable: "--font-inter",
  display: "swap",
});

const manrope = localFont({
  src: "./fonts/manrope.woff2",
  weight: "700 800",
  variable: "--font-manrope",
  display: "swap",
});

// Pesos 600-800: o "800" entrou na escala premium (docs/design/premium-spec.md §4) — sem ele,
// `font-black` no tema Âmbar caía sintetizado (negrito artificial do navegador).
const fraunces = localFont({
  src: "./fonts/fraunces.woff2",
  weight: "600 800",
  variable: "--font-fraunces",
  display: "swap",
});

const sora = localFont({
  src: "./fonts/sora.woff2",
  weight: "600 800",
  variable: "--font-sora",
  display: "swap",
});

export const fontVariables = [
  inter.variable,
  manrope.variable,
  fraunces.variable,
  sora.variable,
].join(" ");
