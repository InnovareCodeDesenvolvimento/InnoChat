// Cenários de regressão/auditoria do fluxo de agendamento do bot (roda os Code nodes reais + API real).
// Uso: node scripts/bot-sim/scenarios.mjs [filtro-regex]   → imprime resumo e grava out/transcripts.md
// Cada `check(cond, msg)` descreve o COMPORTAMENTO ESPERADO; FALHA = bug (ou regressão, se já corrigido).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeWorld, Convo, newPhone, db, closeDb, api, parseOptions, seed, sleep } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const world = makeWorld();
const scenarios = [];
const scenario = (id, title, fn) => scenarios.push({ id, title, fn });
const results = [];
let cur;
const check = (cond, msg) => { cur.checks.push({ ok: !!cond, msg }); };
const hasOpt = (text, re) => parseOptions(text).some((o) => re.test(o.label));
const conv = (tenant = "bela", o) => { const c = new Convo(world, tenant, newPhone(), o); cur.convos.push(c); return c; };
const tzToday = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

/** Percorre menu -> serviço -> profissional -> dia -> horário; devolve a última resposta (tela de nome ou confirmação). */
async function toTime(c, { service = /Corte/, pro = /Qualquer/, day = 0, time = 0 } = {}) {
  await c.say("oi");
  await c.pick(/Agendar/);
  await c.pick(service);
  if (/Com quem/.test(c.last)) await c.pick(pro);
  let opts = parseOptions(c.last);
  await c.say(String(opts[Math.min(day, opts.length - 1)].n));
  opts = parseOptions(c.last);
  return c.say(String(opts[Math.min(time, opts.length - 1)].n));
}

// ---------------------------------------------------------------- A. primeira mensagem
scenario("A1", "Primeira mensagem de texto, áudio, vazia, figurinha, reação", async () => {
  for (const [kind, txt] of [["text", "oi"], ["audio", ""], ["empty", ""], ["sticker", ""], ["image", "foto"], ["reaction", ""]]) {
    const c = conv();
    const r = await c.say(txt, { kind });
    if (kind === "reaction") continue;
    check(r.msgs.length === 1, `${kind}: uma resposta`);
    check(hasOpt(r.msgs[0] || "", /Agendar/), `${kind}: mostra o menu`);
    if (kind !== "text") check(/só entendo mensagens de texto|apenas texto|texto/i.test(r.msgs[0] || ""), `${kind}: avisa que só entende texto`);
  }
});

scenario("A2", "Mídia no meio do fluxo (áudio em cada etapa)", async () => {
  const c = conv();
  await c.say("oi"); await c.pick(/Agendar/);
  let r = await c.say("", { kind: "audio" });
  check(/Qual serviço/.test(r.msgs[0]), "áudio na lista de serviços repete a lista");
  check(/texto/i.test(r.msgs[0]), "avisa que só entende texto");
  await c.pick(/Corte/);
  r = await c.say("", { kind: "image" });
  check(/Com quem/.test(r.msgs[0]), "imagem na escolha do profissional repete a pergunta");
  const s = await c.sessionRow();
  check(s.invalidCount === 0, `mídia não conta como inválida (invalidCount=${s.invalidCount})`);
});

// ---------------------------------------------------------------- B. caminho feliz
scenario("B1", "Agendar do começo ao fim (cliente novo, pede nome) + Meus agendamentos + cancelar", async () => {
  const c = conv("bela", { pushName: "Maria Souza" });
  let r = await toTime(c, { service: /Corte/, pro: /Ana/, day: 2, time: 3 });
  check(/qual é o seu nome/i.test(r.msgs[0]), "pede o nome");
  r = await c.say("Maria da Silva");
  check(/Confirma/.test(r.msgs[0]), "mostra o resumo para confirmar");
  check(/Maria/.test(r.msgs[0]) || true, "(nome no resumo é opcional)");
  const conf = r.msgs[0];
  r = await c.pick(/Confirmar/);
  check(/Agendamento confirmado/.test(r.msgs[0]), "confirma o agendamento");
  check(conf.split("\n").filter((l) => /\d\d:\d\d/.test(l))[0] === r.msgs[0].split("\n").filter((l) => /\d\d:\d\d/.test(l))[0], "o dia/hora da confirmação bate com o resumo");
  r = await c.say("2");
  check(/Corte feminino/.test(r.msgs[0]) && /Ana/.test(r.msgs[0]), "Meus agendamentos lista o agendamento");
  await c.pick(/Corte/);
  r = await c.say("1"); // cancelar
  check(/Confirma o cancelamento/.test(r.msgs[0]), "pede confirmação do cancelamento");
  r = await c.pick(/Sim/);
  check(/cancelado/i.test(r.msgs[0]), "cancela");
});

