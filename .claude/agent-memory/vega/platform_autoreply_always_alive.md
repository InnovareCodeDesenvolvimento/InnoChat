---
name: platform-autoreply-always-alive
description: Resposta automática do WhatsApp de cobrança sumiu (2026-10-03): causas prováveis (LID, trava 24h), regras novas, diagnóstico no Admin e autocorreção do webhook
metadata:
  type: project
---

Causas prováveis do silêncio (não reproduzidas em produção, só em teste): (1) remetente `@lid` sem telefone caía em `if (!senderDigits) return`;
(2) trava de 24 h por contato (dono testando 2x = nada); (3) webhook da Evolution trocado/desligado (só o HASH do token fica no banco, então
o endereço não é recuperável: autocorreção = reaplicar a URL se o token do endereço atual bate com o hash, senão GIRAR o token).

Regras novas: 10 min entre respostas, teto 6/dia por contato, SAIR/SIM sempre respondem (teto de 30 contra loop). LID-only responde ao `<lid>@lid`
(suposição pela Evolution `createJid`, NÃO provada em aparelho). Reserva da resposta é apagada se o envio falha. Diagnóstico = 1 linha
`ProviderEvent(provider "platform-whatsapp-diag", providerEventId = connectionId)`, mesclada por `patchDiagnostics` (nunca lança).
`EvolutionClient.findWebhook?` é opcional de propósito (fakes de teste não quebram).

Armadilhas: Bash tool des-escapa `\n`, `\d`, `\.` e `\/` em heredoc/script Node (regex virou `/./g`): conferir com grep e usar `[.]`/`[/]`/`[0-9]`;
heredoc com apóstrofo/texto grande falhou ("unexpected EOF"): usar Write num arquivo do scratchpad e `cat >>`. Flake: 3 testes de integração
(dunning-engine, dunning-ladder, platform-notifications) falham quando rodam junto de outra sessão no mesmo banco; isolados passam.
