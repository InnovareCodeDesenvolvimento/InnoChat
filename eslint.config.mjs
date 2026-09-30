import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    ".next/**",
    ".next-*/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  // Regra de dependência de docs/arquitetura.md §10: "app → modules → core ←
  // adapters". O Prisma Client cru só pode ser importado dentro de
  // src/lib/db/ — em todo o resto, use forTenant() (tenant-scoped) ou
  // getPrisma() (não tenant-scoped, ex. User/PlatformSettings) exportados de
  // lá. Ver src/lib/db/tenant-client.ts.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@prisma/client",
              message:
                "Prisma Client cru só pode ser importado dentro de src/lib/db/. Use forTenant(tenantId) (tenant-scoped) ou getPrisma() (não tenant-scoped) exportados de lá.",
            },
          ],
        },
      ],
    },
  },

  // src/core/ é domínio puro: sem I/O, sem Next.js, sem Prisma (ver
  // arquitetura.md §10). É o que garante que as funções de agenda/billing
  // sejam testáveis isoladamente.
  {
    files: ["src/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@prisma/client", message: "src/core/ não pode depender de Prisma — é domínio puro." },
          ],
          patterns: [
            {
              group: ["next", "next/*"],
              message: "src/core/ não pode depender de Next.js — é domínio puro.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
