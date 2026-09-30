---
name: qa-ajuda-favicon-2026-09-30
description: QA do HEAD 66010b1 (ícone ⓘ de ajuda + favicon): APROVADO; medições do selo InnovareCode e flakes vistos
metadata:
  type: project
---

- Ajuda ⓘ: varredura própria (Enter/Esc/foco volta/foco preso/alvo 44px/folha 390) em 16 rotas x 2 viewports = 70 "i", 32 chaves, sem problema. MEDIR A FOLHA SÓ APÓS ~700ms: o diálogo anima (zoom) e o bottom/largura saem errados antes.
- Selo InnovareCode (fixed z-40, pb-20 no main): 0 elementos presos (nunca livres) em 32 rota x viewport. Sobreposição parcial/transitória só em: Início 1440 (i "WhatsApp conectado", centro coberto em scrollY=0), Agenda 1440 (células 12:00-13:30), Mensagens do bot 1440 (Editar), Configurações 1440 (Salvar, parcial), Onboarding 390 (Avançar, parcial).
- Flakes vistos no E2E completo: bot-v2-sino-atendente "pedido novo ... sem recarregar" (timeout waitForResponse no 1º run, passa isolado em 16s); "legacy-texts" NÃO repetiu. cadastro SMTP falhou só por ambiente: PlatformSettings.publicBaseUrl do banco próprio apontava :3950.
- `npm run lint` cru (eslint sem args) varre .claude/worktrees alheios (791 erros falsos): usar `npx eslint src tests scripts`.
- Integração sem expor credencial: script tsx usando `deriveTestDatabaseUrl()` de tests/e2e/fixtures/test-db-url.ts e spawn do vitest (import com file:///). grep de DATABASE_URL no .env é bloqueado pelo classificador.