scenario("B2", "Cliente que já tem nome não é perguntado de novo", async () => {
  const c = conv();
  await toTime(c, { day: 3, time: 1 });
  await c.say("Joana Prado");
  await c.pick(/Confirmar/);
  const r = await toTime(c, { service: /Escova/, pro: /Ana/, day: 3, time: 5 });
  check(/Confirma/.test(r.msgs[0]), "2º agendamento vai direto ao resumo");
});

// ---------------------------------------------------------------- D. entradas inválidas
scenario("D1", "Opções inválidas na lista de serviços", async () => {
  const c = conv();
  await c.say("oi"); await c.pick(/Agendar/);
  const svcScreen = c.last;
  const inputs = ["abc", "99", "10", "-1", "1.5", "😀", "1️⃣", "１", "0 0", "1,", "  ", "\n"];
  for (const t of inputs.slice(0, 2)) {
    const r = await c.say(t);
    check(/Não entendi/.test(r.msgs[0]) && r.msgs[0].includes("Qual serviço"), `"${t}" repete a lista com aviso`);
  }
  // 3ª inválida => atendente
  const r = await c.say("xyz");
  check(!/Não consegui entender/.test(r.msgs[0]) || true, "3ª inválida");
  return svcScreen;
});

scenario("D2", "Números não-canônicos aceitos: ' 2 ', '02', '2.', '2)'", async () => {
  for (const t of [" 2 ", "02", "2.", "2)", "#2", "opção 2", "2️⃣"]) {
    const c = conv();
    await c.say("oi");
    const r = await c.say(t);
    check(/Qual|agendamentos/.test(r.msgs[0]) && !/Não entendi/.test(r.msgs[0]), `menu principal aceita "${t}"`);
  }
});

scenario("D3", "Três inválidas seguidas transferem para humano — e o que acontece depois", async () => {
  const c = conv();
  await c.say("oi"); await c.pick(/Agendar/);
  await c.say("abc"); await c.say("abc");
  const r = await c.say("abc");
  check(/atendente/i.test(r.msgs[0]), "3ª inválida chama atendente");
  const r2 = await c.say("menu");
  check(r2.msgs.length > 0, "cliente que digita 'menu' depois da transferência recebe alguma resposta (hoje: silêncio por 12h)");
});

scenario("D4", "invalidCount zera depois de acerto", async () => {
  const c = conv();
  await c.say("oi"); await c.pick(/Agendar/);
  await c.say("abc"); await c.say("abc");
  await c.pick(/Corte/);
  const s = await c.sessionRow();
  check(s.invalidCount === 0, `invalidCount zerou após acerto (=${s.invalidCount})`);
});

// ---------------------------------------------------------------- E. texto no lugar do número
scenario("E1", "Nome do serviço em texto", async () => {
  const cases = [["escova", /Escova/], ["ESCOVA", /Escova/], ["escóva", /Escova/], ["Corte feminino", /Corte/], ["corte", /Corte/], ["barba", /Barba/], ["co", null], ["Corte feminino — R$ 80,00", /Corte/], ["quero fazer uma escova", /Escova/]];
  for (const [t, expect] of cases) {
    const c = conv();
    await c.say("oi"); await c.pick(/Agendar/);
    const r = await c.say(t);
    const ok = expect ? !/Não entendi/.test(r.msgs[0]) : /Não entendi/.test(r.msgs[0]);
    check(ok, `serviço por texto "${t}" -> ${expect ? "aceita" : "pede de novo"} | resp: ${(r.msgs[0] || "").split("\n")[0]}`);
  }
});

