---
name: platform-whatsapp-f4-design
description: F4 da régua — WhatsApp da plataforma (cobrança) trocável pelo Admin: desenho, decisões sem migration, armadilhas de teste e de edição
metadata:
  type: project
---

Código: `src/modules/platform-whatsapp/{connections,sender,sender-guard,webhook}.ts`, regras puras em
`src/core/platform-whatsapp/rules.ts`, actions em `src/modules/platform/platform-whatsapp-actions.ts`,
webhook `src/app/api/webhooks/platform-whatsapp/[token]/route.ts`, card em `src/components/admin/platform-whatsapp-card.tsx`.

**Decisões (sem tabela nova; só 1 migration aditiva: enum `InboundIgnoreReason.PLATFORM_SENDER`):**
- Estado auxiliar mora em `ProviderEvent` por `provider`: `platform-whatsapp-cleanup` (logout/exclusão pendente, `processedAt` nulo =
  tentar de novo no tick), `-enabled` (instante em que o admin ligou a chave, data do alerta MISSING), `-reply` (cada resposta de
  assinante = item do sino), `-autoreply` (trava de 24 h por contato), `-newnumber` (aviso de "novo número" uma vez por empresa+número).
- Telefones da plataforma são SÓ DÍGITOS (CHECK do Cronos): `phoneE164` e `Tenant.billingWhatsappE164`. `WhatsappInstance.phoneE164` tem "+".
- Troca = `promotePending`: `updateMany ... role:PENDING` faz de trava (webhook e polling juntos: um perde sem erro), depois aposenta
  a ACTIVE e ativa a PENDING na MESMA transação (ordem importa: o índice único parcial não é deferrable). Logout só depois, fora da tx.
- Reconectar com OUTRO celular: a instância Evolution é a mesma, então a linha antiga é aposentada cedendo `instanceName` (renomeado
  `-r<ts>`) e `webhookTokenHash` (vira hash morto) à linha nova; SEM logout (derrubaria a sessão nova).
- Rejeita no ato de conectar: o número comercial do site (`salesWhatsappE164`) e número que é bot de empresa (`PHONE_IN_USE_BY_TENANT`).
- `sendPlatformWhatsapp`: chave desligada = `NO_PLATFORM_NUMBER`; teto de 10/h (3 primeiros dias) ou 30/h estourado = `FAILED` (nada saiu);
  falha no envio + `connectionState` fechado = `CHANNEL_DOWN` (e marca a linha DISCONNECTED). Teste do admin NÃO grava BillingNotice.
- `syncN8n` já não tocava a instância (só lê `WhatsappInstance`). NÃO filtrar por prefixo `innochat-plataforma-`: slug de empresa
  "plataforma" geraria o mesmo prefixo. Garantia = tabelas separadas (teste em platform-n8n-sync).
- Manutenção (QR abandonado 30 min, limpeza pendente, `connectionState` do ativo) roda no route do tick, ANTES de `runBillingTick`.

**Armadilhas:**
- Teste que cria `WhatsappInstance` com o mesmo telefone usado como "novo número" de outro teste vaza e bloqueia a troca
  (`PHONE_IN_USE_BY_TENANT`): use um telefone dedicado por fixture.
- Edição com `node -e`/replace de `\n` falhou em silêncio em arquivos com CRLF no disco (page.tsx, notification-visuals): conferir
  `git diff --stat` depois ou usar a ferramenta Edit. Heredoc grande no Bash também quebra: usar Write.
- `python3` no Git Bash do Windows trava (alias da Store): usar node.
