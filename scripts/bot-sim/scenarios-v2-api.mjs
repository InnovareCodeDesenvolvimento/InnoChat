// Cenários API-01..API-13: contratos da API interna do bot v2 (plano §3.4), testados direto na API (sem o workflow).
// Nascem vermelhos: cada verificação aponta a tarefa que a deixa verde (B-1 agenda/catálogo, B-2 conversa, B-3 textos, C-1 dados).
import {
  scenario, check, sub, conv, T, say, brief, firstLine, norm, start, S, handoffs, freeSlot, allSlots, createAppt, db, sql, setTenant, getTenant, api, api2, world, TZ, localISO, localHM,
  addDaysISO, weekdayOfISO, ddmm, newPhone, ageSession, setTeamHours, whenLabelsAround, runPortMigration, ensureFake, fakeSent, clearFakeSent,
  J, trySetTenant,
} from "./v2-kit.mjs";
import { Chat } from "./chat.mjs";

const WD = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const WD_LONG = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const todayOf = (k) => localISO(new Date(), TZ[k]);
const dayLabel = (iso) => `${WD[weekdayOfISO(iso)]} ${ddmm(iso)}`;
const body = (r) => r.body || {};
let seq = 0;

/** POST /messages/claim cru. Devolve o corpo (com session.lockToken). flow: 2 (header) ou undefined (v1). */
async function claim(tenantKey, chat, text, { flow = 2, fromMe = false } = {}) {
  const res = await api(tenantKey, "POST", "/messages/claim", { payload: chat.payload("text", text, `API${Date.now().toString(36)}${++seq}`, Date.now(), fromMe) }, flow ? { "x-innochat-flow": String(flow) } : {});
  return { status: res.status, ...(res.body || {}) };
}
const release = (tenantKey, sess, extra = {}) => api(tenantKey, "POST", `/sessions/${encodeURIComponent(sess.id)}/release`, { lockToken: sess.lockToken, ...extra });
const putSession = (tenantKey, sess, extra = {}) => api(tenantKey, "PUT", `/sessions/${encodeURIComponent(sess.id)}`, { lockToken: sess.lockToken, version: sess.version, state: "MAIN_MENU", context: {}, invalidCount: 0, outbound: [], handoff: false, ...extra });
const newChat = (tenantKey, pushName = "Maria Souza") => new Chat(world, S(tenantKey).token, newPhone(), { pushName });
async function contactOf(tenantKey, chat) {
  const p = await db();
  return p.contact.findFirst({ where: { tenantId: S(tenantKey).tenantId, waJid: chat.jid } });
}

scenario("API-01", "GET /availability/days: relativeLabel, nextFrom = dia seguinte ao último, lastBookableDate, rótulo por meio-dia local", "B-1", async () => {
  const t = S("bela");
  const today = todayOf("bela");
  const r = await api2("bela", "GET", `/availability/days?serviceId=${t.services["Corte feminino"]}&professionalId=${t.pros.ana}&from=${today}&limit=7`);
  const o = body(r).options || [];
  check(r.status === 200 && o.length === 7, `7 dias (status ${r.status}, ${o.length})`);
  check(o.every((d, i) => /^\d{4}-\d\d-\d\d$/.test(d.id) && (i === 0 || d.id > o[i - 1].id)), "ids YYYY-MM-DD crescentes");
  check(o.every((d) => d.label === dayLabel(d.id)), `label = "Dia dd/mm" do próprio dia (${o.map((d) => d.label).join(", ")})`);
  check(o.length && o.every((d) => typeof d.relativeLabel === "string"), "todo dia tem relativeLabel");
  const first = o[0];
  if (first) {
    const exp = first.id === today ? `Hoje · ${first.label}` : first.id === addDaysISO(today, 1) ? `Amanhã · ${first.label}` : first.label;
    check(first.relativeLabel === exp, `relativeLabel do 1º = "${exp}" (=${first.relativeLabel})`);
  }
  check(!o.some((d) => weekdayOfISO(d.id) === 0), "domingo (fechado) não aparece");
  check(body(r).hasMore === true, "hasMore = true (horizonte de 30 dias)");
  check(o.length && body(r).nextFrom === addDaysISO(o[o.length - 1].id, 1), `nextFrom = dia SEGUINTE ao último (BUG-05): ${body(r).nextFrom} vs ${o.length && addDaysISO(o[o.length - 1].id, 1)}`);
  const lb = body(r).lastBookableDate;
  check(lb && lb.id >= addDaysISO(today, 29) && lb.id <= addDaysISO(today, 30) && lb.label === dayLabel(lb.id), `lastBookableDate ≈ hoje+30 com label (${J(lb)})`);
  if (body(r).nextFrom) {
    const r2 = await api2("bela", "GET", `/availability/days?serviceId=${t.services["Corte feminino"]}&professionalId=${t.pros.ana}&from=${body(r).nextFrom}&limit=7`);
    const o2 = body(r2).options || [];
    check(o2.length && !o2.some((d) => o.some((x) => x.id === d.id)), `a página seguinte não repete dias (${o2.map((d) => d.id).join(",")})`);
  }
  // BUG-15: fuso +14 — o rótulo é o dia LOCAL (meio-dia local), não o dia UTC
  const k = S("kiribati");
  const rk = await api2("kiribati", "GET", `/availability/days?serviceId=${k.services.Consulta}&professionalId=${k.pros.p}&limit=3`);
  const ok = body(rk).options || [];
  check(ok.length === 3 && ok.every((d) => d.label === dayLabel(d.id)), `UTC+14: o rótulo bate com o id local (${ok.map((d) => `${d.id}=${d.label}`).join(", ")})`);
});

