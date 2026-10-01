// Cenários v2, parte A: CA-01..CA-31 (comandos, entrada, fluxo, falhas). Escritos contra os contratos do plano §3 ANTES do código
// existir: nascem vermelhos e cada verificação aponta a tarefa que a deixa verde (B-1, B-2, B-3, C-1, W-1).
import {
  scenario, check, sub, conv, T, say, opts, dayOpts, timeOpts, labelOf, brief, firstLine, norm, ctxOf, sessionOf, start, toDay, toTime, toAfterTime, toConfirm, book,
  S, handoffs, ageSession, freeSlot, allSlots, createAppt, db, sql, api, api2, seed, TZ, localISO, localHM, addDaysISO, weekdayOfISO, ddmm, parseOptions, world,
  ensureFake, fakeSent, clearFakeSent, setTeamHours, getTenant, whenLabelsAround, fromDay,
  J, trySetTenant,
} from "./v2-kit.mjs";

const todayOf = (k) => localISO(new Date(), TZ[k]);
const HANDOFF_TXT = /Já avisei a equipe|Deixei seu recado/;
const contig = (list) => list.every((o, i) => o.n === i + 1);

// ================================================================ comandos e entrada
scenario("CA-01", '"Menu" / "0" levam ao MAIN_MENU com contexto zerado em qualquer estado (inclusive ASK_NAME)', "W-1", async () => {
  for (const w of ["Menu", "MENU", "menú", "0", "0️⃣"]) {
    await sub(`ASK_NAME + "${w}"`, async () => {
      const c = conv();
      await start(c);
      await toAfterTime(c, { day: 1, time: 0 });
      check(T.ASK_NAME.test(c.last), `"${w}": chegou no ASK_NAME | ${brief(c.last)}`);
      const r = await say(c, w);
      const row = await c.sessionRow();
      const ctx = row.context || {};
      check(row.state === "MAIN_MENU", `"${w}" em ASK_NAME volta ao MAIN_MENU (state=${row.state})`);
      check(!ctx.serviceId && !ctx.startsAt && !ctx.date && !ctx.name && !ctx.professionalId, `"${w}": contexto zerado (${J(ctx).slice(0, 120)})`);
      check(opts(c).some((o) => /Agendar/.test(o.label)) && !T.INVALID_OPTION.test(r.text), `"${w}": mostra o menu sem "Não entendi" | ${brief(r.text)}`);
      check(!(await c.contactRow()).name, `"${w}" não foi gravado como nome do cliente`);
    });
  }
  for (const [label, drive] of [
    ["SELECT_SERVICE", async (c) => { await c.pick(/Agendar/); }],
    ["SELECT_DAY", async (c) => { await toDay(c); }],
    ["SELECT_TIME", async (c) => { await toTime(c, { day: 1 }); }],
    ["CONFIRM", async (c) => { await toConfirm(c, { day: 1 }); }],
  ]) {
    await sub(`${label} + "menu"`, async () => {
      const c = conv();
      await start(c, { named: true });
      await drive(c);
      const r = await say(c, "menu");
      const row = await c.sessionRow();
      check(row.state === "MAIN_MENU" && !(row.context || {}).serviceId, `"menu" em ${label} volta ao MAIN_MENU com contexto zerado (state=${row.state}, ctx=${J(row.context).slice(0, 100)})`);
      check(opts(c).some((o) => /Agendar/.test(o.label)), `"menu" em ${label}: mostra as opções do menu | ${brief(r.text)}`);
    });
  }
});

scenario("CA-02", '"voltar" reapresenta a etapa anterior (dias buscados de novo, startsAt limpo; profissional pulado → serviço)', "W-1", async () => {
  await sub("voltar em SELECT_TIME", async () => {
    const c = conv();
    await start(c, { named: true });
    await toTime(c, { day: 2 });
    const r = await say(c, "voltar");
    check(T.CHOOSE_DAY.test(r.text) && dayOpts(r.text).length >= 3, `"voltar" em SELECT_TIME mostra os dias | ${brief(r.text)}`);
    check(r.calls.some((x) => /availability\/days/.test(x.url)), `os dias foram buscados de novo (chamadas: ${r.calls.map((x) => x.url.split("?")[0]).join(", ")})`);
    const ctx = await ctxOf(c);
    check(!ctx.startsAt, `startsAt limpo (=${ctx.startsAt})`);
    check((await c.sessionRow()).state === "SELECT_DAY", "estado = SELECT_DAY");
  });
  await sub("voltar de CONFIRM limpa o horário", async () => {
    const c = conv();
    await start(c, { named: true });
    await toConfirm(c, { day: 1 });
    check(!!(await ctxOf(c)).startsAt, "startsAt existe na confirmação");
    await say(c, "voltar");
    await say(c, "voltar");
    const ctx = await ctxOf(c);
    check(!ctx.startsAt, `depois de voltar até os dias, startsAt limpo (=${ctx.startsAt}; estado ${(await c.sessionRow()).state})`);
  });
  await sub("profissional pulado: voltar em SELECT_DAY → SELECT_SERVICE", async () => {
    const c = conv("bela");
    await start(c);
    await c.pick(/Agendar/);
    await c.pick(/Barba/); // só o Bruno tem expediente → pergunta de profissional é pulada
    check(T.CHOOSE_DAY.test(c.last) && !T.CHOOSE_PROFESSIONAL.test(c.last), `Barba pula o profissional | ${brief(c.last)}`);
    const r = await say(c, "voltar");
    check(T.CHOOSE_SERVICE.test(r.text), `"voltar" em SELECT_DAY (profissional pulado) leva à lista de serviços | ${brief(r.text)}`);
  });
});

scenario("CA-03", '"ajuda" em SELECT_DAY envia HELP + o mesmo prompt, sem mudar estado nem invalidCount', "W-1", async () => {
  for (const w of ["ajuda", "Ajuda", "?"]) {
    await sub(`"${w}"`, async () => {
      const c = conv();
      await start(c, { named: true });
      await toDay(c);
      const before = await c.sessionRow();
      const r = await say(c, w);
      const after = await c.sessionRow();
      check(T.HELP.test(r.text) && T.CHOOSE_DAY.test(r.text), `"${w}" traz HELP + o prompt de dias | ${brief(r.text)}`);
      check(after.state === before.state && after.invalidCount === before.invalidCount, `estado e invalidCount iguais (${before.state}/${before.invalidCount} → ${after.state}/${after.invalidCount})`);
    });
  }
});

