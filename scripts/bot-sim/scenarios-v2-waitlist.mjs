// Cenários da lista de espera (melhoria 7): convite quando o dia está cheio, entrar, ver/sair pelo menu, oferta quando um
// horário abre (mensagem do PAINEL pela Evolution falsa), SIM/NÃO, horário ocupado por outro canal e oferta vencida.
// Uso: node scripts/bot-sim/withdb.mjs node scripts/bot-sim/scenarios-v2.mjs "^WL-"
// Tenant "grade": 1 serviço (Escova, 45 min), 1 profissional (Ana, 09-18), grade 30, sem antecedência mínima.
import { scenario as baseScenario, check, sub, conv, say, start, api, sql, db, sleep, S, T, TZ, localISO, addDaysISO, ddmm, newPhone, allSlots, createAppt, ensureFake, fakeSent, clearFakeSent, parseOptions, brief } from "./v2-kit.mjs";

const TENANT = "grade";
const RUN = String(Date.now()).slice(-6);
let seq = 0;

// ---------------------------------------------------------------- relógio das ofertas automáticas
// A oferta automática só sai entre 08h e 21h no fuso da empresa (de propósito: fora disso fica adiada até a manhã; essa regra é
// provada nos testes de integração, com relógio injetado). O simulador fala com um painel real, sem como injetar relógio, então
// os cenários que esperam a oferta chegar rodam com a empresa "grade" num fuso em que AGORA é horário comercial (10h às 19h,
// margem para a rodada não cruzar a borda). Se o fuso atual da empresa já serve, nada muda. Restaura no fim, mesmo se falhar.
// `BOTSIM_WL_TZ_START` (um fuso IANA) simula "a empresa começa num fuso em que é de madrugada/de noite" para provar a escolha.
const WINDOW_TZ_CANDIDATES = ["America/Sao_Paulo", "America/Los_Angeles", "America/New_York", "Europe/Lisbon", "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata", "Asia/Tokyo", "Pacific/Auckland", "Pacific/Honolulu"];
const hourIn = (zone, now = new Date()) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(now));
const comfortable = (zone) => { const h = hourIn(zone); return h >= 10 && h < 19; };

function pickWindowTz(start) {
  if (comfortable(start)) return start;
  const found = WINDOW_TZ_CANDIDATES.find(comfortable);
  if (!found) throw new Error("nenhum fuso candidato está em horário comercial agora");
  return found;
}

async function withOpenSendWindow(fn) {
  const original = TZ[TENANT];
  const chosen = pickWindowTz(process.env.BOTSIM_WL_TZ_START || original);
  if (chosen !== original || process.env.BOTSIM_WL_TZ_START) {
    await sql(`UPDATE tenants SET timezone = $1 WHERE id = $2`, chosen, S(TENANT).tenantId);
    TZ[TENANT] = chosen;
  }
  try {
    return await fn();
  } finally {
    if (TZ[TENANT] !== original) {
      TZ[TENANT] = original;
      await sql(`UPDATE tenants SET timezone = $1 WHERE id = $2`, original, S(TENANT).tenantId);
    }
  }
}
/** Cenário que depende da oferta automática: roda com a janela de envio aberta (ver acima). */
const scenario = (id, title, task, fn) => baseScenario(id, title, task, () => withOpenSendWindow(fn));

const W = {
  INVITE: /lista de espera/i,
  JOINED: /Você está na \*?lista de espera/,
  OFFER: /Abriu um horário/,
  ACCEPTED: /Horário marcado/,
  DECLINED: /Tirei você da lista de espera/,
  GONE: /prazo para responder acabou/,
  TAKEN: /acabou de ser ocupado por outra pessoa/,
  VIEW: /Sua lista de espera/,
  LEFT: /tirei você da lista de espera/,
  EMPTY: /não está em nenhuma lista de espera/,
};

const dayFor = (offset) => addDaysISO(localISO(new Date(), TZ[TENANT]), offset);
const svc = () => S(TENANT).services.Escova;
const ana = () => S(TENANT).pros.ana;

/** Contato "ocupante" que segura os horários do dia (cliente da API, não do bot). */
async function holder() {
  const p = await db();
  return p.contact.create({ data: { tenantId: S(TENANT).tenantId, waJid: `${newPhone()}${++seq}@s.whatsapp.net`, name: "Ocupante" } });
}

