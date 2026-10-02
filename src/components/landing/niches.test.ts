import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESERVED_SLUGS } from "@/core/signup/slug";
import sitemap from "@/app/sitemap";
import { buildDemoScript } from "./demo-script";
import { NICHES, NICHE_SLUGS, allNiches, getNiche, type Niche } from "./niches";

function allText(niche: Niche): string {
  return [
    niche.label, niche.metaTitle, niche.metaDescription, niche.ogAlt, niche.h1.lead, niche.h1.highlight, niche.h1.tail,
    niche.heroText, ...niche.points, niche.painsTitle, niche.painsIntro, niche.servicesTitle, niche.servicesIntro,
    ...niche.pains.flatMap((p) => [p.title, p.text]),
    ...niche.faq.flatMap((f) => [f.question, f.answer]),
  ].join("\n");
}

describe("páginas por nicho", () => {
  it("são as cinco pedidas", () => {
    expect([...NICHE_SLUGS]).toEqual(["salao", "barbearia", "clinica-estetica", "consultorio", "pet-shop"]);
    expect(getNiche("salao")?.slug).toBe("salao");
    expect(getNiche("padaria")).toBeNull();
  });

  it.each(allNiches())("$slug: SEO com tamanho de resultado do Google", (niche) => {
    expect(niche.metaTitle.length).toBeLessThanOrEqual(65);
    expect(niche.metaDescription.length).toBeGreaterThan(100);
    expect(niche.metaDescription.length).toBeLessThanOrEqual(175);
    expect(niche.metaTitle).toContain("InnoChat");
  });

  it("títulos e descrições não se repetem entre as páginas (conteúdo duplicado)", () => {
    const titles = allNiches().map((n) => n.metaTitle);
    const descriptions = allNiches().map((n) => n.metaDescription);
    expect(new Set(titles).size).toBe(5);
    expect(new Set(descriptions).size).toBe(5);
  });

  it.each(allNiches())("$slug: voz do guia (sem travessão nem fórmulas de IA)", (niche) => {
    const text = allText(niche);
    expect(text).not.toMatch(/[—–]/);
    for (const banned of ["tudo em um só lugar", "sem complicação", "de forma simples e rápida", "revolucion", "potencializ", "alavanc", "descubra", "mergulhe", "Imagine", "incrível", "poderos", "robust"]) {
      expect(text.toLowerCase(), banned).not.toContain(banned.toLowerCase());
    }
    expect(text).not.toMatch(/não é só .{1,40}, é /i);
  });

  it.each(allNiches())("$slug: conteúdo mínimo (3 dores, 6 serviços, perguntas)", (niche) => {
    expect(niche.pains).toHaveLength(3);
    expect(niche.services.length).toBeGreaterThanOrEqual(6);
    expect(niche.faq.length).toBeGreaterThanOrEqual(2);
    for (const service of niche.services) expect(service.price).toMatch(/^R\$ \d+,\d{2}$/);
  });

  it.each(allNiches())("$slug: a conversa do bot sai do bot v2, com a empresa e o serviço do nicho", (niche) => {
    const script = buildDemoScript(new Date("2026-10-05T12:00:00Z"), niche.demo);
    const all = script.map((m) => m.text).join("\n");
    expect(script[1]!.text).toContain(niche.demo.company);
    expect(all).toContain(niche.demo.services[0]!.title);
    expect(all).toContain(niche.demo.price);
    expect(all).toContain(niche.demo.times[2]);
    expect(script.find((m) => m.id === "m12")?.text).toContain("2 horas");
  });

  it("a demo padrão da landing continua a mesma", () => {
    const text = buildDemoScript(new Date("2026-10-05T12:00:00Z")).map((m) => m.text).join("\n");
    expect(text).toContain("Studio Bella");
    expect(text).toContain("Corte feminino");
    expect(text).toContain("R$ 80,00");
  });

  it("entram no sitemap e não podem virar endereço de empresa", () => {
    const urls = sitemap().map((entry) => entry.url);
    for (const slug of NICHE_SLUGS) {
      expect(urls.some((u) => u.endsWith(`/${slug}`))).toBe(true);
      expect(RESERVED_SLUGS as readonly string[]).toContain(slug);
    }
  });

  it("cada nicho tem a sua rota, com dynamic = force-dynamic e metadata própria", () => {
    for (const slug of NICHE_SLUGS) {
      const source = readFileSync(join(process.cwd(), "src", "app", "(public)", slug, "page.tsx"), "utf-8");
      expect(source).toContain(`nicheMetadata("${slug}")`);
      expect(source).toContain(`<NichePage slug="${slug}" />`);
      expect(source).toContain('export const dynamic = "force-dynamic"');
    }
    expect(Object.keys(NICHES)).toHaveLength(5);
  });
});
