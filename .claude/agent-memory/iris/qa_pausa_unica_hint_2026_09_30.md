---
name: qa-pausa-unica-hint-2026-09-30
description: QA do HEAD 7781f07 (pausa única do bot + aviso notify-client-hint nos diálogos): REPROVADO por hint ausente em "Agendar para este cliente" do Atendimento; armadilhas
metadata:
  type: project
---

- (CORRIGIDO e reprovado->aprovado na 2a rodada) Bug: `atendimento-client.tsx` calcula `contactPhone` só do `fallback` (contato fora da fila). Cliente NA fila (caso normal) chega com phone null -> `notify-client-hint` nunca aparece no diálogo "Agendar para este cliente". O envio acontece mesmo assim (servidor resolve o telefone). Teste que pega: atendimento.spec "Agendar para este cliente (Atendimento): aparece...".
- Mutation provada: trocar `humanPauseMinutesFor` para sempre `humanPauseMin` derruba 2 testes de `bot-api-v2-conversa.test.ts` (fromMe com pedido aberto e fromMe sem pedido).
- Integração precisa `TEST_DATABASE_URL` (derivar de `.env` trocando /innochat por /innochat_test) no shell.
- Teste "tour" de atendimento.spec falha em `next dev` com StrictMode: effect de autoStart em `onboarding-tour.tsx` usa `autoStarted.current` + cleanup do timer, o 2º run do StrictMode retorna cedo e o tour nunca abre. Passa com `reactStrictMode:false`. Só dev (pré-existente, código não mudou no 7781f07).
- Agenda: slot 09:30 do dia da spec já é ocupado pelo teste "criar pelo painel"; usar 16:00 (visível) para abrir "Novo agendamento". No celular (390) não existe célula da grade: botão "Novo agendamento" exact.
- `describe` serial: 1 falha faz o resto do arquivo "did not run"; usar --grep-invert ao rodar o restante.