scenario("CA-04", '"Atendente" em qualquer estado grava HUMAN, cria 1 HandoffRequest aberto e ignora as mensagens seguintes (exceto "menu")', "B-2", async () => {
  for (const [label, drive] of [
    ["MAIN_MENU", async () => {}],
    ["SELECT_SERVICE", async (c) => { await c.pick(/Agendar/); }],
    ["SELECT_TIME", async (c) => { await toTime(c, { day: 1 }); }],
    ["ASK_NAME", async (c) => { await toAfterTime(c, { day: 1 }); }],
    ["CONFIRM", async (c) => { await toConfirm(c, { day: 1 }); }],
  ]) {
    await sub(label, async () => {
      const c = conv();
      await start(c, { named: label === "CONFIRM" });
      await drive(c);
      const r = await say(c, "Atendente");
      const row = await c.sessionRow();
      check(row.state === "HUMAN" && row.humanUntil && new Date(row.humanUntil) > new Date(), `"Atendente" em ${label} → HUMAN com humanUntil no futuro (state=${row.state})`, "W-1");
      check(HANDOFF_TXT.test(r.text), `${label}: avisa que a equipe foi chamada | ${brief(r.text)}`, "W-1");
      const hs = await handoffs(await c.contactId());
      check(hs && hs.length === 1 && !hs[0].endedAt && hs[0].reason === "CLIENT_REQUEST", `${label}: exatamente 1 HandoffRequest aberto CLIENT_REQUEST (${hs ? J(hs.map((h) => [h.reason, !!h.endedAt])) : "tabela handoff_requests não existe"})`, hs ? "B-2" : "C-1");
      await say(c, "Atendente");
      const hs2 = await handoffs(await c.contactId());
      check(hs2 && hs2.length === 1, `${label}: pedir de novo reaproveita o aberto (${hs2 ? hs2.length : "?"} linhas)`, "B-2");
      const r2 = await say(c, "alguém aí?");
      check(r2.msgs.length === 0 && r2.claim && r2.claim.action === "ignore", `${label}: mensagem seguinte é ignorada (claim=${r2.claim && r2.claim.action}/${r2.claim && r2.claim.reason}, respostas=${r2.msgs.length})`, "B-2");
    });
  }
});

scenario("CA-05", '"sair" envia GOODBYE; a mensagem seguinte recebe GREETING + menu', "W-1", async () => {
  const c = conv();
  await start(c);
  await c.pick(/Agendar/);
  const r = await say(c, "sair");
  check(T.GOODBYE.test(r.text), `"sair" responde GOODBYE | ${brief(r.text)}`);
  const row = await c.sessionRow();
  check(row.state === "MAIN_MENU" && !(row.context || {}).serviceId, `sessão encerrada (state=${row.state})`);
  const r2 = await say(c, "oi");
  check(T.GREETING.test(r2.text) && opts(c).some((o) => /Agendar/.test(o.label)), `depois de "sair": GREETING + menu | ${brief(r2.text)}`);
});

scenario("CA-06", '"escova" / "ESCOVA" / "Escóva" escolhem Escova; "corte" com 2 cortes gera AMBIGUOUS_OPTION só com os 2', "W-1", async () => {
  const esp = S("especial");
  for (const w of ["escova", "ESCOVA", "Escóva"]) {
    await sub(`"${w}"`, async () => {
      const c = conv("especial");
      await start(c);
      await c.pick(/Agendar/);
      const r = await say(c, w);
      const ctx = await ctxOf(c);
      check(ctx.serviceId === esp.services.Escova, `"${w}" escolhe Escova (serviceId=${ctx.serviceId}) | ${brief(r.text)}`);
    });
  }
  await sub('"corte" ambíguo', async () => {
    const c = conv("especial");
    await start(c);
    await c.pick(/Agendar/);
    const r = await say(c, "corte");
    check(T.AMBIGUOUS_OPTION.test(r.text), `"corte" gera AMBIGUOUS_OPTION | ${brief(r.text)}`);
    const o = opts(c);
    check(o.length === 2 && o[0].n === 1 && o[1].n === 2 && o.every((x) => /Corte/.test(x.label)) && !o.some((x) => /Escova/.test(x.label)), `só as 2 candidatas, numeradas 1 e 2 (${o.map((x) => `${x.n}:${labelOf(x)}`).join(" | ")})`);
    check((await c.sessionRow()).invalidCount === 0, "ambíguo não conta como inválido");
    await say(c, "2");
    check((await ctxOf(c)).serviceId === esp.services.Infantil, "responder 2 escolhe a 2ª candidata (Corte infantil)");
  });
});

scenario("CA-07", '"2️⃣", "opção 2", "2.", "2)", "#2" e " 02 " equivalem a "2"', "W-1", async () => {
  for (const w of ["2", "2️⃣", "opção 2", "2.", "2)", "#2", " 02 "]) {
    await sub(`"${w}"`, async () => {
      const c = conv();
      await start(c);
      const r = await say(c, w);
      check(T.NO_APPOINTMENTS.test(r.text) && !T.INVALID_OPTION.test(r.text), `"${w}" no menu = Meus agendamentos | ${brief(r.text)}`);
    });
  }
});

scenario("CA-08", "Datas por extenso em SELECT_DAY: amanhã, sexta, dd/mm, d/m; mesmo dia da semana = hoje; \"que vem\" = +7", "W-1", async () => {
  const today = todayOf("dupla");
  const names = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  const nextWd = (wd) => { for (let i = 0; i < 7; i++) { if (weekdayOfISO(addDaysISO(today, i)) === wd) return addDaysISO(today, i); } };
  const wdToday = weekdayOfISO(today);
  const d4 = addDaysISO(today, 4);
  const d5 = addDaysISO(today, 5);
  const cases = [
    ["amanhã", addDaysISO(today, 1)],
    ["sexta", nextWd(5)],
    [`${d4.slice(8)}/${d4.slice(5, 7)}`, d4],
    [`${Number(d5.slice(8))}/${Number(d5.slice(5, 7))}`, d5],
    [names[wdToday], today],
    [`${names[wdToday]} que vem`, addDaysISO(today, 7)],
  ];
  for (const [text, exp] of cases) {
    await sub(`"${text}"`, async () => {
      const c = conv();
      await start(c, { named: true });
      await toDay(c);
      const r = await say(c, text);
      check(!T.INVALID_OPTION.test(r.text) && r.text.includes(ddmm(exp)), `"${text}" leva a ${ddmm(exp)} | ${brief(r.text)}`);
      const ctx = await ctxOf(c);
      if (T.CHOOSE_TIME.test(r.text)) check(ctx.date === exp, `contexto date=${ctx.date} (esperado ${exp})`);
    });
  }
});

scenario("CA-09", "Horário digitado em SELECT_TIME: 15h/15:00/15h00/3 da tarde; sem vaga → 3 mais próximos; \"tarde\" filtra 12:00-17:59", "W-1", async () => {
  const tz = TZ.dupla;
  for (const w of ["15h", "15:00", "15h00", "3 da tarde"]) {
    await sub(`"${w}"`, async () => {
      const c = conv();
      await start(c, { named: true });
      await toTime(c, { day: 5 });
      // A página de horários tem 7 itens (decisão do Atlas, spec 12.4): o 15:00 pode estar em outra página e continua valendo digitado.
      check(timeOpts(c.last).length > 0 && timeOpts(c.last).length <= 7, `a página tem de 1 a 7 horários (${timeOpts(c.last).length}) | ${brief(c.last)}`);
      const r = await say(c, w);
      const ctx = await ctxOf(c);
      check(ctx.startsAt && localHM(new Date(ctx.startsAt), tz) === "15:00", `"${w}" escolhe 15:00 (startsAt=${ctx.startsAt}) | ${brief(r.text)}`);
      check(T.CONFIRM_SUMMARY.test(r.text), `nome já existe → vai direto à confirmação | ${brief(r.text)}`);
    });
  }
  await sub("horário inexistente", async () => {
    const c = conv();
    await start(c, { named: true });
    await toTime(c, { day: 5 });
    const r = await say(c, "20h");
    const o = timeOpts(c.last);
    check(T.TIME_NOT_AVAILABLE.test(r.text), `"20h" sem vaga → TIME_NOT_AVAILABLE | ${brief(r.text)}`);
    check(o.length === 3 && contig(parseOptions(c.last)), `mostra os 3 mais próximos (${o.map((x) => x.label).join(",")})`);
    check(o.some((x) => x.label.trim() === "17:00"), "o mais próximo de 20h é 17:00 (último horário do expediente)");
  });
  await sub('"tarde"', async () => {
    const c = conv();
    await start(c, { named: true });
    await toTime(c, { day: 5 });
    const r = await say(c, "tarde");
    const o = timeOpts(c.last);
    check(o.length > 0 && o.every((x) => x.label.trim() >= "12:00" && x.label.trim() < "18:00"), `"tarde" filtra 12:00–17:59 (${o.map((x) => x.label).join(",")}) | ${brief(r.text)}`);
  });
});

