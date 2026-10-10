---
name: qa-cadastro-sem-friccao-2026-10-10
description: QA do cadastro sem fricção (2026-10-10): REPROVADO por texto da Assinatura que ignora trialInvoiceRepriced; armadilhas de E2E (login 20/IP, hidratação, banner foco, integração com edição concorrente)
metadata:
  type: project
---

Gates verdes no tree final: tsc, eslint src/tests/scripts (0 erros; `npx eslint` cru varre worktrees e dá 791 erros falsos), unit 1828, integração 1018 (TEST_DATABASE_URL derivado do .env trocando o banco por innochat_test), next build limpo, tsconfig intacto.

Bug achado (REPROVA): `ciclo-cupom.tsx` e `assinatura-client.tsx` não leem `trialInvoiceRepriced`. Texto fixo "A fatura que já está em aberto ... continuam como estão" + toasts "Vale a partir da próxima fatura"/"O desconto entra a partir da próxima fatura" aparecem para teste que nunca pagou, cuja fatura foi refeita. Backend correto (VOID + nova OPEN 59000, cupom 53100). Spec: `tests/e2e/cadastro-sem-friccao-assinatura.spec.ts` (último teste).
Bug menor pré-existente: foco ao reabrir banner de cookies falha se clicar em "Preferências de cookies" antes de `ready` (effect de foco em meta-pixel.tsx precisa depender de `ready`); falha determinística no consentimento-pixel-nichos:130 em dev.

Armadilhas:
- Login 20/IP e limites em memória: reiniciar `next dev` antes de cada invocação grande (global-setup trava em "Código de verificação" quando esgotou). `bash restart` = taskkill da porta 3000 + npm run dev.
- Integração rodada enquanto outro agente edita src dá falhas fantasma (convite, reprice, notificações de signup contam tenants alheios): conferir `stat` dos arquivos e re-rodar no fim.
- `assinatura-pix.spec` agora precisa de CPF no tenant de seed (sem documento o botão "Gerar Pix agora" não existe) e de esperar hidratação (`__reactProps$`); limite 5/10 min em memória: reiniciar o servidor entre tentativas.
- Cópia oculta S:0 em assinatura-cancelamento: escopar `getByRole("main")`.
- Landing tem cache 60 s: ciclos-vitrine 1ª execução logo após criar o plano falha; rerodar.
- Sino admin fase2-ui "Esc" é flake (1 em 2).
- CompleteRegistration testado com stub de fbevents.js + sendBeacon (sobrevive ao location.assign).
