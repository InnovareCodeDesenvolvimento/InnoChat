/**
 * Selo fixo (painéis) e assinatura em texto (telas públicas/autenticação).
 *
 * Sem DOM: `renderToStaticMarkup` + leitura de fonte para guardar a COBERTURA — se alguém criar
 * uma casca nova sem identificação, ou repetir a assinatura num painel que já tem o selo, quebra.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AppSignature } from "./app-signature";
import { InnovareCodeBadge } from "./innovarecode-badge";
import { APP_VERSION, BUILD_DATE, DESENVOLVEDORA_URL, NOME_SISTEMA, VERSAO_EXIBIDA } from "@/lib/app-info";

const raiz = resolve(__dirname, "../../..");
const fonte = (rel: string) => readFileSync(resolve(raiz, rel), "utf-8");
const badge = () => renderToStaticMarkup(createElement(InnovareCodeBadge));
const sig = (tone?: "light" | "dark") => renderToStaticMarkup(createElement(AppSignature, { tone }));

describe("app-info", () => {
  it("a versão exibida é a do package.json, não um número escrito à mão", () => {
    const pkg = JSON.parse(fonte("package.json")) as { version: string };
    expect(APP_VERSION).toBe(pkg.version);
    expect(VERSAO_EXIBIDA).toBe(`v${pkg.version}`);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(BUILD_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(NOME_SISTEMA).toBe("InnoChat");
  });

  it("next.config injeta versão e data do build", () => {
    const cfg = fonte("next.config.ts");
    expect(cfg).toContain("NEXT_PUBLIC_APP_VERSION: pkg.version");
    expect(cfg).toContain("NEXT_PUBLIC_BUILD_DATE");
  });
});

describe("InnovareCodeBadge", () => {
  it("leva ao site da desenvolvedora em nova aba, sem expor a origem", () => {
    const html = badge();
    expect(html).toContain(`href="${DESENVOLVEDORA_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("diz quem desenvolveu e a versão, no rótulo e na dica", () => {
    const html = badge();
    expect(html).toContain(`aria-label="Desenvolvido por InnovareCode, versão ${APP_VERSION}"`);
    expect(html).toContain(`build ${BUILD_DATE}`);
    expect(html).toContain(VERSAO_EXIBIDA);
  });

  it("a logo é decorativa (o rótulo do link já a nomeia)", () => {
    const html = badge();
    expect(html).toContain('alt=""');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("/brand/innovarecode.png");
  });

  it("flutua no canto inferior direito, compacto, abaixo dos diálogos e com alvo de 44px", () => {
    const html = badge();
    for (const c of ["fixed", "bottom-3", "right-3", "z-40", "min-h-11"]) expect(html).toContain(c);
    // o nome da desenvolvedora só abre no hover/foco — em repouso a pílula é só logo + versão
    expect(html).toContain("max-w-0");
    expect(html).toContain("group-hover:max-w-40");
  });

  it("usa tokens do tema, sem branco ou hex fixos", () => {
    const html = badge();
    expect(html).toContain("bg-surface/75");
    expect(html).toContain("ring-border");
    expect(html).not.toMatch(/bg-white|#[0-9a-fA-F]{3,6}\b/);
  });

  it("os painéis têm um selo só, fora do conteúdo, e reservam espaço no fim da página", () => {
    for (const arq of ["src/components/shell/panel-shell.tsx", "src/components/shell/admin-shell.tsx"]) {
      const src = fonte(arq);
      expect(src.match(/<InnovareCodeBadge/g)?.length).toBe(1);
      expect(src).toContain("pb-16");
    }
  });

  it("o toast sobe para não cobrir o selo", () => {
    expect(fonte("src/components/ui/toast.tsx")).toContain("bottom-16");
  });
});

describe("AppSignature", () => {
  it("mostra sistema, versão, data do build e a desenvolvedora com link seguro", () => {
    const html = sig();
    expect(html).toContain("InnoChat");
    expect(html).toContain(VERSAO_EXIBIDA);
    expect(html).toContain(`Compilado em ${BUILD_DATE}`);
    expect(html).toContain(`href="${DESENVOLVEDORA_URL}"`);
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toMatch(/compilado em \d{4}-\d{2}-\d{2}/);
  });

  it("tom escuro usa os tokens da sidebar; claro, os do painel", () => {
    expect(sig("dark")).toContain("text-sidebar-text");
    expect(sig()).toContain("text-text-secondary");
    expect(sig("dark")).not.toContain("text-white/40");
  });
});

describe("cobertura", () => {
  it.each([
    ["painel do tenant", "src/components/shell/panel-shell.tsx"],
    ["admin da plataforma", "src/components/shell/admin-shell.tsx"],
  ])("%s exibe o selo e não repete a assinatura", (_n, arq) => {
    const src = fonte(arq);
    expect(src).toMatch(/<InnovareCodeBadge\b/);
    expect(src).not.toMatch(/<AppSignature\b/);
  });

  it.each([
    ["telas de autenticação (AuthShell)", "src/components/public/auth-shell.tsx"],
    ["termos e privacidade", "src/components/legal/legal-document.tsx"],
    ["landing", "src/app/(public)/page.tsx"],
  ])("%s exibe a assinatura", (_n, arq) => {
    expect(fonte(arq)).toMatch(/<AppSignature\b/);
  });

  it("o AuthShell usa tom escuro no painel de marca e claro no mobile", () => {
    const src = fonte("src/components/public/auth-shell.tsx");
    expect(src).toContain('<AppSignature tone="dark"');
    expect(src).toMatch(/<AppSignature className="[^"]*lg:hidden"/);
  });
});

describe("AuthInput", () => {
  it("o botão de mostrar/ocultar não contém a palavra 'senha' (getByLabel('Senha') do E2E)", () => {
    const src = fonte("src/components/public/auth-input.tsx");
    const rotulos = src.match(/aria-label=\{[^}]*\}/g) ?? [];
    expect(rotulos.length).toBeGreaterThan(0);
    for (const r of rotulos) expect(r.toLowerCase()).not.toContain("senha");
  });
});
