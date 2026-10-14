import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8")) as { version: string };

export default defineConfig({
  test: {
    environment: "node",
    // `tests/integration/**` só roda sob demanda (`npm run test:integration`), com
    // `TEST_DATABASE_URL` apontando para um Postgres real — nunca no `npm test` padrão, que
    // precisa continuar verde sem depender de infraestrutura externa (CI sem Postgres, por
    // exemplo). Ver docs/arquitetura.md §8.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "tests/modules/**/*.{test,spec}.{ts,tsx}", "tests/components/**/*.{test,spec}.{ts,tsx}"],
    // DATABASE_URL fake por padrão: só precisa ser sintaticamente válida
    // para o PrismaClient instanciar (quando algum teste importar
    // getPrisma()). A maioria dos testes de unidade (core/, lib/db lógica
    // pura) nunca bate no banco de verdade. Quando `TEST_DATABASE_URL` está
    // definida (testes de integração com Postgres real — Fase 4+), ela também
    // vira o `DATABASE_URL` do processo.
    env: {
      NEXT_PUBLIC_APP_VERSION: pkg.version,
      NEXT_PUBLIC_BUILD_DATE: "2026-01-01",
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? "postgresql://user:pass@localhost:5432/innochat_test",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