scenario("API-02", "GET /availability/slots: rótulos do dia, period, near/exact, reason e nextDay", "B-1", async () => {
  const t = S("bela");
  const tz = TZ.bela;
  const date = addDaysISO(todayOf("bela"), 3);
  let wd = weekdayOfISO(date);
  const day = wd === 0 ? addDaysISO(date, 1) : date;
  const q = (extra) => `/availability/slots?serviceId=${t.services["Corte feminino"]}&professionalId=${t.pros.ana}&date=${day}${extra}`;
  const r = await api2("bela", "GET", q("&offset=0&limit=8"));
  const o = body(r).options || [];
  check(r.status === 200 && o.length === 8 && body(r).hasMore === true, `8 horários + hasMore (status ${r.status}, ${o.length})`);
  check(o.every((s) => /^\d\d:\d\d$/.test(s.label) && localHM(new Date(s.id), tz) === s.label), `id ISO UTC e label = hora local (${o.slice(0, 3).map((s) => `${s.id}=${s.label}`).join(", ")})`);
  check(body(r).dateLabel === dayLabel(day), `dateLabel = "${dayLabel(day)}" (=${body(r).dateLabel})`);
  check(typeof body(r).dateRelativeLabel === "string" && body(r).dateRelativeLabel.includes(dayLabel(day)), `dateRelativeLabel contém o rótulo (=${body(r).dateRelativeLabel})`);
  check(body(r).dateLongLabel === `${WD_LONG[weekdayOfISO(day)]}, ${ddmm(day)}`, `dateLongLabel = "${WD_LONG[weekdayOfISO(day)]}, ${ddmm(day)}" (=${body(r).dateLongLabel})`);
  check(body(r).reason === null, `reason null quando há horários (=${body(r).reason})`);
  const r2 = await api2("bela", "GET", q("&offset=8&limit=8"));
  const o2 = body(r2).options || [];
  check(o2.length > 0 && !o2.some((s) => o.some((x) => x.id === s.id)), "offset=8 traz a página seguinte sem repetir");
  for (const [period, lo, hi] of [["morning", "00:00", "11:59"], ["afternoon", "12:00", "17:59"], ["evening", "18:00", "23:59"]]) {
    const rp = await api2("bela", "GET", q(`&offset=0&limit=8&period=${period}`));
    const po = body(rp).options || [];
    check(rp.status === 200 && po.every((s) => s.label >= lo && s.label <= hi) && (period !== "afternoon" || po.length > 0), `period=${period}: só horários entre ${lo} e ${hi} (${po.map((s) => s.label).join(",") || "vazio"})`);
  }
  const rn = await api2("bela", "GET", q("&near=15:00"));
  const no = body(rn).options || [];
  check(rn.status === 200 && no.length === 3 && body(rn).exact === true && no[0].label === "15:00", `near=15:00: 3 opções, exact=true, 1ª = 15:00 (${no.map((s) => s.label).join(",")}; exact=${body(rn).exact})`);
  const rn2 = await api2("bela", "GET", q("&near=15:10"));
  const no2 = (body(rn2).options || []).map((s) => s.label);
  check(no2.join(",") === "15:00,15:30,14:30" && body(rn2).exact === false, `near=15:10: mais próximos 15:00,15:30,14:30 e exact=false (${no2.join(",")}; exact=${body(rn2).exact})`);
  // reason + nextDay
  const past = await api2("bela", "GET", `/availability/slots?serviceId=${t.services["Corte feminino"]}&professionalId=${t.pros.ana}&date=${addDaysISO(todayOf("bela"), -1)}&offset=0&limit=8`);
  check(body(past).options && body(past).options.length === 0 && body(past).reason === "PAST", `dia passado: reason=PAST (${body(past).reason})`);
  const beyond = await api2("bela", "GET", `/availability/slots?serviceId=${t.services["Corte feminino"]}&professionalId=${t.pros.ana}&date=${addDaysISO(todayOf("bela"), 45)}&offset=0&limit=8`);
  check(body(beyond).options && body(beyond).options.length === 0 && body(beyond).reason === "BEYOND_HORIZON", `além do horizonte: reason=BEYOND_HORIZON (${body(beyond).reason})`);
  let sunday = addDaysISO(todayOf("bela"), 1);
  while (weekdayOfISO(sunday) !== 0) sunday = addDaysISO(sunday, 1);
  const closed = await api2("bela", "GET", `/availability/slots?serviceId=${t.services["Corte feminino"]}&professionalId=${t.pros.ana}&date=${sunday}&offset=0&limit=8`);
  const nd = body(closed).nextDay;
  check(body(closed).options && body(closed).options.length === 0 && body(closed).reason === "CLOSED", `domingo: reason=CLOSED (${body(closed).reason})`);
  check(nd && nd.id === addDaysISO(sunday, 1) && nd.label === dayLabel(addDaysISO(sunday, 1)) && typeof nd.relativeLabel === "string", `nextDay = a segunda seguinte (${J(nd)})`);
});

scenario("API-03", "GET /availability/next: próximos horários em qualquer dia, em ordem, com rótulo relativo", "B-1", async () => {
  const t = S("bela");
  const tz = TZ.bela;
  const r = await api2("bela", "GET", `/availability/next?serviceId=${t.services["Corte feminino"]}&professionalId=${t.pros.ana}&limit=6`);
  const o = body(r).options || [];
  check(r.status === 200 && o.length === 6, `6 horários (status ${r.status}, ${o.length})`);
  check(o.every((x, i) => i === 0 || Date.parse(x.id) > Date.parse(o[i - 1].id)), "ordem crescente");
  check(o.length && Date.parse(o[0].id) >= Date.now() + 60 * 60_000 - 60_000, `respeita minLeadTimeMin=60 (1º=${o[0] && o[0].id})`);
  const today = todayOf("bela");
  check(o.every((x) => x.date === localISO(new Date(x.id), tz) && x.label.endsWith(localHM(new Date(x.id), tz))), `date e label coerentes com o horário local (${o.slice(0, 2).map((x) => `${x.date} ${x.label}`).join(" | ")})`);
  check(o.every((x) => (x.date === today ? x.label.startsWith("Hoje · ") : x.date === addDaysISO(today, 1) ? x.label.startsWith("Amanhã · ") : x.label.includes(dayLabel(x.date)))), `rótulo relativo (${o.map((x) => x.label).join(" | ")})`);
  const l3 = await api2("bela", "GET", `/availability/next?serviceId=${t.services["Corte feminino"]}&professionalId=${t.pros.ana}&limit=3`);
  check((body(l3).options || []).length === 3, "limit=3 devolve 3");
});