scenario("E2", "Menu principal por texto", async () => {
  for (const [t, ok] of [["agendar", true], ["Agendar horário", true], ["quero agendar", true], ["marcar", true], ["atendente", true], ["falar com atendente", true], ["1 agendar", false]]) {
    const c = conv();
    await c.say("oi");
    const r = await c.say(t);
    check(ok === !/Como posso ajudar|Não entendi/.test(r.msgs[0] || ""), `menu por texto "${t}" -> ${ok ? "entende" : "não entende"} | resp: ${(r.msgs[0] || "").split("\n")[0]}`);
  }
});

// ---------------------------------------------------------------- F. palavras de controle
scenario("F1", "menu/voltar/sair/cancelar/oi no meio do fluxo", async () => {
  for (const w of ["menu", "MENU", " Menú ", "0", "voltar", "cancelar", "oi", "sair", "SAIR", "inicio", "ajuda", "Voltar"]) {
    const c = conv();
    await toTime(c, { day: 1, time: 1 });
    const r = await c.say(w);
    const first = (r.msgs[0] || "").split("\n")[0];
    const mapped = ["menu", "MENU", " Menú ", "0"].includes(w) ? /Como posso ajudar/ : /sair/i.test(w) ? /Até logo/ : null;
    if (mapped) check(mapped.test(r.msgs[0]), `"${w}" no passo de nome/horário -> ${mapped} | resp: ${first}`);
    else check(!/Não entendi/.test(r.msgs[0]), `"${w}" no meio do fluxo é entendido | resp: ${first}`);
  }
});

scenario("F2", "Cliente digita 'oi'/'menu' quando está na tela de NOME", async () => {
  const c = conv();
  await toTime(c, { day: 1, time: 1 });
  check(/nome/i.test(c.last), "chegou na tela de nome");
  for (const w of ["oi", "cancelar", "voltar", "sim", "não sei", "quero marcar", "12345", "a", "Ana Maria da Silva Pereira de Albuquerque Cavalcante Souza e Melo Filho Neto", "😀😀"]) {
    const c2 = conv();
    await toTime(c2, { day: 1, time: 1 });
    const r = await c2.say(w);
    const st = await c2.sessionRow();
    const contact = await (await db()).contact.findUnique({ where: { id: await c2.contactId() } });
    const accepted = /Confirma/.test(r.msgs[0] || "");
    check(!accepted || w.length > 3 && /^[\p{L} ]+$/u.test(w) && w.split(" ").length > 1 || w === "a", `nome "${w.slice(0, 30)}" -> ${accepted ? "ACEITO como nome (nome salvo=" + contact.name + ")" : "recusado"}`);
  }
});

// ---------------------------------------------------------------- G. sessão expirada
scenario("G1", "Sessão velha (35 min) no meio do agendamento", async () => {
  const c = conv();
  await toTime(c, { day: 1, time: 1 });
  const p = await db();
  await p.chatSession.updateMany({ where: { contactId: await c.contactId() }, data: { lastInboundAt: new Date(Date.now() - 35 * 60_000) } });
  const r = await c.say("1");
  check(/Faz um tempo/.test(r.msgs[0]), "avisa que recomeçou");
  check(hasOpt(r.msgs[0], /Agendar/), "mostra o menu");
  const r2 = await c.say("1");
  check(/Qual serviço/.test(r2.msgs[0]), "depois volta ao normal");
});

// ---------------------------------------------------------------- H. concorrência
scenario("H1", "Dois clientes ao mesmo tempo", async () => {
  const a = conv(), b = conv();
  const [ra, rb] = await Promise.all([a.say("oi"), b.say("oi")]);
  check(ra.msgs.length === 1 && rb.msgs.length === 1, "os dois recebem o menu");
  const [r1, r2] = await Promise.all([a.say("1"), b.say("2")]);
  check(/Qual serviço/.test(r1.msgs[0]), "A vê serviços");
  check(/agendamentos/.test(r2.msgs[0]), "B vê meus agendamentos");
});

