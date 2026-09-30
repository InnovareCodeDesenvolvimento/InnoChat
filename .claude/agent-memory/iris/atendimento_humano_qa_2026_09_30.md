---
name: atendimento-humano-qa-2026-09-30
description: QA do Atendimento humano (HEAD 73577c3): como provar envio com Evolution fake, armadilhas de E2E (toast duplicado por aria-live, bolha otimista casa com regex de "enviada", \b em "16Oi", waJid obrigatório)
metadata:
  type: project
---

Veredito APROVADO (unit 965, integração 466, E2E 201, simulador v2 59/59, build:flow ok).

- O envio do atendente PODE ser provado de ponta a ponta no dev: Evolution fake (`fixtures/fake-http-server.ts`, rota `POST /message/sendText/*`, resposta `{key:{id}}`) + URL em `PlatformSettings.evolutionApiUrl` + instância CONNECTED `sandbox:false` no tenant. Só o WhatsApp real fica sem prova. Spec: `tests/e2e/atendimento.spec.ts`.
- Toast (Radix) é duplicado por um `<span role=status aria-live>`: `getByText(titulo)` dá strict-mode violation; usar `{ exact: true }`.
- Rótulo da bolha local é "Atendente, 13:34, enviando": um filtro `/Atendente/` casa a bolha OTIMISTA e o assert no banco corre antes do envio. Usar `/^Atendente(?!.*(enviando|não enviada))/`.
- `\b` não separa "16" de "Oi" (texto colado no textContent): usar `(?!\d)`.
- `Contact.waJid` é obrigatório: cliente "sem telefone" = JID `@lid` + `phoneE164: null` (recipientNumber só lê `@s.whatsapp.net`).
- Exclusion constraint de agendamento (23P01) impede criar 2 agendamentos sobrepostos da Ana no mesmo dia: cada teste usa hora própria ou dia próprio. Drag: usar combo provado 10:00 -> 11:30 em dia livre.
- SEND_FAILED/CONVERSATION_BUSY/TEXT_* devolvem o texto ao campo SEM bolha; só WHATSAPP_NOT_CONNECTED, RATE_LIMITED e rede deixam a bolha "Não enviada".
- Limite real do texto é 4000 (contador a partir de 3600); docs/contratos.md ainda cita 4096 em 2 linhas (desatualizado).
- Teto de envio 10/h por contato e 120/h por empresa (memória do processo): reiniciar o servidor por rodada e usar contato novo por teste.
- Sino agora abre /atendimento?contato=<id>; a spec antiga do sino (abria /clientes) foi atualizada.