scenario("API-04", "GET /catalog/services e /professionals: só o agendável, com rótulos, skip e limite por cliente", "B-1", async () => {
  const t = S("bela");
  const r = await api2("bela", "GET", "/catalog/services");
  const o = body(r).options || [];
  const byName = Object.fromEntries(o.map((s) => [s.name, s]));
  check(r.status === 200 && o.length === 11, `11 serviços agendáveis (${o.length}: ${o.map((s) => s.name).join(", ")})`);
  check(!byName["Limpeza de pele"] && !byName["Sem expediente"] && !byName["Legado inativo"] && byName["Barba"], "sem serviço sem profissional, sem só-Carla, sem inativo; com Barba (só o Bruno)");
  const c = byName["Corte feminino"];
  check(c && c.durationLabel === "1h" && norm(c.priceLabel) === "R$ 80,00" && c.durationMin === 60 && typeof c.label === "string", `Corte feminino: 1h / R$ 80,00 e o label v1 continua (${J(c)})`);
  check(byName["Escova"] && byName["Escova"].durationLabel === "45 min" && byName["Coloração"] && byName["Coloração"].durationLabel === "2h", "durationLabel: 45 min, 2h");
  check(byName["Sobrancelha"] && byName["Sobrancelha"].priceLabel === null, "serviço sem preço: priceLabel = null");
  check(body(r).limit === undefined, "sem contactId, não há campo limit");
  const l = S("limite");
  const rl = await api2("limite", "GET", `/catalog/services?contactId=${l.contactId}`);
  check(body(rl).limit && body(rl).limit.max === 3 && body(rl).limit.count === 3 && body(rl).limit.reached === true, `contactId do cliente com 3 futuros: limit { max:3, count:3, reached:true } (${J(body(rl).limit)})`);
  const bela = conv("bela"); // cria um contato do tenant bela
  await start(bela);
  const rx = await api2("limite", "GET", `/catalog/services?contactId=${await bela.contactId()}`);
  check(rx.status === 404, `contactId de outro tenant → 404 (status ${rx.status})`);
  const rp = await api2("bela", "GET", `/catalog/services/${t.services["Corte feminino"]}/professionals`);
  const names = (body(rp).options || []).map((p) => p.name || p.label);
  check(names.some((n) => /Ana/.test(n)) && names.some((n) => /Bruno/.test(n)) && !names.some((n) => /Carla|Dani/.test(n)) && body(rp).skip === false, `profissionais: Ana e Bruno (sem Carla/Dani); skip=false (${names.join(",")}; skip=${body(rp).skip})`);
  const rb = await api2("bela", "GET", `/catalog/services/${t.services["Barba"]}/professionals`);
  check(body(rb).skip === true && (body(rb).options || []).length === 1, `Barba: 1 profissional com expediente → skip=true (${J(body(rb)).slice(0, 160)})`);
  const s = S("solo");
  const rs = await api2("solo", "GET", `/catalog/services/${s.services.Corte}/professionals`);
  check(body(rs).skip === true, `askProfessional=false → skip=true (skip=${body(rs).skip})`);
  const p = await db();
  const inactive = await p.service.findFirst({ where: { tenantId: t.tenantId, name: "Legado inativo" } });
  const ri = await api2("bela", "GET", `/catalog/services/${inactive.id}/professionals`);
  check(ri.status === 404, `serviço inativo → 404 (status ${ri.status})`);
});

scenario("API-05", "Limite de agendamentos futuros: 422 LIMIT_REACHED só com o header do fluxo v2; 0 = sem limite; cancelado não conta", "B-1", async () => {
  const t = S("limite");
  const p = await db();
  const c = conv("limite");
  await start(c, { named: true });
  const cid = await c.contactId();
  const mk = async (offset, key, flow2) => {
    const slot = await freeSlot("limite", t.services.Corte, t.pros.ana, offset);
    return createAppt("limite", { contactId: cid, serviceId: t.services.Corte, professionalId: t.pros.ana, startsAt: slot.iso, key, flow2 });
  };
  const tag = `api05-${c.phone}`;
  try {
    for (let i = 0; i < 3; i++) check((await mk(15 + i, `${tag}-${i}`, true)).status === 201, `reserva ${i + 1} de 3 passa com o header v2`);
    const blocked = await mk(19, `${tag}-3`, true);
    const js = J(blocked.body);
    check(blocked.status === 422 && /LIMIT_REACHED/.test(js) && /"max":3/.test(js) && /"count":3/.test(js), `4ª com o header v2 → 422 LIMIT_REACHED {max:3,count:3} (status ${blocked.status}: ${js.slice(0, 180)})`);
    const noHeader = await mk(19, `${tag}-4`, false);
    check(noHeader.status === 201, `sem o header (fluxo v1) o limite NÃO vale (status ${noHeader.status})`);
    const errSet = await trySetTenant("limite", { maxFutureAppointmentsPerContact: 0 });
    check(!errSet, `a coluna Tenant.maxFutureAppointmentsPerContact existe (${errSet || "ok"})`, "C-1");
    if (!errSet) {
      const free = await mk(20, `${tag}-5`, true);
      check(free.status === 201, `maxFutureAppointmentsPerContact=0 → sem limite (status ${free.status})`);
      await trySetTenant("limite", { maxFutureAppointmentsPerContact: 3 });
    }
    // cancelado não conta
    await p.appointment.updateMany({ where: { contactId: cid, idempotencyKey: { startsWith: tag } }, data: { status: "CANCELED" } });
    const again = await mk(21, `${tag}-6`, true);
    check(again.status === 201, `agendamentos cancelados não contam (status ${again.status})`);
  } finally {
    await p.appointment.deleteMany({ where: { contactId: cid } });
    await setTenant("limite", { maxFutureAppointmentsPerContact: 3 }).catch(() => {});
  }
  // CHECK 0..20 (C-1)
  let rejected = false;
  try { await setTenant("limite", { maxFutureAppointmentsPerContact: 21 }); } catch { rejected = true; }
  await setTenant("limite", { maxFutureAppointmentsPerContact: 3 }).catch(() => {});
  check(rejected, "o banco recusa maxFutureAppointmentsPerContact = 21 (CHECK 0..20)", "C-1");
});

