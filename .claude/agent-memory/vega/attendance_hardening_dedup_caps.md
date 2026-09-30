---
name: attendance-hardening-dedup-caps
description: Endurecimento do atendimento (2026-09-30) — dedup clientMessageId, tetos por contato/empresa em sendTextToContact, corrida enviar x encerrar, armadilhas
metadata:
  type: project
---

- Dedup: `src/lib/idempotency.ts#runIdempotent` (Map em memória, promessa compartilhada, só sucesso guardado, TTL 10 min). Chave empresa+usuário+clientMessageId. Rate de 20/min ficou DENTRO do serviço (após dedup) para retry deduplicado não gastar cota.
- Tetos 10/h contato e 120/h empresa em `sendTextToContact` (outcome `RATE_LIMITED`); `ClientNotification` ganhou `RATE_LIMITED` (backend + client-notification.ts + teste).
- Corrida enviar x encerrar: condição `state HUMAN OR handoff aberto` na PRÓPRIA updateMany da sessão (atômica). Fixture `makeHandoff` cria sessão HUMAN sem humanUntil, então o "encerrar" não a limpa: no teste setar humanUntil como o bot real faz.
- Causa raiz de bug meu na rodada: sanitizeChatBody TRUNCA em 4000; checar TEXT_TOO_LONG depois dele deixava 4001+ passar truncado. Checar tamanho ANTES de sanitizar. AGENT_MESSAGE_MAX/MAX_MESSAGE_LENGTH agora 4000.
- Testes antigos que mandam >10 msgs ao mesmo contato quebram pelo teto: usar um contato por mensagem.
- Heredoc grande com `'` e python inline quebra no Bash: escrever script/bloco com a ferramenta Write no scratchpad.
