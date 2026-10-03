/**
 * Sistema de espera padronizado. Sem DOM (ambiente node): `renderToStaticMarkup` + leitura de
 * fonte para guardar a COBERTURA — seção nova sem `loading.tsx`, `PageTransition` voltando a
 * depender de `useReducedMotion` (bug de hydration) ou um spinner solto que fuja do padrão.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { internalNavigationTarget } from "@/components/shell/navigation-progress";
import { PageLoading } from "./page-loading";
import { navIconFor } from "@/components/shell/nav-items";

const raiz = resolve(__dirname, "../../..");
const fonte = (rel: string) => readFileSync(resolve(raiz, rel), "utf-8");

const SECOES_COM_LOADING = [
  "src/app/(app)/[tenantSlug]/inicio",
  "src/app/(app)/[tenantSlug]/agenda",
  "src/app/(app)/[tenantSlug]/agendamentos",
  "src/app/(app)/[tenantSlug]/clientes",
  "src/app/(app)/[tenantSlug]/servicos",
  "src/app/(app)/[tenantSlug]/profissionais",
  "src/app/(app)/[tenantSlug]/profissionais/[professionalId]",
  "src/app/(app)/[tenantSlug]/whatsapp",
  "src/app/(app)/[tenantSlug]/mensagens-bot",
  "src/app/(app)/[tenantSlug]/configuracoes",
  "src/app/(app)/[tenantSlug]/assinatura",
  "src/app/(app)/[tenantSlug]/onboarding",
  "src/app/(platform)/admin/empresas",
  "src/app/(platform)/admin/cobranca",
  "src/app/(platform)/admin/planos",
  "src/app/(platform)/admin/saude",
];

describe("loading.tsx por seção", () => {
  it.each(SECOES_COM_LOADING)("%s tem loading.tsx com PageLoading", (dir) => {
    const arquivo = `${dir}/loading.tsx`;
    expect(existsSync(resolve(raiz, arquivo))).toBe(true);
    const src = fonte(arquivo);
    expect(src).toContain("PageLoading");
    expect(src).toContain("navIconFor(");
  });
});

describe("loading.tsx das abas de /admin/configuracoes", () => {
  // O título e a barra de abas vêm do layout; cada aba tem o próprio loading.tsx (só o esqueleto do conteúdo).
  it.each(["geral", "whatsapp", "automacao", "pagamentos", "email", "login", "marketing"])("%s tem loading.tsx", (aba) => {
    const arquivo = `src/app/(platform)/admin/configuracoes/${aba}/loading.tsx`;
    expect(existsSync(resolve(raiz, arquivo))).toBe(true);
    expect(fonte(arquivo)).toContain("ConfigTabLoading");
  });
});

describe("PageLoading", () => {
  const html = renderToStaticMarkup(
    createElement(PageLoading, { icon: navIconFor("agenda"), title: "Agenda", description: "d", action: "w-48" }),
  );
  it("marca o contêiner como ocupado e anuncia Carregando… só para leitor de tela", () => {
    expect(html).toContain('aria-busy="true"');
    expect(html).toMatch(/class="sr-only"[^>]*>Carregando…|role="status" class="sr-only">Carregando…/);
  });
  it("mostra o cabeçalho real (título e selo do menu) e o Inno só como dica tardia", () => {
    expect(html).toContain("<h1");
    expect(html).toContain("Agenda");
    expect(html).toContain("inno-wait");
  });
});

describe("Button em carregamento", () => {
  it("troca o rótulo por loadingText, desabilita e mostra o Spinner", () => {
    const html = renderToStaticMarkup(createElement(Button, { isLoading: true, loadingText: "Salvando…" }, "Salvar"));
    expect(html).toContain("Salvando…");
    expect(html).not.toContain("Salvar<");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("spinner-ring");
  });
  it("sem loadingText mantém o rótulo original (não muda o nome acessível usado pelo E2E)", () => {
    const html = renderToStaticMarkup(createElement(Button, { isLoading: true }, "Salvar"));
    expect(html).toContain("Salvar");
  });
  it("Spinner é decorativo", () => {
    expect(renderToStaticMarkup(createElement(Spinner))).toContain('aria-hidden="true"');
  });
});

describe("PageTransition", () => {
  it("não usa useReducedMotion/framer-motion (causava hydration mismatch com reduced motion)", () => {
    const src = fonte("src/components/shell/page-transition.tsx");
    expect(src).not.toMatch(/^import .*framer-motion/m);
    expect(src).not.toMatch(/import[^;]*useReducedMotion/);
    expect(src).toContain("page-enter");
  });
});

describe("internalNavigationTarget (quando a barra de navegação arma)", () => {
  const atual = { href: "http://localhost:3000/dev/agenda", origin: "http://localhost:3000", pathname: "/dev/agenda", search: "" } as Location;
  const link = (href: string, extra: Record<string, unknown> = {}) =>
    ({
      href: new URL(href, atual.href).href,
      target: "",
      hasAttribute: (n: string) => n === "download" && !!extra.download,
      getAttribute: () => href,
      ...extra,
    }) as unknown as HTMLAnchorElement;

  it("arma em link interno para outra rota", () => {
    expect(internalNavigationTarget(link("/dev/clientes"), atual)?.pathname).toBe("/dev/clientes");
  });
  it("arma quando só a query muda", () => {
    expect(internalNavigationTarget(link("/dev/agenda?novo=1"), atual)).not.toBeNull();
  });
  it("ignora a própria página, âncora, outra origem, nova aba e download", () => {
    expect(internalNavigationTarget(link("/dev/agenda"), atual)).toBeNull();
    expect(internalNavigationTarget(link("#topo"), atual)).toBeNull();
    expect(internalNavigationTarget(link("https://outro.com/x"), atual)).toBeNull();
    expect(internalNavigationTarget(link("/dev/clientes", { target: "_blank" }), atual)).toBeNull();
    expect(internalNavigationTarget(link("/dev/arquivo.csv", { download: true }), atual)).toBeNull();
  });
});