scenario("API-06", "GET /contacts/{id}/appointments: canChange, changeDeadlineLabel, durationLabel, priceLabel, dataLonga, relativeLabel", "B-1", async () => {
  const p = await db();
  const t = S("dupla");
  const c = conv();
  await start(c, { named: true });
  const cid = await c.contactId();
  const eva = await p.professional.create({ data: { tenantId: t.tenantId, name: `Eva API ${Date.now() % 100000}`, sortOrder: 9, workingHours: { create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "00:00", endTime: "23:59" })) } } });
  try {
    await p.professionalService.create({ data: { professionalId: eva.id, serviceId: t.services.Corte } });
    const soon = new Date(Date.now() + 90 * 60_000);
    soon.setUTCSeconds(0, 0);
    await p.appointment.create({ data: { tenantId: t.tenantId, contactId: cid, serviceId: t.services.Corte, professionalId: eva.id, startsAt: soon, endsAt: new Date(soon.getTime() + 3600_000), blockEndsAt: new Date(soon.getTime() + 3600_000), status: "SCHEDULED", source: "WHATSAPP" } });
    const slot = await freeSlot("dupla", t.services.Corte, t.pros.ana, 6);
    await createAppt("dupla", { contactId: cid, serviceId: t.services.Corte, professionalId: t.pros.ana, startsAt: slot.iso, key: `api06-${c.phone}` });
    const r = await api2("dupla", "GET", `/contacts/${cid}/appointments`);
    const o = body(r).options || [];
    check(r.status === 200 && o.length === 2, `2 agendamentos (status ${r.status}, ${o.length})`);
    const [near, far] = o;
    check(near && near.canChange === false && far && far.canChange === true, `canChange: false a 90 min (prazo 120), true a +6 dias (${o.map((x) => x.canChange).join(",")})`);
    check(o.every((x) => x.changeDeadlineLabel === "2 horas"), `changeDeadlineLabel = "2 horas" (${o.map((x) => x.changeDeadlineLabel).join(",")})`);
    check(o.every((x) => x.durationLabel === "1h" && norm(x.priceLabel) === "R$ 50,00"), `durationLabel "1h" e priceLabel "R$ 50,00" (${o.map((x) => `${x.durationLabel}/${x.priceLabel}`).join(",")})`);
    check(far && new RegExp(`^${WD_LONG[weekdayOfISO(slot.date)]}, ${ddmm(slot.date)}$`).test(far.dataLonga), `dataLonga = "${WD_LONG[weekdayOfISO(slot.date)]}, ${ddmm(slot.date)}" (=${far && far.dataLonga})`);
    check(o.every((x) => typeof x.relativeLabel === "string" && x.relativeLabel.length > 0), `relativeLabel presente (${o.map((x) => x.relativeLabel).join(" | ")})`);
    check(o.every((x) => typeof x.label === "string" && x.startsAt && x.servico && x.hora), "campos da v1 continuam (label, startsAt, servico, hora)");
  } finally {
    await p.appointment.deleteMany({ where: { contactId: cid } });
    await p.professional.delete({ where: { id: eva.id } });
  }
});