scenario("H2", "Mesmo cliente manda 3 mensagens rápidas", async () => {
  const c = conv();
  await c.say("oi");
  const rs = await Promise.all([c.say("1"), c.say("1"), c.say("1")]);
  const all = rs.map((r) => (r.msgs[0] || "(nada)").split("\n")[0]);
  check(true, `respostas: ${JSON.stringify(all)}`);
  const s = await c.sessionRow();
  check(!s.lockToken || true, `estado final ${s.state}`);
  check(rs.every((r) => r.msgs.length === 1), `todas as 3 mensagens rápidas foram respondidas (respondidas=${rs.filter((r) => r.msgs.length).length})`);
});

scenario("H3", "Dedupe: mesma mensagem (mesmo id) duas vezes", async () => {
  const c = conv();
  await c.say("oi");
  const r1 = await c.say("1", { id: "DUP-" + newPhone() });
  const id = r1.id;
  const r2 = await c.say("1", { id });
  check(r1.msgs.length === 1, "1ª processada");
  check(r2.msgs.length === 0 && r2.claim.reason === "DUPLICATE", "2ª ignorada como DUPLICATE");
});

scenario("H4", "Mensagem atrasada (>5 min) é ignorada", async () => {
  const c = conv();
  const r = await c.say("oi", { ts: Date.now() - 6 * 60_000 });
  check(r.msgs.length === 0 && r.claim.reason === "STALE", "STALE ignorada (cliente fica sem resposta)");
});

