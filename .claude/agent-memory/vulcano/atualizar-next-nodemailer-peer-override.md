---
name: atualizar-next-nodemailer-peer-override
description: 2026-10-03 next 16.3.8 e nodemailer 10 (major); peer do next-auth (^7||^8) exige overrides, senão o npm aninha @auth/core e quebra o typecheck do auth.types.d.ts
metadata:
  type: project
---

Atualização de segurança (v1.7.4): next 16.3.4->16.3.8 (+eslint-config-next), nodemailer 8.0.11->10.0.14. `@types/nodemailer` removido (v10 traz tipos próprios). Node >=20 exigido: imagem node:22 serve.

**Armadilha:** next-auth beta.32 / @auth/core declaram peer `nodemailer ^7.0.7 || ^8.0.5`. Com nodemailer 10 o npm marca "invalid", ANINHA `@auth/core` em `node_modules/next-auth/node_modules/` e a augmentation `declare module "@auth/core/jwt"` (src/lib/auth.types.d.ts) deixa de pegar: `token.userId` vira `{}` e o tsc falha em src/lib/auth.ts. Também o `npm uninstall` passa a dar ERESOLVE.
**Correção:** `overrides` no package.json (`next-auth` e `@auth/core` -> `nodemailer: "$nodemailer"`), apagar a entrada aninhada do lock + `rm -rf node_modules/next-auth/node_modules` e `npx npm@10.9.9 install`. Conferir `grep '"node_modules/.*@auth/core"' package-lock.json` = só a raiz.

Audit restante (--omit=dev): deepmerge-ts via prisma (CLI; 3 high), fora do escopo.
Docker não existe na máquina de dev (sem `docker build` local): validado com `npm@10.9.9 ci --dry-run` em pasta limpa + next build.
Receita E2E descartável: banco novo, migrate deploy + db:seed, next start em porta própria com AUTH_URL, config playwright temporária sem webServer.