scenario("API-07", "POST /appointments com contactName: valida (422 INVALID_NAME), grava na mesma transação, e o summary traz duracao/preco/data_longa", "B-1", async () => {
  const t = S("dupla");
  const p = await db();
  const c = conv();
  await start(c);
  const cid = await c.contactId();
  const key = `api07-${c.phone}`;
  const slot = await freeSlot("dupla", t.services.Corte, t.pros.ana, 9);
  try {
    for (const bad of ["sim", "1", "voltar", "a", "x".repeat(61), "http://x.com", "maria@x.com"]) {
      const r = await createAppt("dupla", { contactId: cid, serviceId: t.services.Corte, professionalId: t.pros.ana, startsAt: slot.iso, key: `${key}-bad`, contactName: bad, flow2: true });
      check(r.status === 422 && /INVALID_NAME/.test(J(r.body)), `contactName "${bad.slice(0, 20)}" → 422 INVALID_NAME (status ${r.status}: ${J(r.body).slice(0, 100)})`);
    }
    check((await p.appointment.count({ where: { contactId: cid } })) === 0, "nome inválido não cria agendamento");
    check(!(await c.contactRow()).name, "nome inválido não é gravado");
    const r = await createAppt("dupla", { contactId: cid, serviceId: t.services.Corte, professionalId: t.pros.ana, startsAt: slot.iso, key, contactName: "Maria  Souza", flow2: true });
    check(r.status === 201, `contactName válido: 201 (status ${r.status}: ${J(r.body).slice(0, 120)})`);
    check((await c.contactRow()).name === "Maria Souza", `Contact.name gravado com espaços normalizados (=${(await c.contactRow()).name})`);
    const s = (body(r).appointment || {}).summary || {};
    check(s.duracao === "1h" && norm(s.preco) === "R$ 50,00" && new RegExp(`^${WD_LONG[weekdayOfISO(slot.date)]}, ${ddmm(slot.date)}$`).test(s.data_longa || ""), `summary com duracao "1h", preco "R$ 50,00", data_longa (${J(s)})`);
    const again = await createAppt("dupla", { contactId: cid, serviceId: t.services.Corte, professionalId: t.pros.ana, startsAt: slot.iso, key, contactName: "Maria Souza Lima", flow2: true });
    check(again.status === 200 && (await c.contactRow()).name === "Maria Souza Lima", `mesma chave (alreadyExisted): 200 e o nome também é atualizado (status ${again.status}, nome=${(await c.contactRow()).name})`);
    // profissional null: o summary traz a profissional REAL
    const slot2 = await freeSlot("dupla", t.services.Corte, t.pros.ana, 10);
    const any = await createAppt("dupla", { contactId: cid, serviceId: t.services.Corte, professionalId: null, startsAt: slot2.iso, key: `${key}-any`, flow2: true });
    check(any.status === 201 && /^(Ana|Júlia)$/.test(((body(any).appointment || {}).summary || {}).profissional || ""), `sem profissional: o summary traz a real (${J(((body(any).appointment || {}).summary || {}).profissional)})`);
    // SLOT_TAKEN traz alternativas do dia
    const other = conv();
    await start(other, { named: true });
    const clash = await createAppt("dupla", { contactId: await other.contactId(), serviceId: t.services.Corte, professionalId: t.pros.ana, startsAt: slot.iso, key: `${key}-clash`, flow2: true });
    const alt = body(clash).alternatives || (body(clash).error && body(clash).error.details && body(clash).error.details.alternatives);
    check(clash.status === 409 && alt && alt.options && alt.options.length > 0 && alt.date, `horário ocupado: 409 SLOT_TAKEN com alternatives.date e options (${clash.status}: ${J(clash.body).slice(0, 160)})`);
  } finally {
    await p.appointment.deleteMany({ where: { contactId: cid } });
  }
});

scenario("API-08", "Grade 15/30: candidatos ancorados na meia-noite local; o banco só aceita 15 ou 30", "B-1", async () => {
  const t = S("bela");
  const nextOn = (from, weekdays) => { let d = from; while (!weekdays.includes(weekdayOfISO(d))) d = addDaysISO(d, 1); return d; };
  const from = addDaysISO(todayOf("bela"), 4);
  for (const [svc, name, pro, wds] of [["Corte feminino", "60 min", t.pros.ana, [1, 2, 3, 4, 5, 6]], ["Escova", "45 min", t.pros.ana, [1, 2, 3, 4, 5, 6]], ["Barba", "30 min", t.pros.bruno, [2, 3, 4, 5]], ["Coloração", "120 min", t.pros.ana, [1, 2, 3, 4, 5, 6]]]) {
    const slots = await allSlots("bela", t.services[svc], pro, nextOn(from, wds));
    check(slots.length > 0 && slots.every((s) => /:(00|30)$/.test(s.label)), `bela (grade 30) — ${svc} (${name}): só :00/:30 (${slots.slice(0, 8).map((s) => s.label).join(",")})`);
  }
  let rejected60 = false;
  try { await setTenant("bela", { slotGranularityMin: 60 }); } catch { rejected60 = true; }
  await setTenant("bela", { slotGranularityMin: 30 }).catch(() => {});
  check(rejected60, "o banco recusa slotGranularityMin = 60 (CHECK IN (15, 30))", "C-1");
  const row = await getTenant("bela");
  check(row.slotGranularityMin === 30, `slotGranularityMin do tenant de teste = 30 (=${row.slotGranularityMin})`);
});