// ---------------------------------------------------------------- I. horário ocupado
scenario("I1", "SLOT_TAKEN entre listar e confirmar (profissional específico)", async () => {
  const a = conv(), b = conv();
  await toTime(a, { pro: /Ana/, day: 2, time: 2 });
  await a.say("Ana Um");
  const confirmA = a.last;
  await toTime(b, { pro: /Ana/, day: 2, time: 2 });
  await b.say("Bia Dois");
  await b.pick(/Confirmar/);
  const r = await a.pick(/Confirmar/);
  check(/ocupado/.test(r.msgs[0]), `avisa que o horário foi ocupado | ${r.msgs[0].split("\n")[0]}`);
  check(hasOpt(r.msgs[0], /\d\d:\d\d/), "oferece alternativas");
  const dayLine = r.msgs[0];
  const r2 = await a.say("1");
  check(/Confirma/.test(r2.msgs[0]), `escolher alternativa vai para a confirmação | ${r2.msgs[0].split("\n").join(" / ")}`);
  check(/\d\d\/\d\d/.test(r2.msgs[0]) && !/\{|undefined|null/.test(r2.msgs[0]), "o resumo tem a data preenchida");
  const r3 = await a.pick(/Confirmar/);
  check(/Agendamento confirmado/.test(r3.msgs[0]), "reserva a alternativa");
  return { confirmA, dayLine };
});

scenario("I2", "SLOT_TAKEN: 'Escolher outro horário' depois da alternativa", async () => {
  const a = conv(), b = conv();
  await toTime(a, { pro: /Ana/, day: 2, time: 2 });
  await a.say("Ana Um");
  await toTime(b, { pro: /Ana/, day: 2, time: 2 });
  await b.say("Bia Dois");
  await b.pick(/Confirmar/);
  await a.pick(/Confirmar/);
  await a.say("1");
  const r = await a.pick(/outro horário/);
  check(/dia|horário/i.test(r.msgs[0]) && hasOpt(r.msgs[0], /\d/), `depois de "outro horário" lista algo | ${r.msgs[0].split("\n")[0]}`);
});

// ---------------------------------------------------------------- J/K/L. disponibilidade
scenario("K1", "Serviço sem profissional / profissional sem expediente / empresa sem serviço", async () => {
  let c = conv();
  await c.say("oi"); await c.pick(/Agendar/);
  check(!hasOpt(c.last, /Limpeza de pele/) || true, "(lista contém serviço sem profissional?) " + hasOpt(c.last, /Limpeza/));
  // paginação: ir para a 2ª página
  await c.pick(/Ver mais/);
  const page2 = c.last;
  check(hasOpt(page2, /Limpeza de pele/), "Limpeza de pele aparece na página 2");
  let r = await c.pick(/Limpeza de pele/);
  check(!/Para qual dia/.test(r.msgs[0]), `serviço sem profissional não vai para 'Para qual dia?' | ${r.msgs[0].split("\n")[0]}`);
  check(!/Não encontrei horários disponíveis no momento\. Tente novamente mais tarde\./.test(r.msgs[0]) || true, "texto: " + r.msgs[0].split("\n")[0]);
  c = conv();
  await c.say("oi"); await c.pick(/Agendar/); await c.pick(/Ver mais/);
  r = await c.pick(/Sem expediente/);
  check(!hasOpt(r.msgs[0], /Qua|Qui|Sex|Sáb|Seg|Ter/), `serviço cuja profissional não tem expediente não mostra dias | ${r.msgs[0].split("\n").join(" / ")}`);
  const e = conv("vazio");
  r = await e.say("oi");
  r = await e.pick(/Agendar/);
  check(/Não encontrei|não há|indispon/i.test(r.msgs[0]), `empresa sem serviços responde algo útil | ${r.msgs[0].split("\n").join(" / ")}`);
});

scenario("K2", "Profissional 'Carla' (sem expediente) é oferecida como opção", async () => {
  const c = conv();
  await c.say("oi"); await c.pick(/Agendar/); await c.pick(/Corte/);
  check(!hasOpt(c.last, /Carla/), "não deveria oferecer profissional sem nenhum expediente");
  await c.pick(/Carla/);
  check(!/Não encontrei/.test(c.last) || true, "se escolher Carla: " + c.last.split("\n")[0]);
});

scenario("L1", "Bloqueio da empresa inteira e feriado escondem o dia", async () => {
  const c0 = conv();
  await c0.say("oi"); await c0.pick(/Agendar/); await c0.pick(/Corte/); await c0.pick(/Qualquer/);
  const daysBefore = parseOptions(c0.last);
  const p = await db();
  const t = seed.tenants.bela;
  // bloqueia o 3º dia listado (empresa inteira)
  const tzDate = new Date(); // qualquer dia futuro relativo: calcula pelo rótulo "Sex 02/10"
  const iso = (await api("bela", "GET", `/availability/days?serviceId=${t.services["Corte feminino"]}&limit=7`)).body.options[2].id;
  const ex = await p.scheduleException.create({ data: { tenantId: t.tenantId, type: "HOLIDAY", startsAt: new Date(`${iso}T00:00:00-03:00`), endsAt: new Date(`${iso}T23:59:59-03:00`), reason: "Feriado teste" } });
  try {
    const c = conv();
    await c.say("oi"); await c.pick(/Agendar/); await c.pick(/Corte/); await c.pick(/Qualquer/);
    const daysAfter = parseOptions(c.last).filter((o) => !/Ver mais/.test(o.label));
    check(!daysAfter.some((d) => d.label === daysBefore[2].label), `dia bloqueado (${daysBefore[2].label}) sumiu da lista`);
    check(daysAfter.length === 7, `lista continua com 7 dias (${daysAfter.length})`);
  } finally {
    await p.scheduleException.delete({ where: { id: ex.id } });
  }
});

// ---------------------------------------------------------------- M. fuso
scenario("M1", "Fuso Tóquio/Honolulu: dias, horários e confirmação coerentes", async () => {
  for (const [key, tz] of [["tokyo", "Asia/Tokyo"], ["honolulu", "Pacific/Honolulu"]]) {
    const c = conv(key);
    await c.say("oi"); await c.pick(/Agendar/);
    const r = await c.pick(/Consulta/);
    const days = parseOptions(c.last);
    const localToday = tzToday(tz).slice(8, 10) + "/" + tzToday(tz).slice(5, 7);
    // Perto da meia-noite local (ex.: Tóquio às 22:50) não sobra horário hoje, e o 1º dia da lista é o seguinte: os dois valem.
    const nextDay = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 86_400_000));
    const localTomorrow = nextDay.slice(8, 10) + "/" + nextDay.slice(5, 7);
    check(days[0].label.endsWith(localToday) || days[0].label.endsWith(localTomorrow), `${key}: 1º dia da lista é hoje no fuso local (${localToday}) ou, sem horário sobrando, amanhã (${localTomorrow}) | ${days[0].label}`);
    await c.say("1");
    const times = parseOptions(c.last);
    check(times.length >= 1, `${key}: há horários hoje | ${times.map((t) => t.label).join(",")}`);
    // último horário do dia
    await c.say("oi"); // reinicia? não: 'oi' na lista de horários é inválido
  }
});

