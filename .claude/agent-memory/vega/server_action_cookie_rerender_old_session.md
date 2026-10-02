---
name: server-action-cookie-rerender-old-session
description: Server Action que troca o cookie de sessão derruba a própria sessão (o re-render lê o cookie antigo); por isso confirmar a 2FA é rota POST, com renovação do sv via unstable_update + AsyncLocalStorage
metadata:
  type: project
---

Ao ativar a 2FA o service incrementa `sessionVersion` (derruba outras sessões). Para manter a sessão ATUAL é preciso reemitir o JWT
(`unstable_update({})` -> callback `jwt` com `trigger:"update"` renova `sv`). Em Server Action isso falha: o Next refaz a página na
mesma resposta e o `auth()` dela lê o cookie ANTIGO (cabeçalho da requisição) -> sessão "revogada" -> /login, e os códigos de recuperação
(mostrados uma vez) se perdem. Solução: `POST /api/two-factor/confirm` (route handler, sem re-render), cliente chama por `fetch`.

Segurança da renovação: `update` também chega do navegador em `/api/auth/session`; o callback `jwt` só aceita `trigger:"update"` dentro de
`runWithSessionRefresh(userId, ...)` (AsyncLocalStorage, `src/modules/auth/session-refresh.ts`). Fora do escopo, token revogado não ressuscita.

Google: admin da plataforma JÁ é negado no login Google (`PLATFORM_ADMIN` em `resolveGoogleSignIn`), mais forte que pedir TOTP; só os textos
foram ajustados (dono/equipe: Google vale como 2º fator).
`requirePlatformAdmin` agora exige `totpEnabledAt` (`TWO_FACTOR_SETUP_REQUIRED`); fixtures de admin precisam do PAR `totpSecretEnc` + `totpEnabledAt` (CHECK do banco).