scenario("API-09", "POST /messages/claim com X-InnoChat-Flow: 2: flow, contact.firstName, session.previous, tenant.* e textos v2; sem o header, resposta v1", "B-2", async () => {
  const tenantKey = "dupla";
  const tz = TZ.dupla;
  const ch = newChat(tenantKey, "Maria Souza");
  const r = await claim(tenantKey, ch, "oi");
  check(r.status === 200 && r.action === "process" && r.flow === 2, `resposta v2: action=process e flow=2 (flow=${r.flow})`);
  check(r.contact && r.contact.firstName === "Maria" && "pushName" in r.contact && "name" in r.contact, `contact.firstName = "Maria" (${J(r.contact)})`);
  const s = r.session || {};
  check(s.previous === null && s.resumedFromHuman === null, `session.previous e resumedFromHuman = null numa sessão nova (${J({ previous: s.previous, resumedFromHuman: s.resumedFromHuman })})`);
  const tn = r.tenant || {};
  check(tn.today === localISO(new Date(), tz), `tenant.today = hoje no fuso do tenant (${tn.today})`);
  check(/^\d\d:\d\d$/.test(tn.nowLocal || "") && Math.abs(Number(tn.nowLocal.slice(0, 2)) * 60 + Number(tn.nowLocal.slice(3)) - (Number(localHM(new Date(), tz).slice(0, 2)) * 60 + Number(localHM(new Date(), tz).slice(3)))) <= 2, `tenant.nowLocal ≈ agora local (${tn.nowLocal} vs ${localHM(new Date(), tz)})`);
  check(typeof tn.openNow === "boolean" && "teamNextOpenLabel" in tn, `tenant.openNow / teamNextOpenLabel (${tn.openNow}/${tn.teamNextOpenLabel})`);
  check(tn.changeLeadLabel === "2 horas", `tenant.changeLeadLabel = "2 horas" (=${tn.changeLeadLabel})`);
  check(tn.lastBookableDate && tn.lastBookableDate >= addDaysISO(tn.today, 29) && tn.lastBookableDate <= addDaysISO(tn.today, 30), `tenant.lastBookableDate ≈ hoje+30 (=${tn.lastBookableDate})`);
  check(tn.slotGranularityMin === 30, `tenant.slotGranularityMin = 30 (=${tn.slotGranularityMin})`);
  const resume = (await getTenant(tenantKey)).handoffResumeMinutes || 120;
  check(typeof tn.handoffUntilLabel === "string" && whenLabelsAround(new Date(Date.now() + resume * 60_000), tz).includes(tn.handoffUntilLabel), `tenant.handoffUntilLabel = agora + ${resume} min (=${tn.handoffUntilLabel})`);
  const texts = r.texts || {};
  for (const k of ["MENU_PROMPT", "MENU_HINT", "FOOTER_HINT", "TECH_ERROR", "LABEL_MENU_BOOK", "LABEL_PREVIOUS", "APPOINTMENT_DETAIL", "HUMAN_HANDOFF_OFF_HOURS"]) check(typeof texts[k] === "string" && texts[k].length > 0, `texts.${k} presente na base v2`, "B-3");
  check(!("MAIN_MENU" in texts) || !texts.MAIN_MENU.includes("1."), "a base v2 não usa o MAIN_MENU numerado", "B-3");
  await release(tenantKey, s);
  // sessão expirada há <= 24 h → previous
  const ch2 = newChat(tenantKey, "Joana Lima");
  const a = await claim(tenantKey, ch2, "oi");
  await putSession(tenantKey, a.session, { state: "SELECT_TIME", context: { v: 2, serviceId: S("dupla").services.Corte, date: addDaysISO(todayOf("dupla"), 2) } });
  const cRow = await contactOf(tenantKey, ch2);
  await sql(`UPDATE chat_sessions SET "lastInboundAt" = now() - interval '40 minutes' WHERE "contactId" = $1`, cRow.id);
  const b = await claim(tenantKey, ch2, "oi");
  check(b.session && b.session.expired === true && b.session.state === "MAIN_MENU", `sessão expirada volta a MAIN_MENU (state=${b.session && b.session.state})`);
  check(b.session && b.session.previous && b.session.previous.state === "SELECT_TIME" && b.session.previous.context && b.session.previous.context.serviceId === S("dupla").services.Corte && Math.abs(b.session.previous.idleMin - 40) <= 2, `session.previous = { state, context, idleMin ≈ 40 } do ANTES do reset (${J(b.session && b.session.previous).slice(0, 200)})`);
  await release(tenantKey, b.session);
  await sql(`UPDATE chat_sessions SET "lastInboundAt" = now() - interval '26 hours' WHERE "contactId" = $1`, cRow.id);
  const d = await claim(tenantKey, ch2, "oi");
  check(d.session && d.session.expired === true && d.session.previous === null, `parada há 26 h: previous = null (=${J(d.session && d.session.previous)})`);
  await release(tenantKey, d.session);
  // v1: sem header
  const ch3 = newChat(tenantKey, "Ana Paula");
  const v1 = await claim(tenantKey, ch3, "oi", { flow: undefined });
  check(v1.action === "process" && v1.flow === undefined && !("firstName" in (v1.contact || {})) && v1.texts && "MAIN_MENU" in v1.texts && !("MENU_PROMPT" in v1.texts), `sem o header: resposta v1 (sem flow/firstName; base de textos v1) (flow=${v1.flow}, MENU_PROMPT=${v1.texts && "MENU_PROMPT" in v1.texts})`, "B-3");
  if (v1.session) await release(tenantKey, v1.session);
});