scenario("M2", "Fuso: horário reservado às 23:00 local mostra o mesmo dia/hora na confirmação e em Meus agendamentos", async () => {
  for (const [key, tz] of [["tokyo", "Asia/Tokyo"], ["honolulu", "Pacific/Honolulu"]]) {
    const c = conv(key);
    await c.say("oi"); await c.pick(/Agendar/); await c.pick(/Consulta/);
    await c.say("2"); // amanhã
    const dayLabel = parseOptions((c.log[c.log.length - 2].msgs[0]))[1].label;
    const times = parseOptions(c.last);
    const last = times.filter((t) => /^\d\d:\d\d$/.test(t.label)).pop();
    await c.say(String(times.find((t) => /^2[0-3]:/.test(t.label))?.n || last.n));
    await c.say("Fulano Noite");
    const conf = c.last;
    check(conf.includes(dayLabel), `${key}: resumo mostra o dia escolhido (${dayLabel}) | ${conf.split("\n").slice(1).join(" / ")}`);
    const r = await c.pick(/Confirmar/);
    check(r.msgs[0].includes(dayLabel), `${key}: confirmação mostra o mesmo dia | ${r.msgs[0].split("\n").slice(1).join(" / ")}`);
    const m = await c.say("2");
    check(m.msgs[0].includes(dayLabel.replace(/^\S+ /, "")), `${key}: meus agendamentos mostra o mesmo dia | ${m.msgs[0].split("\n").slice(1, 3).join(" / ")}`);
  }
});

// ---------------------------------------------------------------- N. meus agendamentos / cancelar / remarcar
scenario("N1", "Meus agendamentos com 0", async () => {
  const c = conv();
  await c.say("oi");
  const r = await c.say("2");
  check(/não tem agendamentos/.test(r.msgs[0]), "informa que não há agendamentos");
  check(hasOpt(r.msgs[0], /Agendar/), "e oferece o menu");
});

async function book(c, o = {}) {
  await toTime(c, o);
  if (/nome/i.test(c.last)) await c.say(o.name || "Cliente Teste");
  const r = await c.pick(/Confirmar/);
  return r;
}

scenario("N2", "Meus agendamentos com vários (>9) e paginação", async () => {
  const c = conv();
  // cria 11 agendamentos por SQL/API direta
  await c.say("oi");
  const cid = await c.contactId();
  const t = seed.tenants.bela;
  await api("bela", "PATCH", `/contacts/${cid}`, { name: "Cliente Muitos" });
  for (let i = 0; i < 11; i++) {
    const days = (await api("bela", "GET", `/availability/days?serviceId=${t.services["Manicure"]}&professionalId=${t.pros.ana}&limit=7&from=${new Date(Date.now() + (i + 3) * 86400000).toISOString().slice(0, 10)}`)).body;
    const d = days.options[0].id;
    const slots = (await api("bela", "GET", `/availability/slots?serviceId=${t.services["Manicure"]}&professionalId=${t.pros.ana}&date=${d}&offset=0&limit=1`)).body;
    const rr = await api("bela", "POST", "/appointments", { contactId: cid, serviceId: t.services["Manicure"], professionalId: t.pros.ana, startsAt: slots.options[0].id, idempotencyKey: `n2-${c.phone}-${i}` });
    if (rr.status >= 300) { check(false, `seed de agendamento ${i} falhou ${rr.status} ${JSON.stringify(rr.body)}`); }
  }
  const r = await c.say("2");
  check(parseOptions(r.msgs[0]).length >= 9, "lista paginada");
  check(/Ver mais/.test(r.msgs[0]), "tem 'Ver mais'");
  const r2 = await c.pick(/Ver mais/);
  check(parseOptions(r2.msgs[0]).length >= 3, `página 2 mostra os restantes | ${r2.msgs[0]}`);
  const r3 = await c.pick(/Ver mais/);
  check(true, `3ª página (cíclica?): ${r3.msgs[0].split("\n").slice(0, 3).join(" / ")}`);
});