scenario("CA-10", "ASK_NAME: comandos navegam; lixo → NAME_INVALID; 61 caracteres → NAME_TOO_LONG; nome válido só é gravado na reserva", "W-1", async () => {
  const toAsk = async () => { const c = conv(); await start(c); await toAfterTime(c, { day: 1 }); if (!T.ASK_NAME.test(c.last)) throw new Error(`não chegou no ASK_NAME: ${brief(c.last)}`); return c; };
  await sub('"voltar"', async () => {
    const c = await toAsk();
    const r = await say(c, "voltar");
    check(T.CHOOSE_TIME.test(r.text), `"voltar" em ASK_NAME volta aos horários | ${brief(r.text)}`);
    check(!(await c.contactRow()).name, "e não grava nome");
  });
  for (const w of ["1", "a", "oi", "sim", "cancelar", "😀😀", ".."]) {
    await sub(`nome "${w}"`, async () => {
      const c = await toAsk();
      const r = await say(c, w);
      // "oi" é saudação (comando) — a spec manda o comando ter prioridade; aceita CONTINUE_PROMPT + ASK_NAME também
      const ok = T.NAME_INVALID.test(r.text) || (w === "oi" && T.CONTINUE_PROMPT.test(r.text) && T.ASK_NAME.test(r.text));
      check(ok, `"${w}" não vira nome (NAME_INVALID) | ${brief(r.text)}`);
      check(!(await c.contactRow()).name, `"${w}" não foi gravado em Contact.name`);
    });
  }
  await sub("61 caracteres", async () => {
    const c = await toAsk();
    const r = await say(c, "Maria ".repeat(11).trim().slice(0, 61).padEnd(61, "a"));
    check(T.NAME_TOO_LONG.test(r.text), `61 caracteres → NAME_TOO_LONG | ${brief(r.text)}`);
    check(!T.INVALID_OPTION.test(r.text), "não responde 'Não entendi sua resposta'");
  });
  await sub("nome válido", async () => {
    const c = await toAsk();
    const r = await say(c, "Maria Souza");
    check(T.CONFIRM_SUMMARY.test(r.text) && r.text.includes("Maria Souza"), `"Maria Souza" leva ao CONFIRM | ${brief(r.text)}`);
    check(!(await c.contactRow()).name, "Contact.name continua vazio até a reserva");
    await c.pick(/Confirmar/);
    check((await c.contactRow()).name === "Maria Souza", "depois de confirmar, Contact.name = Maria Souza", "B-1");
  });
});

scenario("CA-11", "1ª inválida → INVALID_OPTION + prompt; 2ª seguida → INVALID_BACK_TO_MENU + menu, invalidCount=0, sem HandoffRequest", "W-1", async () => {
  const c = conv();
  await start(c, { named: true });
  await toTime(c, { day: 1 });
  const r1 = await say(c, "asdf");
  check(T.INVALID_OPTION.test(r1.text) && T.CHOOSE_TIME.test(r1.text), `1ª inválida: INVALID_OPTION + horários | ${brief(r1.text)}`);
  check((await c.sessionRow()).invalidCount === 1, "invalidCount = 1");
  const r2 = await say(c, "27");
  check(T.INVALID_BACK_TO_MENU.test(r2.text) && opts(c).some((o) => /Agendar/.test(o.label)), `2ª seguida: INVALID_BACK_TO_MENU + menu | ${brief(r2.text)}`);
  const row = await c.sessionRow();
  check(row.invalidCount === 0 && row.state === "MAIN_MENU", `invalidCount=0 e state=MAIN_MENU (=${row.invalidCount}/${row.state})`);
  const hs = await handoffs(await c.contactId());
  check(hs !== null && hs.length === 0, `nenhum HandoffRequest (${hs === null ? "tabela ausente" : hs.length})`, hs === null ? "C-1" : "W-1");
  const r3 = await say(c, "1");
  check(T.CHOOSE_SERVICE.test(r3.text) || T.CHOOSE_DAY.test(r3.text) || T.CHOOSE_PROFESSIONAL.test(r3.text), `o bot continua respondendo depois (não silenciou) | ${brief(r3.text)}`);
});

scenario("CA-12", "Mídia → ONLY_TEXT + prompt, sem somar ao invalidCount", "W-1", async () => {
  const c = conv();
  await start(c, { named: true });
  await toDay(c);
  for (const kind of ["audio", "image", "sticker"]) {
    const r = await say(c, "", { kind });
    check(T.ONLY_TEXT.test(r.text) && T.CHOOSE_DAY.test(r.text), `${kind}: ONLY_TEXT + prompt de dias | ${brief(r.text)}`);
  }
  check((await c.sessionRow()).invalidCount === 0, "mídia não soma ao invalidCount");
  await say(c, "asdf");
  await say(c, "", { kind: "audio" });
  check((await c.sessionRow()).invalidCount === 1, "mídia depois de 1 inválida mantém invalidCount=1");
});

scenario("CA-13", "CONFIRM: sim/s/ok/confirmo/isso/pode ser/Confirmar!/👍/👍🏽/✅ confirmam; não/n/nao/❌ corrigem; \"obrigada\" depois de BOOKED encerra", "W-1", async () => {
  for (const w of ["sim", "s", "ok", "confirmo", "isso", "pode ser", "Confirmar!", "👍", "👍🏽", "✅"]) {
    await sub(`"${w}"`, async () => {
      const c = conv();
      await start(c, { named: true });
      await toConfirm(c, { pro: /Qualquer/, day: 3, time: 0 });
      const r = await say(c, w);
      check(T.BOOKED.test(r.text), `"${w}" confirma | ${brief(r.text)}`);
      if (w === "sim") {
        const r2 = await say(c, "obrigada");
        check(T.THANKS_REPLY.test(r2.text), `"obrigada" depois de BOOKED → THANKS_REPLY | ${brief(r2.text)}`);
        const row = await c.sessionRow();
        check(row.state === "MAIN_MENU" && !(row.context || {}).serviceId, `e encerra a conversa (state=${row.state})`);
      }
    });
  }
  for (const w of ["não", "n", "nao", "❌"]) {
    await sub(`"${w}"`, async () => {
      const c = conv();
      await start(c, { named: true });
      await toConfirm(c, { pro: /Qualquer/, day: 3, time: 1 });
      const r = await say(c, w);
      check(T.CONFIRM_EDIT.test(r.text), `"${w}" abre CONFIRM_EDIT | ${brief(r.text)}`);
    });
  }
});

