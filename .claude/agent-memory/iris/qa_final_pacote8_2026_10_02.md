---
name: qa-final-pacote8-2026-10-02
description: QA final do pacote de 8 melhorias (HEAD 1aeff4d) 2026-10-02: specs novas, flakes de teste achados, sim WL depende da hora (janela 8h-21h), receita E2E em porta 3700
metadata:
  type: project
---

Specs novas: `relatorios-comissao`, `lista-de-espera`, `auditoria` (E2E, banco próprio `innochat_iris_e2e`, porta 3700, build `.next-iris-final` feito SEM banco; config temporária `playwright.iris.config.ts` apagada).

Armadilhas (todas de TESTE, não de produto):
- Login 20/IP: a suíte inteira numa só invocação estoura perto do spec `whatsapp` (~330 testes). Dividir em 2 invocações com servidor reiniciado; `cadastro.spec` e `cobranca-anual-cupom` sozinhos (cadastro 5/h).
- `getByText` de toast resolve 2 nós (div do toast + `span role=status aria-live` "Notification ..."): usar `.first()` ou `.locator("visible=true")`. Pegou cobranca-painel, cobranca-anual-cupom e a minha lista-de-espera. Texto de `<option>` do filtro ("Oferta enviada") também conta.
- Cópia oculta do streaming `div[hidden][id^="S:"]` faz `getByTestId` dar 2 nós: `waitForFunction` que ela sumiu depois do goto (cobranca-painel).
- Banner de cookies nasce no cliente: `isVisible()` logo após `goto` é sempre false; usar `waitFor({state:"visible"})` em poll (consentimento-pixel).
- Filtro de profissional da lista de espera inclui pedidos "qualquer profissional" (por desenho).
- Simulador WL-03..06 só passam entre 08h e 21h no fuso do tenant `grade` (America/Sao_Paulo): fora da janela a oferta é adiada de propósito. Provado trocando o fuso do tenant para America/Los_Angeles (lib.mjs TZ + seed.mjs, revertidos): 6/6 verdes. Rodar o simulador de dia.
- `bot-api-v2-agenda` API-03 dependia da hora (24h de antecedência passa a "Sex 02/10 ·" depois do expediente): relaxado.
- Heredoc com `'` no Bash do Windows quebra; criar arquivos com Write.
