---
name: waitlist-quiet-window
description: Janela de silêncio 08h-21h das ofertas automáticas da lista de espera, marca de adiamento em ProviderEvent e como os testes fixam o relógio
metadata:
  type: project
---

Oferta AUTOMÁTICA (`offerFreedSlot`, também usada ao passar ao próximo) só sai com `isInsideSendWindow(now, tz)` (mesma janela do lembrete). Fora dela grava marca `ProviderEvent{provider:"waitlist-deferred", providerEventId: tenantId}` (createMany skipDuplicates) e o `runWaitlistTick` termina com `offerToWaitingInOpenWindow`: só empresas COM marca e janela aberta, toma a marca (delete antes de varrer), oferece o que ainda está livre/futuro. Oferta manual do painel ignora a janela.

**Why:** a 1ª ideia (tick oferecer a qualquer WAITING com horário livre) mudaria a semântica para todas as entradas (inclusive as adicionadas pelo painel de propósito) e poluiria testes; a marca limita o efeito ao que realmente foi adiado.

**How to apply nos testes:** `setWaitlistDepsForTests({evolution, now})` — `deps.now` vence o relógio do tick. Suíte existente usa `windowNow()` (hora real se 8-21h, senão hoje 12h) para não ficar dependente da hora. Provas de silêncio usam horários FUTUROS (amanhã 23h, depois de amanhã 08:30) e `runWaitlistTick(new Date())` (não passar `now` fake ao tick: ele venceria ofertas de outros mundos e enviaria mensagens). Limpar as marcas globais em `beforeEach`. Janela de preferência da entrada precisa ser estreita (10:00-10:30) senão ela pega qualquer horário livre.
