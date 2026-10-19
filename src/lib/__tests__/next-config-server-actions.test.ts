import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { SITE_URL } from "@/lib/site";

/**
 * Bug real de produção (2026-10-19, missão cmvfpkibd00gd01r45lnfzbo6): toda submissão de Server
 * Action (ex.: "Salvar endereço" em Admin > Configurações) virava 500 com "Minified React error
 * #441" no navegador sempre que o `host`/`x-forwarded-host` que chega ao Next (depois da cadeia
 * Cloudflare → Traefik) não batia com o `Origin` que o navegador manda — Next trata isso como
 * possível CSRF e aborta a ação (`Invalid Server Actions request`, digest `...@E80`).
 *
 * Reproduzido com `next build && next start` + replay do POST real (mesmo cookie/next-action de
 * uma sessão de navegador de verdade): com `Origin: https://innochat.innovarecode.com.br` e
 * `x-forwarded-host` ausente OU apontando para outro valor, a ação falhava (500/E80) sem este
 * `allowedOrigins`; com ele, os 4 cenários testados (origin/host batendo, só host batendo via
 * x-forwarded-host, x-forwarded-host ausente, x-forwarded-host errado) passaram a devolver 200.
 *
 * Este teste não reproduz a requisição HTTP (isso exige build de produção + servidor de pé — feito
 * manualmente na investigação); garante só que ninguém remove a configuração sem querer.
 */
describe("next.config.ts — allowedOrigins dos Server Actions", () => {
  it("libera o domínio público oficial para o CSRF check de Server Actions sobreviver a um hop de proxy que não repasse host/x-forwarded-host corretamente", () => {
    const allowedOrigins = nextConfig.experimental?.serverActions?.allowedOrigins ?? [];
    const expectedHost = new URL(SITE_URL).host;
    expect(allowedOrigins).toContain(expectedHost);
  });
});