scenario("API-10", "Ciclo do atendente na API: pedido, HUMAN_MODE, \"menu\" do cliente, timeout, resposta da equipe, fluxo v1", "B-2", async () => {
  const tenantKey = "dupla";
  const tenant = await getTenant(tenantKey);
  const p = await db();
  await sub("pedido → menu do cliente", async () => {
    const ch = newChat(tenantKey);
    const a = await claim(tenantKey, ch, "atendente");
    const put = await putSession(tenantKey, a.session, { handoff: true, handoffReason: "CLIENT_REQUEST" });
    check(put.status === 200 && typeof body(put).version === "number", `PUT com handoffReason → 200 { version } (status ${put.status})`);
    const c = await contactOf(tenantKey, ch);
    const row = await p.chatSession.findFirst({ where: { contactId: c.id } });
    const expect = Date.now() + (tenant.handoffResumeMinutes || 120) * 60_000;
    check(row.state === "HUMAN" && row.humanUntil && Math.abs(row.humanUntil.getTime() - expect) < 3 * 60_000, `state=HUMAN, humanUntil ≈ agora + handoffResumeMinutes (${tenant.handoffResumeMinutes}) (=${row.humanUntil})`);
    let hs = await handoffs(c.id);
    check(hs && hs.length === 1 && hs[0].reason === "CLIENT_REQUEST" && !hs[0].endedAt, `1 HandoffRequest aberto CLIENT_REQUEST (${hs ? J(hs.map((h) => h.reason)) : "tabela ausente"})`, hs ? "B-2" : "C-1");
    const ign = await claim(tenantKey, ch, "alguém aí?");
    check(ign.action === "ignore" && ign.reason === "HUMAN_MODE", `mensagem comum → ignore/HUMAN_MODE (${ign.action}/${ign.reason})`);
    const m = await claim(tenantKey, ch, "Menu");
    check(m.action === "process" && m.session && m.session.state === "MAIN_MENU" && m.session.resumedFromHuman === "CLIENT_MENU", `"Menu" → process com resumedFromHuman=CLIENT_MENU (${m.action}, ${m.session && m.session.resumedFromHuman})`);
    hs = await handoffs(c.id);
    check(hs && hs[0] && hs[0].endReason === "CLIENT_MENU" && hs[0].endedAt, `pedido encerrado com CLIENT_MENU (${hs && hs[0] && hs[0].endReason})`, hs ? "B-2" : "C-1");
    if (m.session) await release(tenantKey, m.session);
  });
  await sub("timeout", async () => {
    const ch = newChat(tenantKey);
    const a = await claim(tenantKey, ch, "atendente");
    await putSession(tenantKey, a.session, { handoff: true, handoffReason: "CLIENT_REQUEST" });
    const c = await contactOf(tenantKey, ch);
    await sql(`UPDATE chat_sessions SET "humanUntil" = now() - interval '1 minute' WHERE "contactId" = $1`, c.id);
    const b = await claim(tenantKey, ch, "oi");
    check(b.action === "process" && b.session && b.session.resumedFromHuman === "TIMEOUT", `depois do prazo: process com resumedFromHuman=TIMEOUT (${b.action}, ${b.session && b.session.resumedFromHuman})`);
    const hs = await handoffs(c.id);
    check(hs && hs[0] && hs[0].endReason === "TIMEOUT", `pedido encerrado com TIMEOUT (${hs && hs[0] && hs[0].endReason})`, hs ? "B-2" : "C-1");
    if (b.session) await release(tenantKey, b.session);
  });
  await sub("resposta da equipe", async () => {
    const ch = newChat(tenantKey);
    const a = await claim(tenantKey, ch, "atendente");
    await putSession(tenantKey, a.session, { handoff: true, handoffReason: "CLIENT_REQUEST" });
    const c = await contactOf(tenantKey, ch);
    const f = await claim(tenantKey, ch, "Oi, aqui é a equipe", { fromMe: true });
    check(f.action === "ignore" && f.reason === "HUMAN_TOOK_OVER", `fromMe → ignore/HUMAN_TOOK_OVER (${f.action}/${f.reason})`);
    const row = await p.chatSession.findFirst({ where: { contactId: c.id } });
    const cc = await p.contact.findFirst({ where: { id: c.id } });
    const hs = await handoffs(c.id);
    check(hs && hs[0] && hs[0].answeredAt, "answeredAt marcado", hs ? "B-2" : "C-1");
    check(row.humanUntil && Math.abs(row.humanUntil.getTime() - (Date.now() + tenant.humanPauseMin * 60_000)) < 3 * 60_000, `humanUntil ≈ agora + humanPauseMin (${tenant.humanPauseMin})`);
    check(!cc.botPausedUntil, "Contact.botPausedUntil não é gravado");
    const m = await claim(tenantKey, ch, "menu");
    check(m.action === "process" && m.session && m.session.resumedFromHuman === "CLIENT_MENU", `"menu" ainda vale depois da resposta da equipe (${m.action})`);
    if (m.session) await release(tenantKey, m.session);
  });
  await sub("fluxo v1 (sem handoffReason)", async () => {
    const ch = newChat(tenantKey);
    const a = await claim(tenantKey, ch, "atendente", { flow: undefined });
    await putSession(tenantKey, a.session, { handoff: true });
    const c = await contactOf(tenantKey, ch);
    const row = await p.chatSession.findFirst({ where: { contactId: c.id } });
    const hs = await handoffs(c.id);
    check(hs && hs.length === 1 && hs[0].reason === "LEGACY_FLOW", `HandoffRequest LEGACY_FLOW (${hs ? J(hs.map((h) => h.reason)) : "tabela ausente"})`, hs ? "B-2" : "C-1");
    check(row.humanUntil && Math.abs(row.humanUntil.getTime() - (Date.now() + tenant.humanPauseMin * 60_000)) < 3 * 60_000, `a pausa continua humanPauseMin (=${row.humanUntil})`);
    const m = await claim(tenantKey, ch, "menu", { flow: undefined });
    check(m.action === "ignore" && m.reason === "HUMAN_MODE", `no fluxo v1 o "menu" NÃO é honrado (${m.action}/${m.reason})`);
  });
});