// ================================================================ fluxo
scenario("CA-14", "Serviços mostram duração e preço; serviço sem preço não mostra R$ e a linha Valor some do CONFIRM", "B-1", async () => {
  const c = conv("bela");
  await start(c, { named: true });
  await c.pick(/Agendar/);
  const o = opts(c);
  const corte = o.find((x) => /Corte feminino/.test(x.label));
  const sobr = o.find((x) => /Sobrancelha/.test(x.label));
  check(corte && /1h/.test(corte.label) && /R\$ 80,00/.test(norm(corte.label)), `Corte feminino mostra "1h" e "R$ 80,00" (${corte && corte.label})`);
  check(sobr && /30 min/.test(sobr.label) && !/R\$/.test(sobr.label), `Sobrancelha (sem preço) mostra "30 min" e nenhum R$ (${sobr && sobr.label})`);
  check(o.filter((x) => !/Ver mais|anteriores/i.test(x.label)).every((x) => /(\d+ ?min|\dh)/.test(x.label)), "todo serviço listado tem duração");
  await c.pick(/Sobrancelha/);
  await fromDay(c, { day: 1 });
  check(T.CONFIRM_SUMMARY.test(c.last), `chegou na confirmação de Sobrancelha | ${brief(c.last)}`);
  check(!/Valor/.test(c.last) && !/R\$/.test(c.last), "CONFIRM sem preço não tem a linha Valor nem R$");
  check(/duração de 30 min/.test(c.last), "CONFIRM mostra a duração");
  const c2 = conv("bela");
  await start(c2, { named: true });
  await toConfirm(c2, { service: /Corte feminino/, pro: /Ana/, day: 1 });
  check(/\*Valor:\* R\$ 80,00/.test(norm(c2.last)), `CONFIRM de Corte feminino mostra "*Valor:* R$ 80,00" | ${brief(c2.last)}`);
});

scenario("CA-15", '"Qualquer profissional" é a 1ª opção com 2+ profissionais; BOOKED mostra o nome real', "W-1", async () => {
  const c = conv();
  await start(c, { named: true });
  await c.pick(/Agendar/);
  await c.pick(/Corte/);
  const o = opts(c);
  check(o[0] && /Qualquer profissional/.test(o[0].label) && o[0].n === 1, `1ª opção = Qualquer profissional (${o.map((x) => x.label).join(" | ")})`);
  check(o.some((x) => /Ana/.test(x.label)) && o.some((x) => /Júlia/.test(x.label)), "lista também as profissionais");
  await c.pick(/Qualquer/);
  const d = dayOpts(c.last)[2];
  await say(c, String(d.n));
  await say(c, String(timeOpts(c.last)[0].n));
  check(/\*Profissional:\* Primeiro dispon[ií]vel/.test(c.last), `CONFIRM mostra "Primeiro disponível" | ${brief(c.last)}`);
  const r = await c.pick(/Confirmar/);
  check(T.BOOKED.test(r.text) && /com (Ana|Júlia)/.test(r.text) && !/Qualquer|Primeiro/.test(r.text.split("Posso ajudar")[0]), `BOOKED mostra o nome real | ${brief(r.text)}`);
});

scenario("CA-16", '"Primeiro horário livre": até 6 horários em ordem, respeitando minLeadTimeMin', "B-1", async () => {
  const c = conv();
  await start(c, { named: true });
  await toDay(c);
  const firstFree = opts(c).find((x) => /Primeiro horário livre/.test(x.label));
  check(!!firstFree, `a lista de dias tem "Primeiro horário livre" | ${brief(c.last)}`);
  if (!firstFree) return;
  const r = await say(c, String(firstFree.n));
  check(T.NEXT_AVAILABLE.test(r.text), `abre NEXT_SLOTS | ${brief(r.text)}`, "W-1");
  const o = opts(c);
  const times = o.filter((x) => /\d\d:\d\d/.test(x.label) && !/Escolher/.test(x.label));
  check(times.length >= 1 && times.length <= 6, `no máximo 6 horários (${times.length})`);
  check(/Escolher por dia/.test(o[o.length - 1].label), "última opção = Escolher por dia", "W-1");
  const t = S("dupla");
  const a = await api2("dupla", "GET", `/availability/next?serviceId=${t.services.Corte}&professionalId=${t.pros.ana}&limit=6`);
  const ao = (a.body && a.body.options) || [];
  check(a.status === 200 && ao.length === 6, `API /availability/next devolve 6 (status ${a.status}, ${ao.length})`);
  check(ao.every((x, i) => i === 0 || Date.parse(x.id) > Date.parse(ao[i - 1].id)), "horários em ordem crescente");
  check(ao[0] && Date.parse(ao[0].id) >= Date.now() + 60 * 60_000 - 60_000, `respeita minLeadTimeMin=60 (1º = ${ao[0] && ao[0].id})`);
  check(ao.length && times.map((x) => norm(x.label)).join("|") === ao.slice(0, times.length).map((x) => norm(x.label)).join("|"), `a mensagem lista os mesmos horários da API (${times.map((x) => x.label).join(" | ")})`, "W-1");
  if (times.length) {
    await say(c, String(times[0].n));
    const ctx = await ctxOf(c);
    check(ao[0] && ctx.startsAt && Date.parse(ctx.startsAt) === Date.parse(ao[0].id), `escolher o 1º grava startsAt=${ctx.startsAt}`, "W-1");
  }
});

