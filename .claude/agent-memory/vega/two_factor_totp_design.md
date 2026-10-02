---
name: two-factor-totp-design
description: 2FA TOTP do InnoChat (2026-10-02) — login em 2 passos sem brecha, gate do admin no layout, fixtures E2E, e a armadilha de edição em arquivo CRLF
metadata:
  type: project
---

Onde mora: `src/modules/two-factor/` (totp, recovery, service, login, actions); contrato em `docs/contratos.md`
"Verificação em 2 etapas". Teste: `tests/integration/two-factor.integration.test.ts`, `tests/e2e/two-factor.spec.ts`.

**Decisões (por quê):**
- Rota pública `/api/auth/callback/credentials` pode ser chamada direto: o provedor `credentials` RECUSA conta com 2FA
  ligada (`rejectIfTwoFactorEnabled`). `loginAction` confere a senha uma vez (`startPasswordLogin`) e abre sessão por
  prova assinada de 60 s (`verified-login`) para não contar o rate limit de e-mail (8/15 min) em dobro.
- Desafio do 2º fator: token assinado (reuso de `signGoogleToken` com 2 purposes novos), uso único e teto de 5 erros em
  memória (um processo), preso a `sessionVersion`. TOTP anti-replay = `updateMany` condicional em `totpLastUsedStep`.
- Gate do admin: o layout de `/admin` troca `{children}` pela tela de ativação (sem pathname, sem laço). As server
  actions `requirePlatformAdmin` NÃO checam 2FA (quebraria dezenas de testes de integração que semeiam admin).
- E2E: o dono de seed é admin, então global-setup liga a 2FA dele com segredo fixo e o teardown desliga;
  `resetSeedOwnerReplayGuard()` antes de logar de novo na mesma janela de 30 s.
- Teste de teto por usuário: não use `startPasswordLogin` em laço (bate no teto de e-mail antes); assine o desafio direto.

**Armadilha de edição:** arquivos do repo são CRLF; `String.replace` de trecho multi-linha em node falha em silêncio
(não achou, não trocou). Normalizar `\r\n` -> `\n`, trocar, e voltar ao CRLF, lançando erro se não achar (script de
apoio no scratchpad, `rep.cjs`). Conferir com grep que cada edição entrou.