scenario("API-11", "POST /sessions/{id}/release avisa o cliente (TECH_ERROR) só quando a execução morreu segurando a trava", "B-2", async () => {
  await ensureFake();
  await clearFakeSent();
  const tenantKey = "dupla";
  const p = await db();
  const sentFor = async (phone) => (await fakeSent()).filter((x) => x.number.includes(phone));
  await sub("caso feliz e repetição", async () => {
    const ch = newChat(tenantKey);
    const a = await claim(tenantKey, ch, "oi");
    const r = await release(tenantKey, a.session);
    check(r.status === 200 && body(r).released === true && body(r).notified === true, `release avisou (${J(r.body)})`);
    const s = await sentFor(ch.phone);
    check(s.length === 1 && T.TECH_ERROR.test(s[0].text), `a Evolution falsa recebeu o TECH_ERROR (${s.length}: ${s.map((x) => firstLine(x.text)).join(" | ")})`);
    const c = await contactOf(tenantKey, ch);
    const out = await p.chatMessage.findMany({ where: { contactId: c.id, direction: "OUTBOUND" } });
    check(out.length === 1 && T.TECH_ERROR.test(out[0].body), `registrou o ChatMessage OUTBOUND (${out.length})`);
    const a2 = await claim(tenantKey, ch, "oi de novo");
    const r2 = await release(tenantKey, a2.session);
    check(body(r2).released === true && body(r2).notified === false, `2ª vez em <10 min: notified=false (${J(r2.body)})`);
    check((await sentFor(ch.phone)).length === 1, "nenhum 2º aviso");
  });
  await sub("condições que impedem o aviso", async () => {
    const ch = newChat(tenantKey);
    const a = await claim(tenantKey, ch, "oi");
    const off = await release(tenantKey, a.session, { notify: false });
    check(body(off).released === true && body(off).notified === false && (await sentFor(ch.phone)).length === 0, `notify:false não avisa (${J(off.body)})`);
    const ch2 = newChat(tenantKey);
    const b = await claim(tenantKey, ch2, "oi");
    const wrong = await api(tenantKey, "POST", `/sessions/${encodeURIComponent(b.session.id)}/release`, { lockToken: "token-de-outra-execucao" });
    check(wrong.status === 200 && body(wrong).notified === false && (await sentFor(ch2.phone)).length === 0, `trava de outra execução: não avisa (${J(wrong.body)})`);
    await release(tenantKey, b.session);
    const ch3 = newChat(tenantKey);
    const c = await claim(tenantKey, ch3, "oi");
    await sql(`UPDATE chat_sessions SET "lastInboundAt" = now() - interval '10 minutes' WHERE id = $1`, c.session.id);
    const old = await release(tenantKey, c.session);
    check(body(old).notified === false && (await sentFor(ch3.phone)).length === 0, `última mensagem há 10 min (> 5): não avisa (${J(old.body)})`);
    const ch5 = newChat(tenantKey);
    const e = await claim(tenantKey, ch5, "oi");
    await sql(`UPDATE chat_sessions SET state = 'HUMAN', "humanUntil" = now() + interval '60 minutes' WHERE id = $1`, e.session.id);
    const hum = await release(tenantKey, e.session);
    check(body(hum).notified === false && (await sentFor(ch5.phone)).length === 0, `state=HUMAN: não avisa (${J(hum.body)})`);
  });
  await sub("falha no envio nunca vira 5xx", async () => {
    const before = await sql(`SELECT "evolutionApiUrl" FROM platform_settings WHERE id = 1`);
    try {
      await sql(`UPDATE platform_settings SET "evolutionApiUrl" = 'http://127.0.0.1:1' WHERE id = 1`);
      const ch = newChat(tenantKey);
      const a = await claim(tenantKey, ch, "oi");
      const r = await release(tenantKey, a.session);
      check(r.status === 200 && body(r).released === true && body(r).notified === false, `Evolution fora do ar: 200, released=true, notified=false (${r.status} ${J(r.body)})`);
    } finally {
      await sql(`UPDATE platform_settings SET "evolutionApiUrl" = $1 WHERE id = 1`, before[0].evolutionApiUrl);
    }
  });
});

scenario("API-12", "HandoffRequest criado pelo PUT /sessions com offHours = equipe fechada agora", "B-2", async () => {
  const tenantKey = "equipe";
  try {
    for (const [mode, expected] of [["open", false], ["closed", true]]) {
      await setTeamHours(tenantKey, mode);
      const ch = newChat(tenantKey);
      const a = await claim(tenantKey, ch, "atendente");
      const put = await putSession(tenantKey, a.session, { handoff: true, handoffReason: "CLIENT_REQUEST" });
      const c = await contactOf(tenantKey, ch);
      const hs = await handoffs(c.id);
      check(put.status === 200 && hs && hs.length === 1 && hs[0].offHours === expected, `equipe ${mode === "open" ? "aberta" : "fechada"} → offHours=${expected} (${hs ? J(hs.map((h) => h.offHours)) : "tabela ausente"}; PUT ${put.status})`, hs ? "B-2" : "C-1");
      const x = await claim(tenantKey, ch, "menu");
      if (x.session) await release(tenantKey, x.session, { notify: false });
    }
  } finally {
    await setTeamHours(tenantKey, "open");
  }
});

scenario("API-13", "Textos portados aparecem no claim v2 (MENU_PROMPT) e o claim v1 continua entregando o MAIN_MENU editado", "B-3", async () => {
  const t = S("menuport");
  const err = await runPortMigration();
  check(!err, err || "migration de porte executada", "C-1");
  const ch = new Chat(world, t.token, newPhone(), { pushName: "Maria Souza" });
  const v2 = await claim("menuport", ch, "oi");
  const header = "Oi {nome}! Aqui é a *{empresa}*.\nEscolha uma opção:";
  check(v2.texts && v2.texts.MENU_PROMPT === header, `claim v2: texts.MENU_PROMPT = cabeçalho portado (${J(v2.texts && v2.texts.MENU_PROMPT)})`, err ? "C-1" : "B-3");
  if (v2.session) await release("menuport", v2.session);
  const ch2 = new Chat(world, t.token, newPhone(), { pushName: "Maria Souza" });
  const v1 = await claim("menuport", ch2, "oi", { flow: undefined });
  check(v1.texts && v1.texts.MAIN_MENU === t.legacyMainMenu, `claim v1: texts.MAIN_MENU = a edição da empresa, intacta (${J(v1.texts && v1.texts.MAIN_MENU).slice(0, 80)})`, "B-3");
  check(v1.texts && !("MENU_PROMPT" in v1.texts), "claim v1 não recebe chaves do v2", "B-3");
  if (v1.session) await release("menuport", v1.session);
  const other = new Chat(world, S("dupla").token, newPhone(), { pushName: "Maria Souza" });
  const dv = await claim("dupla", other, "oi");
  check(dv.texts && dv.texts.MENU_PROMPT === "Como posso ajudar você hoje?", `empresa sem edição recebe o padrão v2 (${J(dv.texts && dv.texts.MENU_PROMPT)})`, "B-3");
  if (dv.session) await release("dupla", dv.session);
});
