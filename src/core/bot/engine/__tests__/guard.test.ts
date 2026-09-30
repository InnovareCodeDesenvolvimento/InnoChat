import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENGINE_DIR = join(__dirname, "..");
const sources = readdirSync(ENGINE_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, code: readFileSync(join(ENGINE_DIR, f), "utf-8") }));

/** Tira comentários para não acusar menção em texto explicativo. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("guarda do motor (plano §3.2, A-2)", () => {
  it("encontra os arquivos esperados", () => {
    const names = sources.map((s) => s.file);
    for (const f of ["types", "normalize", "parse-input", "interpret", "aliases", "name", "options", "trail", "legacy", "render", "route", "index"]) {
      expect(names).toContain(`${f}.ts`);
    }
  });

  it.each(sources.map((s) => [s.file, s.code] as const))("%s só importa de dentro de engine/", (_file, code) => {
    const specs = [...stripComments(code).matchAll(/(?:import|export)[^"';]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    const dynamic = [...stripComments(code).matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    for (const spec of [...specs, ...dynamic]) {
      expect(spec, `import fora de engine/: ${spec}`).toMatch(/^\.\/[\w-]+$/);
    }
  });

  it.each(sources.map((s) => [s.file, s.code] as const))("%s não usa relógio, Intl nem APIs do Node", (_file, code) => {
    const c = stripComments(code);
    expect(c).not.toMatch(/Date\.now\s*\(/);
    expect(c).not.toMatch(/new\s+Date\s*\(\s*\)/);
    expect(c).not.toMatch(/\bIntl\b/);
    expect(c).not.toMatch(/\bprocess\b/);
    expect(c).not.toMatch(/\brequire\s*\(/);
    expect(c).not.toMatch(/\b(Buffer|__dirname|__filename|setTimeout|setInterval|fetch)\b/);
    expect(c).not.toMatch(/Math\.random/);
    expect(c).not.toMatch(/toLocale\w*\(/);
  });
});
