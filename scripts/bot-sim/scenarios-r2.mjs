// Rodada 2 dos cenários (confirmações por texto, paginação, corrida, prazo, fusos extremos, estados de exceção).
export default function register({ scenario, check, conv, toTime, book, hasOpt, parseOptions, db, api, seed, tzToday, RUN_TAG }) {
  scenario("N3", "Cancelar/remarcar dentro e fora do prazo mínimo (cancelMinLeadMin=120)", async () => {
    const c = conv();
    await c.say("oi");
    const cid = await c.contactId();
    const t = seed.tenants.bela;
    const p = await db();
    await api("bela", "PATCH", `/contacts/${cid}`, { name: "Cliente Prazo" });
    // profissional exclusivo deste cenário (sem conflito com outros agendamentos)
    const eva = await p.professional.create({ data: { tenantId: t.tenantId, name: `Eva ${RUN_TAG}`, sortOrder: 9, workingHours: { create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "00:00", endTime: "23:59" })) } } });
    await p.professionalService.create({ data: { professionalId: eva.id, serviceId: t.services["Corte feminino"] } });
    try {
      const soon = new Date(Date.now() + 90 * 60_000);
      soon.setUTCSeconds(0, 0);
      await p.appointment.create({ data: { tenantId: t.tenantId, contactId: cid, serviceId: t.services["Corte feminino"], professionalId: eva.id, startsAt: soon, endsAt: new Date(soon.getTime() + 3600_000), blockEndsAt: new Date(soon.getTime() + 3600_000), status: "SCHEDULED", source: "WHATSAPP" } });
      let r = await c.say("2");
      check(/Corte feminino/.test(r.msgs[0]), "lista o agendamento próximo");
      await c.say("1");
      r = await c.say("1"); // cancelar
      check(/Confirma o cancelamento/.test(r.msgs[0]), "pergunta confirmação");
      r = await c.pick(/Sim/);
      check(/Não é mais possível|perto do horário/.test(r.msgs[0]), `fora do prazo: recusa com TOO_LATE | ${r.msgs[0].split("\n")[0]}`);
      check(hasOpt(r.msgs[0], /Agendar/), "e devolve ao menu");
      check(/\d{4,}|telefone|ligue|atendente/i.test(r.msgs[0]), "a recusa dá um caminho (telefone/atendente) — hoje só diz 'fale com a gente diretamente'");
      await c.say("2"); await c.say("1");
      r = await c.say("2"); // remarcar
      check(!/Para qual dia/.test(r.msgs[0]), `remarcar fora do prazo deveria ser recusado ANTES de fazer o cliente escolher dia e horário | 1ª resposta: ${r.msgs[0].split("\n")[0]}`);
      await c.say("2");
      r = await c.say("1");
      r = await c.pick(/Confirmar/);
      check(/Não é mais possível|perto do horário/.test(r.msgs[0]), `remarcar fora do prazo acaba recusado | ${r.msgs[0].split("\n")[0]}`);
    } finally {
      await p.appointment.deleteMany({ where: { professionalId: eva.id } });
      await p.professional.delete({ where: { id: eva.id } });
    }
  });

  scenario("P1", "Resposta ao lembrete depois de horas: 'menu', 'cancelar', '2'", async () => {
    for (const w of ["menu", "cancelar", "2", "remarcar"]) {
      const c = conv();
      await c.say("oi");
      const p = await db();
      await p.chatSession.updateMany({ where: { contactId: await c.contactId() }, data: { lastInboundAt: new Date(Date.now() - 20 * 3600_000) } });
      const r = await c.say(w);
      check(true, `lembrete + "${w}" depois de 20h => ${(r.msgs[0] || "").split("\n").filter(Boolean).slice(0, 2).join(" / ")}`);
      if (w === "menu") check(!/recomecei/.test(r.msgs[0]), "quem responde 'menu' ao lembrete não deveria ler 'recomecei o menu' (parece erro)");
      if (w === "2") check(/agendamentos/.test(r.msgs[0]) && !/Faz um tempo/.test(r.msgs[0]), "'2' depois de sessão expirada ainda é 'Meus agendamentos'? (hoje o número é descartado)");
    }
  });

  scenario("C1", "Confirmar com 'sim'/'ok'/'s' na tela de confirmação", async () => {
    for (const w of ["sim", "s", "ok", "confirmo", "isso", "pode ser", "1", "confirmar", "Confirmar!", "c", "não", "nao", "n", "2"]) {
      const c = conv();
      await toTime(c, { pro: /Ana/, day: 4, time: 0 });
      await c.say("Nome Confirma");
      check(/Confirma/.test(c.last), "chegou na confirmação");
      const r = await c.say(w);
      const first = (r.msgs[0] || "").split("\n")[0];
      const good = /Agendamento confirmado|Para qual dia|Escolha um horário/.test(r.msgs[0] || "");
      check(good, `confirmação + "${w}" -> ${first}`);
    }
  });

  scenario("C2", "Cancelar: 'sim'/'não' na confirmação do cancelamento e 'Não, manter'", async () => {
    for (const w of ["sim", "não", "s", "n", "ok", "2"]) {
      const c = conv();
      await book(c, { pro: /Ana/, day: 4, time: 1, name: "Cancela Teste" });
      await c.say("2"); await c.say("1"); await c.say("1");
      const r = await c.say(w);
      check(!/Não entendi/.test(r.msgs[0] || ""), `cancelamento + "${w}" -> ${(r.msgs[0] || "").split("\n").slice(0, 2).join(" / ")}`);
      if (w === "2") check(/mantido|mantemos|continua|segue/i.test(r.msgs[0]), "'Não, manter' confirma que o agendamento foi mantido (hoje volta ao menu sem dizer nada)");
    }
  });

  scenario("C3", "Nomes estranhos no passo de nome", async () => {
    const names = ["<script>alert(1)</script>", "Maria\nJoão", "A".repeat(60), "A".repeat(61), "..", "1 2", "Zé", "{empresa}", "*Maria*", "Maria 😀"];
    for (const w of names) {
      const c = conv();
      await toTime(c, { pro: /Ana/, day: 4, time: 2 });
      const r = await c.say(w);
      const ct = await (await db()).contact.findUnique({ where: { id: await c.contactId() } });
      check(true, `nome ${JSON.stringify(w.slice(0, 25))} -> ${(r.msgs[0] || "").split("\n")[0]} | salvo=${JSON.stringify(ct.name)}`);
      if (w.length === 61) check(!/Não entendi essa opção/.test(r.msgs[0]), "nome longo demais deveria dizer 'nome muito longo', não 'Não entendi essa opção'");
    }
  });

  scenario("R4", "Paginação: numeração pula, 'Ver mais' cíclico, datas repetidas entre páginas", async () => {
    const c = conv();
    await c.say("oi"); await c.pick(/Agendar/);
    await c.say("9");
    const pg2 = c.last;
    check(!(/9\. Ver mais/.test(pg2) && parseOptions(pg2).filter((o) => o.n < 9).length < 8), `página 2 não deveria mostrar "9. Ver mais" logo depois do item 5 (numeração pula)`);
    const r = await c.say("9");
    check(!/1\. Corte feminino/.test(r.msgs[0]), "'Ver mais' na última página não deveria voltar silenciosamente para a página 1");
    const t = conv();
    await t.say("oi"); await t.pick(/Agendar/); await t.pick(/Corte/); await t.pick(/Qualquer/);
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const dl = parseOptions(t.last).filter((o) => !/Ver mais/.test(o.label)).map((o) => o.label);
      seen.push(dl);
      if (!/Ver mais datas/.test(t.last)) break;
      await t.pick(/Ver mais datas/);
    }
    const flat = seen.flat();
    check(new Set(flat).size === flat.length, `nenhuma data repetida entre páginas: ${seen.map((x) => x.join(",")).join(" || ")}`);
  });

  scenario("R5", "'Ver mais' por texto e '9' fora de paginação", async () => {
    const c = conv();
    await c.say("oi"); await c.pick(/Agendar/);
    const r = await c.say("ver mais");
    check(/Massagem/.test(r.msgs[0]), "'ver mais' por texto abre a página 2");
    const c2 = conv();
    await c2.say("oi"); await c2.pick(/Agendar/); await c2.pick(/Barba/);
    check(/Para qual dia/.test(c2.last), "Barba (só Bruno) pula profissional");
    const r2 = await c2.say("9");
    check(/Não entendi/.test(r2.msgs[0]), "9 inexistente é inválido");
  });

  scenario("S1", "SLOT_TAKEN sem mais horários no dia: alternativas de OUTRO dia aparecem sem informar o dia", async () => {
    const t = seed.tenants.bela;
    const p = await db();
    const a = conv();
    const fabi = await p.professional.create({ data: { tenantId: t.tenantId, name: `Fabi ${RUN_TAG}`, sortOrder: 9, workingHours: { create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "09:00", endTime: "10:00" })) } } });
    await p.professionalService.create({ data: { professionalId: fabi.id, serviceId: t.services["Escova"] } });
    try {
      await a.say("oi"); await a.pick(/Agendar/); await a.pick(/Escova/); await a.pick(/Fabi/);
      await a.say("2"); // amanhã
      await a.say("1"); // único horário do dia
      if (/nome/i.test(a.last)) await a.say("Ana Sozinha");
      const confA = a.last;
      const b = conv();
      await b.say("oi");
      const bid = await b.contactId();
      await api("bela", "PATCH", `/contacts/${bid}`, { name: "Bia Ocupa" });
      const days = (await api("bela", "GET", `/availability/days?serviceId=${t.services["Escova"]}&professionalId=${fabi.id}&limit=7`)).body.options;
      const slots = (await api("bela", "GET", `/availability/slots?serviceId=${t.services["Escova"]}&professionalId=${fabi.id}&date=${days[1].id}&offset=0&limit=8`)).body.options;
      const rr = await api("bela", "POST", "/appointments", { contactId: bid, serviceId: t.services["Escova"], professionalId: fabi.id, startsAt: slots[0].id, idempotencyKey: "s1-" + RUN_TAG });
      check(rr.status === 201, `cliente B reservou o mesmo horário pela API (${rr.status})`);
      const r = await a.pick(/Confirmar/);
      const dayOfA = confA.match(/\w{3} \d\d\/\d\d/)?.[0];
      check(/ocupado/.test(r.msgs[0]), `avisa ocupado | ${r.msgs[0].split("\n")[0]}`);
      const altDay = days[2].label;
      check(r.msgs[0].includes(altDay), `a mensagem informa o DIA das alternativas (eram de ${altDay}, o cliente pediu ${dayOfA}). Obtido: ${r.msgs[0].split("\n").join(" / ")}`);
      const r2 = await a.say("1");
      check(true, `resumo depois de escolher alternativa: ${r2.msgs[0].split("\n").join(" / ")}`);
    } finally {
      await p.appointment.deleteMany({ where: { professionalId: fabi.id } });
      await p.professional.delete({ where: { id: fabi.id } });
    }
  });

  scenario("S2", "Corrida real: dois clientes confirmam o MESMO horário ao mesmo tempo", async () => {
    const a = conv(), b = conv();
    await toTime(a, { pro: /Ana/, day: 5, time: 2 });
    await a.say("Cliente A");
    await toTime(b, { pro: /Ana/, day: 5, time: 2 });
    await b.say("Cliente B");
    const [ra, rb] = await Promise.all([a.pick(/Confirmar/), b.pick(/Confirmar/)]);
    const ok = [ra, rb].filter((r) => /Agendamento confirmado/.test(r.msgs[0] || "")).length;
    const taken = [ra, rb].filter((r) => /ocupado/.test(r.msgs[0] || "")).length;
    check(ok === 1 && taken === 1, `exatamente 1 confirma e 1 recebe 'ocupado' (ok=${ok}, ocupado=${taken}); erros: ${ra.error || ""} ${rb.error || ""}`);
  });

  scenario("S3", "Cancelar item já cancelado pelo painel (lista velha)", async () => {
    const c = conv();
    await book(c, { pro: /Ana/, day: 3, time: 0, name: "Lista Velha" });
    await c.say("2");
    await c.say("1");
    const p = await db();
    await p.appointment.updateMany({ where: { contactId: await c.contactId() }, data: { status: "CANCELED" } });
    let r = await c.say("1"); // cancelar
    r = await c.pick(/Sim/);
    check(/cancelado/i.test(r.msgs[0]), `cancelar item já cancelado pelo painel é idempotente: "${r.msgs[0].split("\n")[0]}"`);
  });

  scenario("S4", "Remarcar: horário ocupado entre listar e confirmar (SLOT_TAKEN na remarcação)", async () => {
    const a = conv();
    await book(a, { pro: /Ana/, day: 5, time: 0, name: "Rema A" });
    await a.say("2"); await a.say("1"); await a.say("2"); // remarcar
    await a.say("6"); // outro dia
    await a.say("2");
    const confA = a.last;
    const target = confA.match(/\d\d:\d\d/)[0];
    const dayLbl = confA.match(/\w{3} \d\d\/\d\d/)[0];
    const t = seed.tenants.bela;
    const b = conv();
    await b.say("oi");
    const bid = await b.contactId();
    await api("bela", "PATCH", `/contacts/${bid}`, { name: "Bia Ocupa" });
    const days = (await api("bela", "GET", `/availability/days?serviceId=${t.services["Corte feminino"]}&professionalId=${t.pros.ana}&limit=7`)).body.options;
    const iso = days.find((d) => d.label === dayLbl).id;
    const slots = (await api("bela", "GET", `/availability/slots?serviceId=${t.services["Corte feminino"]}&professionalId=${t.pros.ana}&date=${iso}&offset=0&limit=8`)).body.options;
    const hit = slots.find((s) => s.label === target);
    if (hit) await api("bela", "POST", "/appointments", { contactId: bid, serviceId: t.services["Corte feminino"], professionalId: t.pros.ana, startsAt: hit.id, idempotencyKey: "s4-" + RUN_TAG });
    const r = await a.pick(/Confirmar/);
    check(hit && /ocupado/.test(r.msgs[0]), `remarcação com conflito -> ${r.msgs[0].split("\n").join(" / ")} (alvo ${dayLbl} ${target}, conflito criado=${!!hit})`);
    const l = await a.say("1");
    check(/Confirma/.test(l.msgs[0] || ""), `escolher alternativa na remarcação -> ${(l.msgs[0] || "").split("\n").join(" / ")}`);
    const f = await a.pick(/Confirmar/);
    check(/remarcado/.test(f.msgs[0] || ""), `remarcação conclui -> ${(f.msgs[0] || "").split("\n").join(" / ")}`);
  });

  scenario("S5", "Mesmo cliente reserva dois atendimentos SOBREPOSTOS (sem limite/checagem por cliente)", async () => {
    const t = seed.tenants.bela;
    const p = await db();
    const mk = (n) => p.professional.create({ data: { tenantId: t.tenantId, name: `${n} ${RUN_TAG}`, sortOrder: 9, workingHours: { create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "09:00", endTime: "18:00" })) } } });
    const p1 = await mk("Jo"), p2 = await mk("Ka");
    await p.professionalService.createMany({ data: [p1, p2].map((x) => ({ professionalId: x.id, serviceId: t.services["Sobrancelha"] })) });
    try {
      const c = conv();
      await c.say("oi");
      const cid = await c.contactId();
      await api("bela", "PATCH", `/contacts/${cid}`, { name: "Sobreposto" });
      const days = (await api("bela", "GET", `/availability/days?serviceId=${t.services["Sobrancelha"]}&professionalId=${p1.id}&limit=7`)).body.options;
      const slot = (await api("bela", "GET", `/availability/slots?serviceId=${t.services["Sobrancelha"]}&professionalId=${p1.id}&date=${days[2].id}&offset=0&limit=8`)).body.options[0];
      await api("bela", "POST", "/appointments", { contactId: cid, serviceId: t.services["Sobrancelha"], professionalId: p1.id, startsAt: slot.id, idempotencyKey: "s5a-" + RUN_TAG });
      await api("bela", "POST", "/appointments", { contactId: cid, serviceId: t.services["Sobrancelha"], professionalId: p2.id, startsAt: slot.id, idempotencyKey: "s5b-" + RUN_TAG });
      const list = await c.say("2");
      const same = parseOptions(list.msgs[0]).filter((o) => o.label.includes(slot.label));
      check(same.length <= 1, `o mesmo cliente tem ${same.length} agendamentos às ${slot.label} no mesmo dia (com 2 profissionais diferentes): API e bot não impedem`);
    } finally {
      await p.appointment.deleteMany({ where: { professionalId: { in: [p1.id, p2.id] } } });
      await p.professionalService.deleteMany({ where: { professionalId: { in: [p1.id, p2.id] } } });
      await p.professional.deleteMany({ where: { id: { in: [p1.id, p2.id] } } });
    }
  });

  scenario("R3", "Paginação de horários: 'Mais horários' sem repetir e escolha na 2ª página", async () => {
    const t = seed.tenants.bela;
    const p = await db();
    const ivo = await p.professional.create({ data: { tenantId: t.tenantId, name: `Ivo ${RUN_TAG}`, sortOrder: 9, workingHours: { create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "08:00", endTime: "20:00" })) } } });
    await p.professionalService.create({ data: { professionalId: ivo.id, serviceId: t.services["Sobrancelha"] } });
    try {
      const c = conv();
      await c.say("oi"); await c.pick(/Agendar/); await c.say("8"); // Sobrancelha
      if (/Com quem/.test(c.last)) await c.pick(new RegExp(`Ivo ${RUN_TAG}`));
      await c.say("3");
      const p1 = parseOptions(c.last);
      const r = await c.pick(/Mais horários/);
      const p2 = parseOptions(r.msgs[0]);
      const rep = p2.filter((o) => !/Mais/.test(o.label) && p1.some((x) => x.label === o.label));
      check(rep.length === 0, `página 2 de horários não repete a 1ª (repetidos ${rep.map((o) => o.label)}) p1=${p1.map((o) => o.label)} p2=${p2.map((o) => o.label)}`);
      const lbl = p2[0].label;
      const r4 = await c.say("1");
      const r5 = /nome/i.test(r4.msgs[0]) ? await c.say("Pagina Dois") : r4;
      check(r5.msgs[0].includes(lbl), `escolher o 1º horário da página 2 (${lbl}) leva ao resumo correto: ${r5.msgs[0].split("\n").join(" / ")}`);
    } finally {
      await p.professionalService.deleteMany({ where: { professionalId: ivo.id } });
      await p.professional.delete({ where: { id: ivo.id } });
    }
  });

  scenario("T1", "Kiritimati (UTC+14): 'hoje' local é amanhã em UTC", async () => {
    const c = conv("kiribati");
    await c.say("oi"); await c.pick(/Agendar/); await c.pick(/Consulta/);
    const days = parseOptions(c.last);
    const localToday = tzToday("Pacific/Kiritimati");
    const utcToday = new Date().toISOString().slice(0, 10);
    check(days[0].label.endsWith(localToday.slice(8, 10) + "/" + localToday.slice(5, 7)), `1º dia = hoje local ${localToday} (UTC hoje ${utcToday}) | ${days.slice(0, 3).map((d) => d.label).join(",")}`);
    await c.say("1");
    const times = parseOptions(c.last);
    check(times.length > 0, `há horários: ${times.map((t) => t.label).join(",")}`);
    await c.say("1");
    await c.say("Kiri Bati");
    const r = await c.pick(/Confirmar/);
    check(/Agendamento confirmado/.test(r.msgs[0]), `reserva ok | ${r.msgs[0].split("\n").slice(0, 3).join(" / ")}`);
    const m = await c.say("2");
    check(new RegExp(days[0].label.slice(-5)).test(m.msgs[0]), `meus agendamentos no mesmo dia | ${m.msgs[0].split("\n").slice(0, 3).join(" / ")}`);
  });

  scenario("V1", "Sessão HUMAN vencida: volta a responder com saudação", async () => {
    const c = conv();
    await c.say("oi");
    await c.say("3");
    const p = await db();
    const cid = await c.contactId();
    await p.chatSession.updateMany({ where: { contactId: cid }, data: { humanUntil: new Date(Date.now() - 1000), lastInboundAt: new Date(Date.now() - 60_000) } });
    await p.contact.update({ where: { id: cid }, data: { botPausedUntil: new Date(Date.now() - 1000) } });
    const r = await c.say("oi");
    check(/Bem-vindo|Como posso ajudar/.test(r.msgs[0] || ""), `depois da pausa o bot volta com o menu | ${(r.msgs[0] || "(silêncio)").split("\n")[0]}`);
  });

  scenario("V2", "pushName vazio ou estranho na saudação", async () => {
    for (const pn of ["", ".", "🌸✨", "~"]) {
      const c = conv("bela", { pushName: pn });
      const r = await c.say("oi");
      check(!/(Olá|Oi), [.~]!|(Olá|Oi), !/.test(r.msgs[0]), `pushName ${JSON.stringify(pn)} => ${r.msgs[0].split("\n")[0]}`);
    }
  });

  scenario("V3", "Primeiras mensagens em linguagem natural", async () => {
    for (const w of ["1", "2", "3", "agendar", "cancelar meu horário", "quero marcar corte amanhã 15h", "bom dia", "Boa tarde, gostaria de agendar"]) {
      const c = conv();
      const r = await c.say(w);
      check(true, `primeira mensagem ${JSON.stringify(w)} => ${(r.msgs[0] || "").split("\n").filter(Boolean).slice(0, 2).join(" / ")}`);
    }
  });

  scenario("D5", "Entrada inválida em CADA etapa repete a tela certa (sem cair no menu) e 3 erros seguidos no CONFIRMAR chamam atendente", async () => {
    const c = conv();
    await c.say("oi"); await c.pick(/Agendar/);
    const stages = [];
    let r = await c.say("abc"); stages.push(["serviço", /Qual serviço/.test(r.msgs[0])]);
    await c.pick(/Corte/);
    r = await c.say("abc"); stages.push(["profissional", /Com quem/.test(r.msgs[0])]);
    await c.pick(/Ana/);
    r = await c.say("abc"); stages.push(["dia", /Para qual dia/.test(r.msgs[0])]);
    await c.say("3");
    r = await c.say("abc"); stages.push(["horário", /Escolha um horário/.test(r.msgs[0])]);
    await c.say("1");
    r = await c.say("Nome Etapas");
    r = await c.say("abc"); stages.push(["confirmar", /Confirma o agendamento/.test(r.msgs[0])]);
    for (const [n, ok] of stages) check(ok, `entrada inválida na etapa ${n} repete a própria etapa`);
    r = await c.say("sim");
    r = await c.say("ok");
    check(!/atendente/i.test(r.msgs[0]), `cliente que responde "abc", "sim", "ok" na confirmação é transferido para atendente: "${r.msgs[0].split("\n")[0]}"`);
    const m = conv();
    await book(m, { pro: /Ana/, day: 4, time: 5, name: "Etapas Meus" });
    await m.say("2");
    r = await m.say("abc"); check(/Seus agendamentos/.test(r.msgs[0]), "inválida em Meus agendamentos repete a lista");
    await m.say("1");
    r = await m.say("abc"); check(/O que deseja fazer/.test(r.msgs[0]), "inválida em Cancelar/Remarcar repete a pergunta");
    await m.say("1");
    r = await m.say("abc"); check(/Confirma o cancelamento/.test(r.msgs[0]), "inválida em confirmar cancelamento repete a pergunta");
  });

  scenario("D6", "Emojis de confirmação (👍 ✅) e 'hoje'/'amanhã' nas telas de escolha", async () => {
    for (const w of ["👍", "✅", "👍🏽"]) {
      const c = conv();
      await toTime(c, { pro: /Ana/, day: 4, time: 3 });
      await c.say("Emoji Teste");
      const r = await c.say(w);
      check(/Agendamento confirmado/.test(r.msgs[0] || ""), `confirmação com ${w} -> ${(r.msgs[0] || "").split("\n")[0]}`);
    }
    for (const w of ["hoje", "amanhã", "amanha", "sexta", "sex"]) {
      const c = conv();
      await c.say("oi"); await c.pick(/Agendar/); await c.pick(/Corte/); await c.pick(/Ana/);
      const r = await c.say(w);
      check(/Escolha um horário/.test(r.msgs[0] || ""), `dia por texto "${w}" -> ${(r.msgs[0] || "").split("\n")[0]}`);
    }
  });

  scenario("W1", "Serviço desativado no painel enquanto o cliente escolhe (lista velha): o cliente recebe alguma resposta?", async () => {
    const t = seed.tenants.bela;
    const p = await db();
    const sv = await p.service.create({ data: { tenantId: t.tenantId, name: `Temporário ${RUN_TAG}`, durationMin: 30, priceCents: 1000, sortOrder: 0 } });
    const pr = await p.professional.findFirst({ where: { id: t.pros.ana } });
    await p.professionalService.create({ data: { professionalId: pr.id, serviceId: sv.id } });
    try {
      const c = conv();
      await c.say("oi"); await c.pick(/Agendar/);
      check(new RegExp(`Temporário ${RUN_TAG}`).test(c.last), "serviço temporário aparece");
      await p.service.update({ where: { id: sv.id }, data: { active: false } });
      const r = await c.pick(new RegExp(`Temporário ${RUN_TAG}`));
      check(r.msgs.length > 0, `cliente recebe resposta quando o serviço foi desativado (erro do n8n: ${r.error}; respostas: ${r.msgs.length})`);
      const r2 = await c.say("1");
      check(r2.msgs.length > 0, `e ao tentar de novo (erro: ${r2.error})`);
      const s = await c.sessionRow();
      check(!s.lockToken, `trava da sessão foi liberada pelo fluxo de erro (lockToken=${s.lockToken ? "presa" : "livre"})`);
    } finally {
      await p.professionalService.deleteMany({ where: { serviceId: sv.id } });
      await p.service.delete({ where: { id: sv.id } });
    }
  });

  scenario("W2", "Profissional desativada enquanto o cliente escolhe o dia", async () => {
    const t = seed.tenants.bela;
    const p = await db();
    const pr = await p.professional.create({ data: { tenantId: t.tenantId, name: `Temp ${RUN_TAG}`, sortOrder: 8, workingHours: { create: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "18:00" })) } } });
    await p.professionalService.create({ data: { professionalId: pr.id, serviceId: t.services["Escova"] } });
    try {
      const c = conv();
      await c.say("oi"); await c.pick(/Agendar/); await c.pick(/Escova/);
      await p.professional.update({ where: { id: pr.id }, data: { active: false } });
      const r = await c.pick(new RegExp(`Temp ${RUN_TAG}`));
      check(r.msgs.length > 0, `cliente recebe resposta quando a profissional foi desativada (erro: ${r.error})`);
    } finally {
      await p.professionalService.deleteMany({ where: { professionalId: pr.id } });
      await p.professional.delete({ where: { id: pr.id } });
    }
  });

  scenario("J1", "Dia listado que ficou sem horários antes do cliente escolher (NO_SLOTS_DAY)", async () => {
    const t = seed.tenants.bela;
    const p = await db();
    const fabi = await p.professional.create({ data: { tenantId: t.tenantId, name: `Gina ${RUN_TAG}`, sortOrder: 9, workingHours: { create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "09:00", endTime: "10:00" })) } } });
    await p.professionalService.create({ data: { professionalId: fabi.id, serviceId: t.services["Escova"] } });
    try {
      const a = conv();
      await a.say("oi"); await a.pick(/Agendar/); await a.pick(/Escova/); await a.pick(/Gina/);
      const days = (await api("bela", "GET", `/availability/days?serviceId=${t.services["Escova"]}&professionalId=${fabi.id}&limit=7`)).body.options;
      const b = conv();
      await b.say("oi");
      const bid = await b.contactId();
      await api("bela", "PATCH", `/contacts/${bid}`, { name: "Bia Ocupa" });
      const slots = (await api("bela", "GET", `/availability/slots?serviceId=${t.services["Escova"]}&professionalId=${fabi.id}&date=${days[1].id}&offset=0&limit=8`)).body.options;
      await api("bela", "POST", "/appointments", { contactId: bid, serviceId: t.services["Escova"], professionalId: fabi.id, startsAt: slots[0].id, idempotencyKey: "j1-" + RUN_TAG });
      const idx = parseOptions(a.last).find((o) => o.label === days[1].label).n;
      const r = await a.say(String(idx));
      check(/Não há horários livres neste dia/.test(r.msgs[0] || ""), `dia sem horários -> ${(r.msgs[0] || "(silêncio)").split("\n").join(" / ")}`);
      check(!parseOptions(r.msgs[0] || "").some((o) => o.label === days[1].label), "o dia sem horários não deveria continuar na lista de opções");
    } finally {
      await p.appointment.deleteMany({ where: { professionalId: fabi.id } });
      await p.professionalService.deleteMany({ where: { professionalId: fabi.id } });
      await p.professional.delete({ where: { id: fabi.id } });
    }
  });

  scenario("X1", "Texto do menu editado na tela 'Mensagens do bot': numeração do texto x ação real", async () => {
    const t = seed.tenants.bela;
    const p = await db();
    await p.botText.upsert({ where: { tenantId_key: { tenantId: t.tenantId, key: "MAIN_MENU" } }, update: { text: "Escolha:\n1. Falar com atendente\n2. Agendar\n3. Meus agendamentos" }, create: { tenantId: t.tenantId, key: "MAIN_MENU", text: "Escolha:\n1. Falar com atendente\n2. Agendar\n3. Meus agendamentos" } });
    try {
      const c = conv();
      await c.say("oi");
      check(/2\. Agendar/.test(c.last), "o cliente vê o texto editado");
      const r = await c.say("2");
      check(/Qual serviço/.test(r.msgs[0]), `cliente digita 2 ("Agendar" no texto editado) e recebe: ${r.msgs[0].split("\n")[0]} (a ação real do 2 é 'Meus agendamentos', fixa no workflow)`);
    } finally {
      await p.botText.deleteMany({ where: { tenantId: t.tenantId, key: "MAIN_MENU" } });
    }
  });

  scenario("X2", "Variável {servico}/{profissional} em texto de etapa que não a fornece aparece literal", async () => {
    const t = seed.tenants.bela;
    const p = await db();
    await p.botText.upsert({ where: { tenantId_key: { tenantId: t.tenantId, key: "CHOOSE_DAY" } }, update: { text: "Datas para {servico} com {profissional}:" }, create: { tenantId: t.tenantId, key: "CHOOSE_DAY", text: "Datas para {servico} com {profissional}:" } });
    try {
      const c = conv();
      await c.say("oi"); await c.pick(/Agendar/); await c.pick(/Corte/);
      const r = await c.pick(/Ana/);
      check(!/\{servico\}|\{profissional\}/.test(r.msgs[0]), `texto de CHOOSE_DAY com variáveis mostra: ${r.msgs[0].split("\n")[0]}`);
    } finally {
      await p.botText.deleteMany({ where: { tenantId: t.tenantId, key: "CHOOSE_DAY" } });
    }
  });

  scenario("G2", "Grade de horários depois de um serviço de 45 min: horários continuam em :00/:30?", async () => {
    const t = seed.tenants.bela;
    const p = await db();
    const hana = await p.professional.create({ data: { tenantId: t.tenantId, name: `Hana ${RUN_TAG}`, sortOrder: 9, workingHours: { create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "09:00", endTime: "18:00" })) } } });
    await p.professionalService.createMany({ data: [t.services["Escova"], t.services["Corte feminino"]].map((serviceId) => ({ professionalId: hana.id, serviceId })) });
    try {
      const c = conv();
      await c.say("oi");
      const cid = await c.contactId();
      await api("bela", "PATCH", `/contacts/${cid}`, { name: "Grade Teste" });
      const days = (await api("bela", "GET", `/availability/days?serviceId=${t.services["Escova"]}&professionalId=${hana.id}&limit=7`)).body.options;
      const day = days[2];
      const s1 = (await api("bela", "GET", `/availability/slots?serviceId=${t.services["Escova"]}&professionalId=${hana.id}&date=${day.id}&offset=0&limit=8`)).body.options;
      await api("bela", "POST", "/appointments", { contactId: cid, serviceId: t.services["Escova"], professionalId: hana.id, startsAt: s1[0].id, idempotencyKey: "g2-" + RUN_TAG });
      const s2 = (await api("bela", "GET", `/availability/slots?serviceId=${t.services["Corte feminino"]}&professionalId=${hana.id}&date=${day.id}&offset=0&limit=8`)).body.options;
      check(s2.every((s) => /:(00|30)$/.test(s.label)), `após uma Escova (45 min) às ${s1[0].label}, os horários seguintes saem da grade de 30 min: ${s2.map((s) => s.label).join(", ")}`);
    } finally {
      await p.appointment.deleteMany({ where: { professionalId: hana.id } });
      await p.professionalService.deleteMany({ where: { professionalId: hana.id } });
      await p.professional.delete({ where: { id: hana.id } });
    }
  });

  scenario("V4", "Serviço/profissional inativos não aparecem", async () => {
    const c = conv();
    await c.say("oi"); await c.pick(/Agendar/); await c.say("9");
    check(!/Legado/.test(c.last), "serviço inativo não aparece");
    await c.say("1"); // Massagem (pág.2 item 1)
    const c2 = conv();
    await c2.say("oi"); await c2.pick(/Agendar/); await c2.pick(/Corte/);
    check(!/Dani/.test(c2.last), "profissional inativa não aparece");
  });
}
