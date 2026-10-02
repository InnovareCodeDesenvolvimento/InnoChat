---
name: admin-financeiro-envios-f6
description: Telas F6 do Admin (Financeiro, Envios de cobrança, Cobrança da empresa) e armadilhas de verificação medidas
metadata:
  type: project
---

- Páginas: `/admin/financeiro`, `/admin/envios`, `/admin/empresas/[tenantId]`. Estado de lista na URL (`pagina`, `porPagina`, filtros) com `router.push` + `useTransition`; componente `ui/pagination.tsx` + `lib/pagination.ts`.
- E2E seeda por Prisma (`tests/e2e/fixtures/billing-register.ts`); verificação isolada em banco próprio `innochat_lyra` (migrate deploy + seed), build com NEXT_DIST_DIR e porta própria, tudo apagado depois.
- **Armadilha:** `pkill` não mata `next start` no Windows; build novo com servidor velho vivo dá chunks 500 e hidratação quebrada (filtros "não funcionam"). Matar por porta: `netstat -ano | grep :PORTA` + `taskkill //F //PID`.
- **Armadilha:** backslash em `node -e`/heredoc do Bash tool é consumido; para scripts de patch com regex, usar o Write tool.
- Tabela larga: `xl:` para tabela e cartões abaixo (sidebar come 256px em lg). Link de texto com alvo 44px: pseudo-elemento `before:-inset-y-3` (sem `truncate`, que corta o pseudo).