/** Ocupa o dia inteiro. Devolve os ids dos agendamentos, na ordem. */
async function fillDay(date) {
  const h = await holder();
  const made = [];
  for (let i = 0; i < 24; i++) {
    const slots = await allSlots(TENANT, svc(), ana(), date);
    if (!slots.length) break;
    const r = await createAppt(TENANT, { contactId: h.id, serviceId: svc(), professionalId: ana(), startsAt: slots[0].id, key: `wl-fill-${RUN}-${date}-${i}` });
    if (r.status !== 200 && r.status !== 201) throw new Error(`não consegui ocupar ${date}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    made.push({ id: r.body.appointment.id, contactId: h.id, startsAt: slots[0].id });
  }
  if (made.length === 0) throw new Error(`o dia ${date} já estava cheio ou sem expediente`);
  return made;
}

/** Do zero até o convite da lista de espera para `date`. */
async function toInvite(c, date) {
  await start(c);
  await c.pick(/Agendar/);
  if (T.CHOOSE_SERVICE.test(c.last)) await c.pick(/Escova/);
  const r = await say(c, ddmm(date));
  if (!W.INVITE.test(r.text) || !/Entrar na lista de espera/.test(r.text)) throw new Error(`esperava o convite da lista de espera e veio:\n${r.text}`);
  return r;
}

async function entryOf(contactId, date) {
  const rows = await sql(`SELECT id, status, source, period, "offeredSlotStart", "offerExpiresAt", "appointmentId" FROM waitlist_entries WHERE "contactId" = $1 AND "desiredDate" = $2::date ORDER BY "createdAt" DESC`, contactId, date);
  return rows[0] || null;
}

/** Espera (até ~8 s) a mensagem do painel para o número. */
async function waitSent(number, re) {
  for (let i = 0; i < 32; i++) {
    const sent = (await fakeSent()).filter((m) => m.number === number && re.test(m.text));
    if (sent.length) return sent[sent.length - 1];
    await sleep(250);
  }
  return null;
}

baseScenario("WL-01", "Dia cheio: convite, entrar na lista, 'Ver outros dias' segue procurando; fila FIFO guardada no banco", "W-1", async () => {
  await ensureFake();
  const date = dayFor(6);
  await fillDay(date);

  await sub("entrar", async () => {
    const c = conv(TENANT);
    const invite = await toInvite(c, date);
    check(/Não tem horário livre em/.test(invite.text) && /Entrar na lista de espera/.test(invite.text) && /Ver outros dias/.test(invite.text), `convite com as duas opções | ${brief(invite.text)}`);
    const r = await c.pick(/Entrar na lista/);
    check(W.JOINED.test(r.text), `confirmação de entrada | ${brief(r.text)}`);
    check(T.POST_ACTION_MENU.test(r.text), `o 'posso ajudar em algo mais' vem em seguida | ${brief(r.text)}`);
    const row = await entryOf(await c.contactId(), date);
    check(row && row.status === "WAITING" && row.source === "BOT" && row.period === "ANY", `linha WAITING, origem BOT, qualquer horário | ${JSON.stringify(row)}`);
    // Menu agora tem "Minha lista de espera" por último.
    const m = await say(c, "menu");
    const labels = parseOptions(m.text).map((o) => o.label);
    check(labels.length === 4 && /lista de espera/i.test(labels[3]) && /Agendar/.test(labels[0]), `menu com a 4ª opção 'Minha lista de espera' | ${labels.join(" | ")}`);
  });

  await sub("ver outros dias", async () => {
    const c = conv(TENANT);
    await toInvite(c, date);
    const r = await c.pick(/Ver outros dias/);
    check(T.NO_SLOTS_DAY.test(r.text) || T.CHOOSE_DAY.test(r.text), `volta ao fluxo normal com o próximo dia | ${brief(r.text)}`);
    check(!(await entryOf(await c.contactId(), date)), "não criou fila ao recusar o convite");
  });

  await sub("responder 'não' ao convite", async () => {
    const c = conv(TENANT);
    await toInvite(c, date);
    const r = await say(c, "não");
    check(!W.JOINED.test(r.text), `'não' não entra na lista | ${brief(r.text)}`);
  });

  await sub("entrar duas vezes é idempotente", async () => {
    const c = conv(TENANT);
    await toInvite(c, date);
    await c.pick(/Entrar na lista/);
    const c2 = conv(TENANT);
    // mesmo cliente de novo (mesmo telefone), depois de a sessão acabar
    c2.phone = c.phone;
    c2.jid = c.jid;
    await toInvite(c2, date);
    const r = await c2.pick(/Entrar na lista/);
    check(/já está na lista de espera/.test(r.text), `2ª entrada devolve 'já está na lista' | ${brief(r.text)}`);
    const rows = await sql(`SELECT id FROM waitlist_entries WHERE "contactId" = $1 AND "desiredDate" = $2::date`, await c.contactId(), date);
    check(rows.length === 1, `uma linha só | ${rows.length}`);
  });
});

baseScenario("WL-02", "Minha lista de espera: ver e sair pelo menu; vazia diz que não há lista", "W-1", async () => {
  const date = dayFor(7);
  await fillDay(date);
  const c = conv(TENANT);
  await toInvite(c, date);
  await c.pick(/Entrar na lista/);
  const m = await say(c, "menu");
  check(parseOptions(m.text).length === 4, `menu com 4 opções | ${brief(m.text)}`);
  const v = await c.pick(/lista de espera/i);
  check(W.VIEW.test(v.text) && /Escova/.test(v.text), `lista do cliente com o serviço | ${brief(v.text)}`);
  const left = await c.pick(/Escova/);
  check(W.LEFT.test(left.text), `saiu da lista | ${brief(left.text)}`);
  const row = await entryOf(await c.contactId(), date);
  check(row && row.status === "CANCELED", `linha CANCELED | ${JSON.stringify(row)}`);
  const m2 = await say(c, "menu");
  check(parseOptions(m2.text).length === 3, `sem fila, o menu volta a ter 3 opções | ${brief(m2.text)}`);
  const alias = await say(c, "lista de espera");
  check(!W.VIEW.test(alias.text), `sem fila, 'lista de espera' não abre nada | ${brief(alias.text)}`);
});

scenario("WL-03", "Horário abre (cancelamento): o 1º da fila recebe a oferta do painel e SIM marca o horário", "W-1", async () => {
  await ensureFake();
  const date = dayFor(8);
  const taken = await fillDay(date);
  const a = conv(TENANT);
  await toInvite(a, date);
  await a.pick(/Entrar na lista/);
  const b = conv(TENANT);
  await toInvite(b, date);
  await b.pick(/Entrar na lista/);

  await clearFakeSent();
  const first = taken[0];
  const cancel = await api(TENANT, "POST", `/appointments/${first.id}/cancel`, { contactId: first.contactId });
  check(cancel.status === 200, `cancelamento aceito | ${cancel.status}`);

  const offer = await waitSent(a.phone, W.OFFER);
  check(!!offer, "o 1º da fila recebeu a oferta pelo WhatsApp do painel");
  check(offer && /30 minutos/.test(offer.text) && /sim/i.test(offer.text), `a oferta traz o prazo e como responder | ${brief(offer && offer.text)}`);
  const stillB = await entryOf(await b.contactId(), date);
  check(stillB && stillB.status === "WAITING", `o 2º continua esperando | ${stillB && stillB.status}`);
  const offeredA = await entryOf(await a.contactId(), date);
  check(offeredA && offeredA.status === "OFFERED", `1º em OFFERED | ${offeredA && offeredA.status}`);

  const r = await say(a, "sim");
  check(W.ACCEPTED.test(r.text), `SIM marca o horário | ${brief(r.text)}`);
  const row = await entryOf(await a.contactId(), date);
  check(row && row.status === "FULFILLED" && row.appointmentId, `entrada FULFILLED com o agendamento | ${JSON.stringify(row)}`);
  const appt = (await sql(`SELECT status::text AS status, "contactId" FROM appointments WHERE id = $1`, row.appointmentId))[0];
  check(appt && appt.status === "SCHEDULED" && appt.contactId === (await a.contactId()), `agendamento criado para o cliente | ${JSON.stringify(appt)}`);
});

scenario("WL-04", "NÃO passa o horário ao próximo da fila, que aceita com 'ok'", "W-1", async () => {
  await ensureFake();
  const date = dayFor(9);
  const taken = await fillDay(date);
  const a = conv(TENANT);
  await toInvite(a, date);
  await a.pick(/Entrar na lista/);
  const b = conv(TENANT);
  await toInvite(b, date);
  await b.pick(/Entrar na lista/);

  await clearFakeSent();
  await api(TENANT, "POST", `/appointments/${taken[2].id}/cancel`, { contactId: taken[2].contactId });
  check(!!(await waitSent(a.phone, W.OFFER)), "a oferta foi para o 1º");

  const r = await say(a, "não");
  check(W.DECLINED.test(r.text), `NÃO tira da lista | ${brief(r.text)}`);
  check(!!(await waitSent(b.phone, W.OFFER)), "o horário passou ao 2º");
  const rb = await say(b, "ok");
  check(W.ACCEPTED.test(rb.text), `'ok' aceita | ${brief(rb.text)}`);
  const row = await entryOf(await a.contactId(), date);
  check(row && row.status === "CANCELED", `1º ficou CANCELED | ${row && row.status}`);
});

scenario("WL-05", "Horário ocupado por outro canal durante o prazo: o cliente é avisado e continua na fila", "W-1", async () => {
  await ensureFake();
  const date = dayFor(10);
  const taken = await fillDay(date);
  const a = conv(TENANT);
  await toInvite(a, date);
  await a.pick(/Entrar na lista/);

  await clearFakeSent();
  await api(TENANT, "POST", `/appointments/${taken[1].id}/cancel`, { contactId: taken[1].contactId });
  check(!!(await waitSent(a.phone, W.OFFER)), "oferta enviada");
  // Outro canal (painel/bot) pega o horário antes da resposta.
  const h = await holder();
  const grab = await createAppt(TENANT, { contactId: h.id, serviceId: svc(), professionalId: ana(), startsAt: taken[1].startsAt, key: `wl-grab-${RUN}-${date}` });
  check(grab.status === 200 || grab.status === 201, `o outro canal conseguiu o horário | ${grab.status}`);

  const r = await say(a, "sim");
  check(W.TAKEN.test(r.text), `avisa que o horário foi ocupado | ${brief(r.text)}`);
  const row = await entryOf(await a.contactId(), date);
  check(row && row.status === "WAITING", `continua na fila (WAITING) | ${row && row.status}`);
});

scenario("WL-06", "Oferta vencida: responder atrasado leva a mensagem de prazo; o tick passa ao próximo", "W-1", async () => {
  await ensureFake();
  const date = dayFor(11);
  const taken = await fillDay(date);
  const a = conv(TENANT);
  await toInvite(a, date);
  await a.pick(/Entrar na lista/);
  const b = conv(TENANT);
  await toInvite(b, date);
  await b.pick(/Entrar na lista/);

  await clearFakeSent();
  await api(TENANT, "POST", `/appointments/${taken[0].id}/cancel`, { contactId: taken[0].contactId });
  check(!!(await waitSent(a.phone, W.OFFER)), "oferta enviada ao 1º");

  await sql(`UPDATE waitlist_entries SET "offerExpiresAt" = now() - interval '1 minute' WHERE "contactId" = $1 AND "desiredDate" = $2::date`, await a.contactId(), date);
  // Chama o tick pela rota (o segredo interno do seed).
  const tick = await fetch(`${process.env.BOTSIM_PANEL || "http://localhost:3900"}/api/internal/v1/waitlist/tick`, { method: "POST", headers: { authorization: `Bearer ${(await import("./lib.mjs")).seed.secret}` } });
  check(tick.status === 200, `tick respondeu 200 | ${tick.status}`);
  check(!!(await waitSent(b.phone, W.OFFER)), "o tick passou o horário ao 2º");
  const row = await entryOf(await a.contactId(), date);
  check(row && row.status === "EXPIRED", `1º ficou EXPIRED | ${row && row.status}`);

  const r = await say(a, "sim");
  check(W.GONE.test(r.text), `responder atrasado: oferta vencida | ${brief(r.text)}`);
  check(parseOptions(r.text).length >= 3, `e o menu volta | ${brief(r.text)}`);
});