scenario("CA-17", "Data com a empresa fechada → NO_SLOTS_DAY com {proximo} e lista a partir dele; além do horizonte → DATE_OUT_OF_RANGE", "W-1", async () => {
  const today = todayOf("bela");
  let sunday = addDaysISO(today, 1);
  while (weekdayOfISO(sunday) !== 0) sunday = addDaysISO(sunday, 1);
  const monday = addDaysISO(sunday, 1);
  const fmt = (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}`;
  await sub("domingo fechado", async () => {
    const c = conv("bela");
    await start(c, { named: true });
    await toDay(c, { service: /Manicure/ });
    const r = await say(c, fmt(sunday));
    check(T.NO_SLOTS_DAY.test(r.text) && r.text.includes(ddmm(monday)), `domingo ${ddmm(sunday)} → NO_SLOTS_DAY com {proximo}=${ddmm(monday)} | ${brief(r.text)}`);
    const days = dayOpts(c.last);
    check(days.length > 0 && days[0].label.includes(ddmm(monday)) && !days.some((x) => x.label.includes(ddmm(sunday))), `a lista começa em ${ddmm(monday)} e não traz o domingo (${days.map((x) => x.label).join(", ")})`);
  });
  await sub("além do horizonte", async () => {
    const c = conv("bela");
    await start(c, { named: true });
    await toDay(c, { service: /Manicure/ });
    const far = addDaysISO(today, 45);
    const r = await say(c, fmt(far));
    check(T.DATE_OUT_OF_RANGE.test(r.text), `data a +45 dias → DATE_OUT_OF_RANGE | ${brief(r.text)}`);
    const t = S("bela");
    const api1 = await api2("bela", "GET", `/availability/days?serviceId=${t.services.Manicure}&professionalId=${t.pros.ana}&from=${today}&limit=1`);
    const last = api1.body && api1.body.lastBookableDate && api1.body.lastBookableDate.id;
    check(last && r.text.includes(ddmm(last)), `o último dia permitido (${last}) aparece na mensagem`, "B-1");
    check(dayOpts(c.last).length > 0, "e a lista de dias é mostrada de novo");
  });
});

scenario("CA-18", "Paginação (serviços, dias, horários, agendamentos): 1..n sem pular, Ver mais só se houver, Ver anteriores da 2ª em diante, sem repetir, sem volta cíclica", "W-1", async () => {
  const noRepeat = (a, b) => !a.some((x) => b.some((y) => labelOf(x) === labelOf(y)));
  await sub("serviços", async () => {
    const c = conv("bela");
    await start(c, { named: true });
    await c.pick(/Agendar/);
    const p1 = opts(c);
    check(contig(p1) && p1.length === 9 && /Ver mais/.test(p1[8].label) && !p1.some((x) => /anteriores/i.test(x.label)), `pág. 1: 1..9 contínuos, termina em "Ver mais", sem "Ver anteriores" (${p1.map((x) => x.n).join(",")})`);
    await c.pick(/Ver mais/);
    const p2 = opts(c);
    check(contig(p2) && p2.some((x) => /anteriores/i.test(x.label)) && !p2.some((x) => /Ver mais/.test(x.label)), `pág. 2: contínua, tem "Ver anteriores", não tem "Ver mais" (não é cíclica) (${p2.map((x) => `${x.n}:${labelOf(x)}`).join(", ")})`);
    check(noRepeat(p1.filter((x) => !/Ver /.test(x.label)), p2.filter((x) => !/Ver /.test(x.label))), "nenhum serviço repetido entre páginas");
    await c.pick(/anteriores/i);
    check(opts(c).map((x) => labelOf(x)).join("|") === p1.map((x) => labelOf(x)).join("|"), '"Ver anteriores" volta à página 1');
  });
  await sub("dias", async () => {
    const c = conv("bela");
    await start(c, { named: true });
    await toDay(c, { service: /Corte feminino/, pro: /Ana/ });
    const p1 = opts(c);
    check(contig(p1) && p1.some((x) => /Ver mais datas/.test(x.label)), `dias pág. 1 contínua e com "Ver mais datas" (${p1.map((x) => x.n).join(",")})`);
    const d1 = dayOpts(c.last);
    await c.pick(/Ver mais datas/);
    const p2 = opts(c);
    const d2 = dayOpts(c.last);
    check(contig(p2) && p2.some((x) => /anteriores/i.test(x.label)), `dias pág. 2 contínua e com "Ver anteriores" (${p2.map((x) => x.n).join(",")})`);
    check(noRepeat(d1, d2), `nenhum dia repetido (p1=${d1.map((x) => x.label).join(",")} | p2=${d2.map((x) => x.label).join(",")})`, "B-1");
  });
  await sub("horários", async () => {
    const c = conv("bela");
    await start(c, { named: true });
    await toTime(c, { service: /Corte feminino/, pro: /Ana/, day: 2 });
    const p1 = opts(c);
    check(contig(p1) && timeOpts(c.last).length === 7 && p1.some((x) => /Mais horários/.test(x.label)) && !p1.some((x) => /anteriores/i.test(x.label)), `horários pág. 1: 7 + "Mais horários" (${p1.map((x) => x.label).join(",")})`);
    await c.pick(/Mais horários/);
    const p2 = opts(c);
    check(contig(p2) && p2.some((x) => /anteriores/i.test(x.label)), `horários pág. 2: numeração recomeça em 1 e tem "Ver anteriores" (${p2.map((x) => `${x.n}:${x.label}`).join(",")})`);
    check(noRepeat(timeOpts(c.last), p1.filter((x) => /^\d\d:\d\d$/.test(x.label.trim()))), "nenhum horário repetido");
    if (p2.some((x) => /Mais horários/.test(x.label))) await c.pick(/Mais horários/);
    const last = opts(c);
    check(!last.some((x) => /Mais horários/.test(x.label)), `na última página não há "Mais horários" (não é cíclica) (${last.map((x) => x.label).join(",")})`);
  });
  await sub("agendamentos", async () => {
    const c = conv("dupla");
    await start(c, { named: true });
    const cid = await c.contactId();
    const t = S("dupla");
    for (let i = 0; i < 11; i++) {
      const slot = await freeSlot("dupla", t.services.Corte, t.pros.ana, 8 + i);
      const r = await createAppt("dupla", { contactId: cid, serviceId: t.services.Corte, professionalId: t.pros.ana, startsAt: slot.iso, key: `ca18-${c.phone}-${i}` });
      if (r.status >= 300) throw new Error(`seed do agendamento ${i}: ${r.status} ${J(r.body)}`);
    }
    await say(c, "2");
    const p1 = opts(c);
    check(contig(p1) && p1.length === 9 && /Ver mais/.test(p1[8].label), `agendamentos pág. 1: 8 + "Ver mais" (${p1.length} opções) | ${brief(c.last)}`);
    await c.pick(/Ver mais/);
    const p2 = opts(c);
    check(contig(p2) && p2.some((x) => /anteriores/i.test(x.label)) && !p2.some((x) => /Ver mais/.test(x.label)), `pág. 2: 3 restantes + "Ver anteriores", sem "Ver mais" (${p2.map((x) => x.n).join(",")})`);
    check(noRepeat(p1, p2), "nenhum agendamento repetido");
  });
});

scenario("CA-19", 'CONFIRM com os 7 campos; "Corrigir → Profissional": mesmo horário livre volta direto, ocupado → SELECT_TIME do dia', "W-1", async () => {
  await sub("7 campos + profissional livre", async () => {
    const c = conv();
    await start(c, { named: "Nome Completo" });
    await toConfirm(c, { pro: /Ana/, day: 1, time: 0 });
    for (const [name, re] of [["Serviço", /\*Serviço:\*/], ["Profissional", /\*Profissional:\*/], ["Data", /\*Data:\*/], ["Horário", /\*Horário:\*/], ["Duração", /duração de/], ["Valor", /\*Valor:\*/], ["Nome", /\*Nome:\*/]]) check(re.test(c.last), `CONFIRM tem o campo ${name}`);
    const before = c.last.match(/\*Horário:\* (\d\d:\d\d)/);
    await c.pick(/Corrigir/);
    check(T.CONFIRM_EDIT.test(c.last), "Corrigir abre CONFIRM_EDIT");
    check(["Serviço", "Profissional", "Data e horário", "Nome"].every((n, i) => opts(c)[i] && opts(c)[i].label.includes(n)), `CONFIRM_EDIT: Serviço/Profissional/Data e horário/Nome (${opts(c).map((x) => x.label).join(" | ")})`);
    await c.pick(/Profissional/);
    check(T.CHOOSE_PROFESSIONAL.test(c.last), "abre a lista de profissionais");
    const r = await c.pick(/Júlia/);
    check(T.CONFIRM_SUMMARY.test(r.text) && /\*Profissional:\* Júlia/.test(r.text) && before && r.text.includes(`*Horário:* ${before[1]}`), `mesmo horário livre → volta direto ao CONFIRM com Júlia | ${brief(r.text)}`);
  });
  await sub("profissional ocupada", async () => {
    const c = conv();
    await start(c, { named: "Nome Completo" });
    await toConfirm(c, { pro: /Ana/, day: 1, time: 0 });
    const ctx = await ctxOf(c);
    const other = conv();
    await start(other, { named: true });
    const t = S("dupla");
    const occ = await createAppt("dupla", { contactId: await other.contactId(), serviceId: t.services.Corte, professionalId: t.pros.julia, startsAt: ctx.startsAt, key: `ca19-${c.phone}` });
    check(occ.status === 201, `Júlia ocupada no mesmo horário (${occ.status})`);
    await c.pick(/Corrigir/);
    await c.pick(/Profissional/);
    const r = await c.pick(/Júlia/);
    check(T.CHOOSE_TIME.test(r.text) && !T.CONFIRM_SUMMARY.test(r.text), `ocupado → horários do mesmo dia | ${brief(r.text)}`);
  });
});

scenario("CA-20", '"Corrigir → Nome" atualiza o resumo e o nome é gravado na reserva; "Agendar outro" não pede o nome de novo', "W-1", async () => {
  const c = conv();
  await start(c);
  await toConfirm(c, { pro: /Ana/, day: 2, time: 0, name: "Ana Primeira" });
  check(c.last.includes("Ana Primeira"), "resumo com o 1º nome");
  await c.pick(/Corrigir/);
  await c.pick(/Nome/);
  check(T.ASK_NAME.test(c.last), `Corrigir → Nome pede o nome | ${brief(c.last)}`);
  const r = await say(c, "Beatriz Segunda");
  check(T.CONFIRM_SUMMARY.test(r.text) && r.text.includes("Beatriz Segunda") && !r.text.includes("Ana Primeira"), `resumo atualizado | ${brief(r.text)}`);
  const b = await c.pick(/Confirmar/);
  check(T.BOOKED.test(b.text), "reserva feita");
  check((await c.contactRow()).name === "Beatriz Segunda", `Contact.name gravado na reserva (=${(await c.contactRow()).name})`, "B-1");
  await c.pick(/Agendar outro/);
  await c.pick(/Corte/);
  if (T.CHOOSE_PROFESSIONAL.test(c.last)) await c.pick(/Ana/);
  await say(c, String(dayOpts(c.last)[3].n));
  const r2 = await say(c, String(timeOpts(c.last)[0].n));
  check(!T.ASK_NAME.test(r2.text) && T.CONFIRM_SUMMARY.test(r2.text), `"Agendar outro" não pede o nome de novo | ${brief(r2.text)}`);
});

scenario("CA-21", "Duas sessões confirmam o mesmo horário: uma BOOKED, outra SLOT_TAKEN com {data} do dia das alternativas; exatamente 1 Appointment", "W-1", async () => {
  const a = conv();
  const b = conv();
  await start(a, { named: true });
  await start(b, { named: true });
  await toConfirm(a, { pro: /Ana/, day: 3, time: 0 });
  await toConfirm(b, { pro: /Ana/, day: 3, time: 0 });
  const ctxA = await ctxOf(a);
  const ctxB = await ctxOf(b);
  check(ctxA.startsAt && ctxA.startsAt === ctxB.startsAt, `as duas sessões miram o mesmo horário (${ctxA.startsAt} / ${ctxB.startsAt})`);
  const numOf = (c) => opts(c).find((x) => /Confirmar/.test(x.label)).n;
  const [ra, rb] = await Promise.all([a.say(String(numOf(a))), b.say(String(numOf(b)))]);
  const texts = [ra.msgs.join("\n"), rb.msgs.join("\n")];
  const booked = texts.filter((t) => T.BOOKED.test(t));
  const taken = texts.filter((t) => T.SLOT_TAKEN.test(t));
  check(booked.length === 1 && taken.length === 1, `uma BOOKED e uma SLOT_TAKEN (${texts.map((t) => firstLine(t)).join(" || ")})`);
  const loser = taken[0] || "";
  check(loser.includes(ddmm(ctxA.date)) && T.CHOOSE_TIME.test(loser), `SLOT_TAKEN traz a data do dia das alternativas (${ddmm(ctxA.date)}) | ${brief(loser)}`, "B-1");
  const n = await sql(`SELECT count(*)::int AS n FROM appointments WHERE "professionalId" = $1 AND "startsAt" = $2 AND status = 'SCHEDULED'`, S("dupla").pros.ana, new Date(ctxA.startsAt));
  check(n[0].n === 1, `exatamente 1 Appointment no horário (=${n[0].n})`);
});

scenario("CA-22", "Depois de BOOKED: Agendar outro / Meus agendamentos / Encerrar", "W-1", async () => {
  const c = conv();
  const r = await book(c, { pro: /Ana/, day: 4, time: 0 });
  check(r.msgs.length === 2 && T.BOOKED.test(r.msgs[0]) && !T.POST_ACTION_MENU.test(r.msgs[0]) && T.POST_ACTION_MENU.test(r.msgs[1]), `BOOKED sozinho + POST_ACTION na 2ª mensagem (${r.msgs.length} mensagem(ns)) | ${brief(r.text)}`);
  const o = opts(c);
  check(o.length === 3 && /Agendar outro/.test(o[0].label) && /Meus agendamentos/.test(o[1].label) && /Encerrar/.test(o[2].label), `opções: Agendar outro / Meus agendamentos / Encerrar (${o.map((x) => x.label).join(" | ")})`);
  // Cancelamento concluído: confirmação sozinha + POST_ACTION na 2ª mensagem.
  await c.pick(/Meus agendamentos/);
  await c.pick(/Cancelar/);
  const rc = await c.pick(/Sim/);
  check(rc.msgs.length === 2 && T.CANCELED.test(rc.msgs[0]) && !T.POST_ACTION_MENU.test(rc.msgs[0]) && T.POST_ACTION_MENU.test(rc.msgs[1]), `CANCELED sozinho + POST_ACTION na 2ª mensagem (${rc.msgs.length} mensagem(ns)) | ${brief(rc.text)}`);
  const e = await c.pick(/Encerrar/);
  const row = await c.sessionRow();
  check(row.state === "MAIN_MENU" && !(row.context || {}).serviceId, `Encerrar fecha a conversa (state=${row.state}) | ${brief(e.text)}`);
});

scenario("CA-23", "Meus agendamentos: 1 item → detalhe direto; 0 → NO_APPOINTMENTS + POST_ACTION", "W-1", async () => {
  const c = conv();
  await book(c, { pro: /Ana/, day: 4, time: 1 });
  const r = await c.pick(/Meus agendamentos/);
  check(T.APPOINTMENT_DETAIL.test(r.text) && !T.MY_APPOINTMENTS.test(r.text), `1 agendamento → detalhe direto | ${brief(r.text)}`);
  const o = opts(c);
  check(o.some((x) => /Remarcar/.test(x.label)) && o.some((x) => /Cancelar/.test(x.label)) && o.some((x) => /Voltar/.test(x.label)), `detalhe com Remarcar / Cancelar / Voltar (${o.map((x) => x.label).join(" | ")})`);
  const z = conv();
  await start(z);
  const r0 = await say(z, "2");
  check(T.NO_APPOINTMENTS.test(r0.text) && T.POST_ACTION_MENU.test(r0.text), `0 agendamentos → NO_APPOINTMENTS + POST_ACTION | ${brief(r0.text)}`);
  check(opts(z).some((x) => /Agendar outro/.test(x.label)) && opts(z).some((x) => /Encerrar/.test(x.label)), "com as opções de POST_ACTION");
});

scenario("CA-24", "Dentro do prazo → APPOINTMENT_LOCKED com {prazo}, sem remarcar/cancelar; TOO_LATE forçado → texto TOO_LATE + atendente", "W-1", async () => {
  const p = await db();
  const t = S("dupla");
  const mkPro = async (name) => {
    const eva = await p.professional.create({ data: { tenantId: t.tenantId, name: `${name} ${Date.now() % 100000}`, sortOrder: 9, workingHours: { create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "00:00", endTime: "23:59" })) } } });
    await p.professionalService.create({ data: { professionalId: eva.id, serviceId: t.services.Corte } });
    return eva;
  };
  const mkAppt = async (contactId, professionalId, minutes) => {
    const s = new Date(Date.now() + minutes * 60_000);
    s.setUTCSeconds(0, 0);
    const e = new Date(s.getTime() + 3600_000);
    return p.appointment.create({ data: { tenantId: t.tenantId, contactId, serviceId: t.services.Corte, professionalId, startsAt: s, endsAt: e, blockEndsAt: e, status: "SCHEDULED", source: "WHATSAPP" } });
  };
  const pros = [];
  try {
    await sub("dentro do prazo", async () => {
      const eva = await mkPro("Eva");
      pros.push(eva.id);
      const c = conv();
      await start(c, { named: true });
      await mkAppt(await c.contactId(), eva.id, 90);
      const r = await say(c, "2");
      check(T.APPOINTMENT_LOCKED.test(r.text) && /2 horas/.test(r.text), `agendamento a 90 min → APPOINTMENT_LOCKED com {prazo}="2 horas" | ${brief(r.text)}`);
      const o = opts(c);
      check(!o.some((x) => /Remarcar|Cancelar/.test(x.label)) && o.some((x) => /atendente/i.test(x.label)) && o.some((x) => /Voltar/.test(x.label)), `sem Remarcar/Cancelar; com atendente e Voltar (${o.map((x) => x.label).join(" | ")})`);
    });
    await sub("TOO_LATE forçado", async () => {
      const eva = await mkPro("Eda");
      pros.push(eva.id);
      const c = conv();
      await start(c, { named: true });
      const ap = await mkAppt(await c.contactId(), eva.id, 125);
      const r = await say(c, "2");
      check(T.APPOINTMENT_DETAIL.test(r.text) && opts(c).some((x) => /Cancelar/.test(x.label)), `a 125 min ainda pode alterar | ${brief(r.text)}`);
      const s = new Date(Date.now() + 90 * 60_000);
      s.setUTCSeconds(0, 0);
      await p.appointment.update({ where: { id: ap.id }, data: { startsAt: s, endsAt: new Date(s.getTime() + 3600_000), blockEndsAt: new Date(s.getTime() + 3600_000) } });
      await c.pick(/Cancelar/);
      const r2 = await c.pick(/Sim/);
      check(T.TOO_LATE.test(r2.text) && opts(c).some((x) => /atendente/i.test(x.label)), `prazo venceu entre a lista e a escolha → TOO_LATE + atendente | ${brief(r2.text)}`);
    });
  } finally {
    for (const id of pros) {
      await p.appointment.deleteMany({ where: { professionalId: id } });
      await p.professional.delete({ where: { id } });
    }
  }
});

scenario("CA-25", "Remarcar → CONFIRM_RESCHEDULE com \"De\" riscado → RESCHEDULED, sem criar outro agendamento", "W-1", async () => {
  const c = conv();
  await book(c, { pro: /Ana/, day: 3, time: 2 });
  const p = await db();
  const before = await p.appointment.findMany({ where: { contactId: await c.contactId() } });
  await c.pick(/Meus agendamentos/);
  await c.pick(/Remarcar/);
  check(T.CHOOSE_DAY.test(c.last), `Remarcar abre a escolha de dia | ${brief(c.last)}`);
  await say(c, String(dayOpts(c.last)[5].n));
  const r = await say(c, String(timeOpts(c.last)[0].n));
  check(T.CONFIRM_RESCHEDULE.test(r.text) && /\*De:\* ~.+~/.test(r.text) && /\*Para:\*/.test(r.text), `CONFIRM_RESCHEDULE com "De" riscado | ${brief(r.text)}`);
  const r2 = await c.pick(/Confirmar/);
  check(r2.msgs.length === 2 && T.RESCHEDULED.test(r2.msgs[0]) && !T.POST_ACTION_MENU.test(r2.msgs[0]) && T.POST_ACTION_MENU.test(r2.msgs[1]), `RESCHEDULED sozinho + POST_ACTION na 2ª mensagem (${r2.msgs.length}) | ${brief(r2.text)}`);
  const after = await p.appointment.findMany({ where: { contactId: await c.contactId() } });
  check(after.length === 1 && before.length === 1 && after[0].status === "SCHEDULED" && after[0].startsAt.getTime() !== before[0].startsAt.getTime(), `continua 1 agendamento, em outro horário (${after.length} linha(s))`);
});

scenario("CA-26", "Handoff dentro do horário → HUMAN_HANDOFF com {retorno}; fora → HUMAN_HANDOFF_OFF_HOURS com {proximo} (sino: E2E)", "B-2", async () => {
  const tz = TZ.equipe;
  const tenant = await getTenant("equipe");
  const minutes = tenant.handoffResumeMinutes;
  check(typeof minutes === "number", `Tenant.handoffResumeMinutes existe (=${minutes})`, "C-1");
  try {
    await setTeamHours("equipe", "open");
    const c = conv("equipe");
    await start(c);
    const r = await say(c, "atendente");
    check(T.HUMAN_HANDOFF.test(r.text), `dentro do horário → HUMAN_HANDOFF | ${brief(r.text)}`, "W-1");
    const m = r.text.match(/até (.+?), eu volto/);
    const expect = whenLabelsAround(new Date(Date.now() + (minutes || 120) * 60_000), tz);
    check(m && expect.includes(m[1].trim()), `{retorno} = agora + ${minutes} min (${m && m[1]}; esperado um de: ${expect.join(" | ")})`, "B-2");
    const hs = await handoffs(await c.contactId());
    check(hs && hs.length === 1 && hs[0].offHours === false, `HandoffRequest com offHours=false (${hs && J(hs.map((h) => h.offHours))})`, "B-2");
    await setTeamHours("equipe", "closed");
    const c2 = conv("equipe");
    await start(c2);
    const r2 = await say(c2, "atendente");
    check(T.HUMAN_HANDOFF_OFF_HOURS.test(r2.text), `fora do horário → HUMAN_HANDOFF_OFF_HOURS | ${brief(r2.text)}`, "W-1");
    check(/Voltamos \*amanhã às 09:00\*/.test(r2.text), `{proximo} = "amanhã às 09:00" | ${brief(r2.text)}`, "B-2");
    const hs2 = await handoffs(await c2.contactId());
    check(hs2 && hs2.length === 1 && hs2[0].offHours === true, `HandoffRequest com offHours=true (${hs2 && J(hs2.map((h) => h.offHours))})`, "B-2");
  } finally {
    await setTeamHours("equipe", "open");
  }
});

scenario("CA-27", "Sessão parada há 40 min → GREETING + RESUME_OFFER (\"Continuar\" rebusca); >25 h → saudação + menu; resposta ao lembrete depois de horas", "B-2", async () => {
  await sub("40 min", async () => {
    const c = conv();
    await start(c, { named: true });
    await toTime(c, { day: 2 });
    await ageSession(c, 40);
    const r = await say(c, "oi");
    check(T.GREETING.test(r.text) && T.RESUME_OFFER.test(r.text), `40 min parado: GREETING + RESUME_OFFER | ${brief(r.text)}`, "W-1");
    check(opts(c).some((x) => /Continuar/.test(x.label)) && opts(c).some((x) => /Começar de novo/.test(x.label)), "com Continuar / Começar de novo");
    const r2 = await c.pick(/Continuar/);
    check(T.CHOOSE_TIME.test(r2.text) && timeOpts(c.last).length > 0, `Continuar reentra nos horários | ${brief(r2.text)}`, "W-1");
    check(r2.calls.some((x) => /availability\/slots/.test(x.url)), "os horários foram buscados de novo");
  });
  await sub("26 h", async () => {
    const c = conv();
    await start(c, { named: true });
    await toTime(c, { day: 2 });
    await ageSession(c, 26 * 60);
    const r = await say(c, "oi");
    check(T.GREETING.test(r.text) && !T.RESUME_OFFER.test(r.text) && opts(c).some((x) => /Agendar/.test(x.label)), `26 h parado: saudação + menu, sem oferta | ${brief(r.text)}`, "W-1");
  });
  for (const w of ["menu", "2", "cancelar", "remarcar", "meus agendamentos"]) {
    await sub(`lembrete + "${w}"`, async () => {
      const c = conv();
      await start(c, { named: true });
      await ageSession(c, 20 * 60);
      const r = await say(c, w);
      if (w === "menu") check(!T.SESSION_EXPIRED.test(r.text) && opts(c).some((x) => /Agendar/.test(x.label)), `"menu" a um lembrete: menu sem "recomecei" | ${brief(r.text)}`, "W-1");
      else check((T.NO_APPOINTMENTS.test(r.text) || T.MY_APPOINTMENTS.test(r.text)) && !T.SESSION_EXPIRED.test(r.text), `"${w}" depois de 20 h vai para Meus agendamentos | ${brief(r.text)}`, "W-1");
    });
  }
});

scenario("CA-28", '"oi" no meio do fluxo → CONTINUE_PROMPT + prompt atual', "W-1", async () => {
  for (const w of ["oi", "Bom dia", "olá"]) {
    await sub(`"${w}"`, async () => {
      const c = conv();
      await start(c, { named: true });
      await toDay(c);
      const r = await say(c, w);
      check(T.CONTINUE_PROMPT.test(r.text) && T.CHOOSE_DAY.test(r.text), `"${w}" em SELECT_DAY → CONTINUE_PROMPT + dias | ${brief(r.text)}`);
      check((await c.sessionRow()).state === "SELECT_DAY", "estado mantido");
    });
  }
});

scenario("CA-29", "Painel respondendo 500/timeout em /availability/slots → TECH_ERROR, sessão no mesmo estado, trava liberada; repetir funciona", "W-1", async () => {
  for (const fault of [500, "timeout"]) {
    await sub(`falha ${fault}`, async () => {
      const c = conv();
      await start(c, { named: true });
      await toDay(c);
      const d = dayOpts(c.last)[1];
      const r = await say(c, String(d.n), { faults: [{ urlRe: /availability\/slots/, status: fault }] });
      check(T.TECH_ERROR.test(r.text), `${fault}: TECH_ERROR | ${brief(r.text)}`);
      check(r.error === null, `${fault}: a execução não morreu (erro=${r.error})`);
      const row = await c.sessionRow();
      check(row.state === "SELECT_DAY", `${fault}: sessão salva no mesmo estado (=${row.state})`);
      check(!row.lockToken, `${fault}: trava liberada`);
      const r2 = await say(c, String(d.n));
      check(T.CHOOSE_TIME.test(r2.text), `${fault}: repetir a escolha com o painel de volta funciona | ${brief(r2.text)}`);
    });
  }
});

scenario("CA-30", "Serviço desativado com a lista aberta → ITEM_UNAVAILABLE + lista nova; profissional desativada → idem na lista de profissionais", "W-1", async () => {
  const p = await db();
  const t = S("bela");
  await sub("serviço desativado", async () => {
    const c = conv("bela");
    await start(c, { named: true });
    await c.pick(/Agendar/);
    try {
      await p.service.update({ where: { id: t.services["Hidratação"] }, data: { active: false } });
      const r = await c.pick(/Hidratação/);
      check(T.ITEM_UNAVAILABLE.test(r.text) && T.CHOOSE_SERVICE.test(r.text), `serviço desativado → ITEM_UNAVAILABLE + lista de serviços | ${brief(r.text)}`);
      check(!opts(c).some((x) => /Hidratação/.test(x.label)), "a lista nova não traz o serviço desativado");
    } finally {
      await p.service.update({ where: { id: t.services["Hidratação"] }, data: { active: true } });
    }
  });
  await sub("profissional desativada", async () => {
    const c = conv("bela");
    await start(c, { named: true });
    await c.pick(/Agendar/);
    await c.pick(/Corte feminino/);
    check(T.CHOOSE_PROFESSIONAL.test(c.last), "lista de profissionais aberta");
    try {
      await p.professional.update({ where: { id: t.pros.bruno }, data: { active: false } });
      const r = await c.pick(/Bruno/);
      check(T.ITEM_UNAVAILABLE.test(r.text) && T.CHOOSE_PROFESSIONAL.test(r.text), `profissional desativada → ITEM_UNAVAILABLE + lista de profissionais | ${brief(r.text)}`);
      check(!opts(c).some((x) => /Bruno/.test(x.label)), "a lista nova não traz a profissional desativada");
    } finally {
      await p.professional.update({ where: { id: t.pros.bruno }, data: { active: true } });
    }
  });
});

scenario("CA-31", "Execução que morre antes de salvar → o cliente recebe TECH_ERROR via release (Evolution falsa); 2ª falha em <10 min não repete", "B-2", async () => {
  await ensureFake();
  await clearFakeSent();
  const c = conv();
  await start(c, { named: true });
  check(world.engine.byName.has("Montar mensagem"), 'o workflow tem o nó "Montar mensagem" (usado para forçar a falha)', "W-1");
  const crash = [{ node: "Montar mensagem", crash: true }];
  const r = await say(c, "1", { faults: crash });
  check(r.error && r.msgs.length === 0, `a execução morreu antes de enviar (erro=${r.error}, respostas=${r.msgs.length})`, "W-1");
  const rel = r.res.release;
  check(rel && rel.status === 200 && rel.body && rel.body.released === true, `release respondeu 200 { released: true } (${J(rel)})`);
  check(rel && rel.body && rel.body.notified === true, `release avisou o cliente (notified=${rel && rel.body && rel.body.notified})`, "B-2");
  let sent = (await fakeSent()).filter((x) => x.number.includes(c.phone));
  check(sent.length === 1 && T.TECH_ERROR.test(sent[0].text), `a Evolution falsa recebeu 1 TECH_ERROR para o cliente (${sent.length}: ${sent.map((x) => firstLine(x.text)).join(" | ")})`, "B-2");
  const r2 = await say(c, "1", { faults: crash });
  check(r2.error, "2ª falha: a execução morreu de novo");
  check(r2.res.release && r2.res.release.body && r2.res.release.body.notified === false, `2ª falha em <10 min: notified=false (${J(r2.res.release && r2.res.release.body)})`, "B-2");
  sent = (await fakeSent()).filter((x) => x.number.includes(c.phone));
  check(sent.length === 1, `e a Evolution não recebeu um 2º aviso (${sent.length})`, "B-2");
  const row = await c.sessionRow();
  check(!row.lockToken, "trava liberada");
  const r3 = await say(c, "1");
  check(r3.error === null && r3.msgs.length === 1, `depois da falha o bot volta a responder | ${brief(r3.text)}`);
});