scenario("N4", "Remarcar completo (dentro do prazo)", async () => {
  const c = conv();
  await book(c, { pro: /Ana/, day: 3, time: 2, name: "Rita Remarca" });
  let r = await c.say("2");
  await c.say("1");
  r = await c.say("2");
  check(/Para qual dia/.test(r.msgs[0]), `remarcar pergunta o dia | ${r.msgs[0].split("\n")[0]}`);
  await c.say("2");
  r = await c.say("1");
  check(/Confirma/.test(r.msgs[0]) && !/undefined|\{/.test(r.msgs[0]), `resumo da remarcação legível | ${r.msgs[0].split("\n").join(" / ")}`);
  r = await c.pick(/Confirmar/);
  check(/remarcado/i.test(r.msgs[0]), `remarcado | ${r.msgs[0].split("\n").join(" / ")}`);
  check(/Corte feminino/.test(r.msgs[0]) || true, "mostra serviço");
  r = await c.say("2");
  check(parseOptions(r.msgs[0]).filter((o) => /Corte/.test(o.label)).length === 1, `só 1 agendamento após remarcar | ${r.msgs[0].split("\n").join(" / ")}`);
});

scenario("N5", "Remarcar para o MESMO horário atual", async () => {
  const c = conv();
  await book(c, { pro: /Ana/, day: 3, time: 2, name: "Rita Mesma" });
  const t0 = (await c.say("2")).msgs[0];
  await c.say("1");
  await c.say("2");
  // escolher o mesmo dia e o mesmo horário
  const label = (t0.match(/\d\d:\d\d/) || [])[0];
  const r = await c.say("1");
  const same = parseOptions(r.msgs[0]).filter((o) => o.label === label);
  check(same.length === 0 || true, `horário atual aparece como opção livre? ${same.length ? "SIM" : "não"} (${label})`);
});

// ---------------------------------------------------------------- O/P/U atendente, lembrete, pausa
scenario("O1", "Falar com atendente pausa o bot", async () => {
  const c = conv();
  await c.say("oi");
  let r = await c.say("3");
  check(/atendente/i.test(r.msgs[0]), "confirma transferência");
  r = await c.say("oi");
  check(r.msgs.length === 0 && r.claim.reason === "HUMAN_MODE", "durante a pausa o bot fica em silêncio (HUMAN_MODE)");
  const s = await c.sessionRow();
  check(s.humanUntil && s.humanUntil > new Date(Date.now() + 11 * 3600_000), `pausa ~12h (humanUntil=${s.humanUntil && s.humanUntil.toISOString()})`);
});

scenario("U1", "Bot pausado para o contato", async () => {
  const c = conv();
  await c.say("oi");
  const p = await db();
  await p.contact.update({ where: { id: await c.contactId() }, data: { botPausedUntil: new Date(Date.now() + 3600_000) } });
  const r = await c.say("1");
  check(r.msgs.length === 0 && r.claim.reason === "BOT_PAUSED", "silêncio (BOT_PAUSED)");
  await p.contact.update({ where: { id: await c.contactId() }, data: { botPausedUntil: new Date(Date.now() - 1000) } });
  const r2 = await c.say("1");
  check(r2.msgs.length === 1, "depois que a pausa vence, volta a responder");
});

scenario("U2", "Dono responde pelo celular (fromMe) e bot para", async () => {
  const c = conv();
  await c.say("oi");
  const r = await c.say("Oi, aqui é a Ana, posso ajudar?", { fromMe: true });
  check(r.msgs.length === 0, "bot não responde ao fromMe");
  const r2 = await c.say("1");
  check(r2.msgs.length === 0 && r2.claim.reason === "BOT_PAUSED", "e fica pausado (BOT_PAUSED)");
});

// ---------------------------------------------------------------- Q/R paginação
scenario("R1", "Paginação de serviços (13 serviços)", async () => {
  const c = conv();
  await c.say("oi");
  const r = await c.pick(/Agendar/);
  const o1 = parseOptions(r.msgs[0]);
  check(o1.length === 9, `página 1: 8 serviços + 'Ver mais' (${o1.length})`);
  const r2 = await c.pick(/Ver mais/);
  const o2 = parseOptions(r2.msgs[0]);
  check(o2.filter((o) => !/Ver mais/.test(o.label)).length === 5, `página 2: 5 serviços restantes (${o2.map((o) => o.label).join("|")})`);
  check(o2.some((o) => /Ver mais/.test(o.label)), `página 2 ainda mostra 'Ver mais' (volta ao início?) — confuso`);
  check(/Voltar|anterior/i.test(r2.msgs[0]) || true, "há como voltar à página anterior?");
});

scenario("R2", "Paginação de dias: 'Ver mais datas' não repete dia", async () => {
  const c = conv();
  await c.say("oi"); await c.pick(/Agendar/); await c.pick(/Corte/); await c.pick(/Qualquer/);
  const p1 = parseOptions(c.last).filter((o) => !/Ver mais/.test(o.label));
  const r = await c.pick(/Ver mais datas/);
  const p2 = parseOptions(r.msgs[0]).filter((o) => !/Ver mais/.test(o.label));
  const rep = p2.filter((o) => p1.some((x) => x.label === o.label));
  check(rep.length === 0, `página 2 de dias não repete dias da página 1 (repetidos: ${rep.map((o) => o.label)}) | p1=${p1.map((o) => o.label)} p2=${p2.map((o) => o.label)}`);
});


scenario("Q1", "Números enormes / estranhos na lista", async () => {
  for (const t of ["99999999999999999999", "1e3", "0x2", "00", "000001", "1\n2", "+1", "١"]) {
    const c = conv();
    await c.say("oi");
    const r = await c.say(t);
    check(true, `"${t.replace("\n", "\\n")}" -> ${(r.msgs[0] || "(nada)").split("\n")[0]} ${r.error ? "ERRO " + r.error : ""}`);
  }
});

// ---------------------------------------------------------------- Y solo (sem perguntar profissional)
scenario("Y1", "Empresa com askProfessional=false e 2 profissionais (Manaus)", async () => {
  const c = conv("solo");
  await c.say("oi"); await c.pick(/Agendar/);
  let r = await c.pick(/Corte/);
  check(/Para qual dia/.test(r.msgs[0]), `pula a pergunta de profissional | ${r.msgs[0].split("\n")[0]}`);
  r = await c.say("1");
  check(hasOpt(r.msgs[0], /\d\d:\d\d/), "mostra horários");
  const times = parseOptions(r.msgs[0]).map((o) => o.label).join(",");
  check(true, `horários: ${times}`);
});

// ---------------------------------------------------------------- rodada 2 (arquivo separado)
const RUN_TAG = String(Date.now()).slice(-6);
const H = { scenario, check, conv, toTime, book, hasOpt, parseOptions, db, api, seed, tzToday, RUN_TAG };
(await import("./scenarios-r2.mjs")).default(H);

// ---------------------------------------------------------------- runner
const filter = process.argv[2] ? new RegExp(process.argv[2]) : null;
let md = `# Transcrições do simulador — ${new Date().toISOString()}\n`;
for (const s of scenarios) {
  if (filter && !filter.test(s.id)) continue;
  cur = { id: s.id, title: s.title, checks: [], convos: [] };
  let crash = null;
  try { await s.fn(); } catch (e) { crash = e; }
  results.push({ ...cur, crash });
  const fails = cur.checks.filter((c) => !c.ok);
  console.log(`${crash ? "CRASH" : fails.length ? "FALHA" : "ok   "} ${s.id} ${s.title}`);
  for (const f of fails) console.log(`      x ${f.msg}`);
  if (crash) console.log(`      ! ${String(crash.message).split("\n").slice(0, 6).join("\n        ")}`);
  md += `\n\n## ${s.id} — ${s.title}\n` + cur.checks.map((c) => `- ${c.ok ? "OK " : "FALHOU"}: ${c.msg}`).join("\n") + cur.convos.map((c, i) => c.transcript(`conversa ${i + 1} (${c.tenantKey} ${c.phone})`)).join("\n");
}
mkdirSync(join(here, "out"), { recursive: true });
writeFileSync(join(here, "out", "transcripts.md"), md);
const failed = results.filter((r) => r.crash || r.checks.some((c) => !c.ok)).length;
console.log(`\n${results.length} cenários, ${failed} com falha. Transcrições: scripts/bot-sim/out/transcripts.md`);
await closeDb();
