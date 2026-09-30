// Cenários v2, parte B: CA-32..CA-47 (atendente, limite, grade, formatação, compatibilidade e publicação).
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scenario, external, check, sub, conv, convPhone, T, say, opts, dayOpts, timeOpts, labelOf, brief, firstLine, norm, ctxOf, start, toDay, toTime, toAfterTime, toConfirm, fromDay, book,
  S, handoffs, freeSlot, allSlots, createAppt, db, sql, setTenant, getTenant, api, api2, seed, TZ, localISO, localHM, addDaysISO, ddmm, parseOptions, hasKeycap, world, makeWorld, Convo, newPhone,
  lintMessage, setHumanUntil, state, runPortMigration,
  J, trySetTenant,
} from "./v2-kit.mjs";
import { Chat } from "./chat.mjs";
import { REPO } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const todayOf = (k) => localISO(new Date(), TZ[k]);
const menuOk = (c) => opts(c).some((o) => /Agendar/.test(o.label));

// ================================================================ atendente, limite e grade
scenario("CA-32", 'Em HUMAN por pedido do cliente, "menu" encerra o pedido (CLIENT_MENU) e responde BOT_RESUMED + menu na mesma mensagem', "B-2", async () => {
  const c = conv();
  await start(c);
  await say(c, "atendente");
  const ign = await say(c, "alguém aí?");
  check(ign.msgs.length === 0 && ign.claim && ign.claim.action === "ignore", `mensagem comum é ignorada (claim=${ign.claim && ign.claim.action})`);
  const r = await say(c, "menu");
  check(T.BOT_RESUMED.test(r.text) && menuOk(c), `"menu" → BOT_RESUMED + menu | ${brief(r.text)}`, "W-1");
  check(r.msgs.length === 1, `na mesma mensagem (${r.msgs.length} mensagem(ns))`, "W-1");
  const hs = await handoffs(await c.contactId());
  check(hs && hs.length === 1 && hs[0].endReason === "CLIENT_MENU" && hs[0].endedAt, `pedido encerrado com CLIENT_MENU (${hs && J(hs.map((h) => h.endReason))})`, hs ? "B-2" : "C-1");
  const row = await c.sessionRow();
  check(row.state === "MAIN_MENU" && !row.humanUntil, `sessão em MAIN_MENU e humanUntil zerado (state=${row.state}, humanUntil=${row.humanUntil})`, "B-2");
  const r2 = await say(c, "1");
  check(T.CHOOSE_SERVICE.test(r2.text) || T.CHOOSE_DAY.test(r2.text) || T.CHOOSE_PROFESSIONAL.test(r2.text), `o bot atende de novo | ${brief(r2.text)}`);
});

scenario("CA-33", "Sem resposta da equipe, depois de handoffResumeMinutes a próxima mensagem encerra o pedido (TIMEOUT) e o bot responde", "B-2", async () => {
  const c = conv();
  await start(c);
  await say(c, "atendente");
  await setHumanUntil(c, -1); // o prazo (handoffResumeMinutes) venceu
  const r = await say(c, "oi");
  check(r.msgs.length === 1 && menuOk(c), `passado o prazo, o bot responde com o menu | ${brief(r.text)}`, "B-2");
  const hs = await handoffs(await c.contactId());
  check(hs && hs.length === 1 && hs[0].endReason === "TIMEOUT" && hs[0].endedAt, `pedido encerrado com TIMEOUT (${hs && J(hs.map((h) => h.endReason))})`, hs ? "B-2" : "C-1");
  const row = await c.sessionRow();
  check(row.state !== "HUMAN", `sessão não está mais em HUMAN (state=${row.state})`, "B-2");
});

scenario("CA-34", "fromMe da equipe durante o pedido marca answeredAt e estende humanUntil para humanPauseMin; sem pedido, comportamento v1", "B-2", async () => {
  const tenant = await getTenant("dupla");
  await sub("com pedido do cliente", async () => {
    const c = conv();
    await start(c);
    await say(c, "atendente");
    const r = await say(c, "Oi, aqui é a equipe. Já vou te ajudar.", { fromMe: true });
    check(r.claim && r.claim.action === "ignore" && r.claim.reason === "HUMAN_TOOK_OVER", `fromMe → ignore/HUMAN_TOOK_OVER (claim=${r.claim && r.claim.action}/${r.claim && r.claim.reason})`);
    const hs = await handoffs(await c.contactId());
    check(hs && hs[0] && hs[0].answeredAt, "HandoffRequest.answeredAt marcado", hs ? "B-2" : "C-1");
    const row = await c.sessionRow();
    const expect = Date.now() + tenant.humanPauseMin * 60_000;
    check(row.humanUntil && Math.abs(new Date(row.humanUntil).getTime() - expect) < 3 * 60_000, `humanUntil ≈ agora + humanPauseMin (${tenant.humanPauseMin} min) (=${row.humanUntil})`, "B-2");
    const ct = await c.contactRow();
    check(!ct.botPausedUntil, `Contact.botPausedUntil NÃO é gravado durante o pedido (=${ct.botPausedUntil})`, "B-2");
    const r2 = await say(c, "menu");
    check(T.BOT_RESUMED.test(r2.text) && menuOk(c), `"menu" do cliente continua funcionando depois da resposta da equipe | ${brief(r2.text)}`, "B-2");
  });
  await sub("sem pedido do cliente (v1)", async () => {
    const c = conv();
    await start(c);
    const r = await say(c, "Oi, aqui é a equipe.", { fromMe: true });
    check(r.claim && r.claim.action === "ignore" && r.claim.reason === "HUMAN_TOOK_OVER", `fromMe sem pedido → HUMAN_TOOK_OVER (v1) (claim=${r.claim && r.claim.action}/${r.claim && r.claim.reason})`);
    const ct = await c.contactRow();
    check(ct.botPausedUntil && new Date(ct.botPausedUntil) > new Date(), "Contact.botPausedUntil gravado (v1 mantido)");
    const r2 = await say(c, "menu");
    check(r2.msgs.length === 0, `"menu" NÃO é honrado sem pedido do cliente (respostas=${r2.msgs.length})`);
  });
});

scenario("CA-35", "Cliente com 3 agendamentos futuros → LIMIT_REACHED (3 + atendente); POST direto → 422; limite 0 = sem limite; remarcar não é barrado", "B-1", async () => {
  const t = S("limite");
  const p = await db();
  let created = null;
  try {
    const c = convPhone("limite", t.contactPhone);
    await start(c);
    const r = await say(c, "1");
    check(T.APPOINTMENT_LIMIT.test(r.text), `escolher "Agendar" com 3 futuros → APPOINTMENT_LIMIT | ${brief(r.text)}`, "W-1");
    const o = opts(c);
    check(o.length === 4 && /atendente/i.test(o[3].label) && /Escova/.test(o[0].label) && /Manicure/.test(o[1].label) && /Corte/.test(o[2].label), `os 3 agendamentos (por data) + atendente (${o.map((x) => x.label).join(" | ")})`, "W-1");
    const cid = t.contactId;
    const slot = await freeSlot("limite", t.services.Corte, t.pros.ana, 12);
    const r422 = await createAppt("limite", { contactId: cid, serviceId: t.services.Corte, professionalId: t.pros.ana, startsAt: slot.iso, key: `ca35-a-${Date.now()}`, flow2: true });
    const js = J(r422.body);
    check(r422.status === 422 && /LIMIT_REACHED/.test(js), `POST /appointments com o header do fluxo v2 → 422 LIMIT_REACHED (status ${r422.status}: ${js.slice(0, 160)})`);
    check(/"max":3/.test(js) && /"count":3/.test(js), `com details { max: 3, count: 3 } (${js.slice(0, 200)})`);
    // remarcar não é barrado
    await sub("remarcar com 3 agendamentos", async () => {
    await c.pick(/Escova/);
    check(T.APPOINTMENT_DETAIL.test(c.last) || T.APPOINTMENT_LOCKED.test(c.last), `escolher um agendamento abre o detalhe | ${brief(c.last)}`, "W-1");
    await c.pick(/Remarcar/);
    await say(c, String(dayOpts(c.last)[3].n));
    await say(c, String(timeOpts(c.last)[0].n));
    check(T.CONFIRM_RESCHEDULE.test(c.last), `remarcar chega à confirmação (não é barrado pelo limite) | ${brief(c.last)}`, "W-1");
    const rr = await c.pick(/Confirmar/);
    check(T.RESCHEDULED.test(rr.text), `remarcação concluída com 3 agendamentos | ${brief(rr.text)}`, "B-1");
    });
    // limite 0 = sem limite
    const errSet = await trySetTenant("limite", { maxFutureAppointmentsPerContact: 0 });
    check(!errSet, `a coluna Tenant.maxFutureAppointmentsPerContact existe (${errSet || "ok"})`, "C-1");
    if (!errSet) {
      const key = `ca35-b-${Date.now()}`;
      const ok = await createAppt("limite", { contactId: cid, serviceId: t.services.Corte, professionalId: t.pros.ana, startsAt: (await freeSlot("limite", t.services.Corte, t.pros.ana, 14)).iso, key, flow2: true });
      created = key;
      check(ok.status === 201, `com maxFutureAppointmentsPerContact=0 o POST passa (status ${ok.status})`);
    }
  } finally {
    if (created) await p.appointment.deleteMany({ where: { idempotencyKey: created } });
    await setTenant("limite", { maxFutureAppointmentsPerContact: 3 }).catch(() => {});
  }
});

scenario("CA-36", "Grade 30: depois de uma Escova (45 min) às 09:00 o próximo é 10:00, nada fora de :00/:30; grade 15: :00/:15/:30/:45", "B-1", async () => {
  const t = S("grade");
  const c = conv("grade");
  await start(c, { named: true });
  const cid = await c.contactId();
  const date = addDaysISO(todayOf("grade"), 3);
  const nine = new Date(`${date}T12:00:00Z`).toISOString(); // 09:00 em São Paulo (UTC-3)
  const key = `ca36-${Date.now()}`;
  const p = await db();
  try {
    const b = await createAppt("grade", { contactId: cid, serviceId: t.services.Escova, professionalId: t.pros.ana, startsAt: nine, key });
    check(b.status === 201, `Escova 09:00 reservada (status ${b.status})`);
    const s30 = await allSlots("grade", t.services.Escova, t.pros.ana, date);
    const labels30 = s30.map((x) => x.label);
    check(labels30[0] === "10:00", `grade 30: o próximo depois das 09:00 é 10:00 (${labels30.slice(0, 4).join(", ")})`);
    check(labels30.length > 0 && labels30.every((l) => /:(00|30)$/.test(l)), `grade 30: nenhum horário fora de :00/:30 (${labels30.join(",")})`);
    await setTenant("grade", { slotGranularityMin: 15 });
    const s15 = await allSlots("grade", t.services.Escova, t.pros.ana, date);
    const labels15 = s15.map((x) => x.label);
    check(labels15.every((l) => /:(00|15|30|45)$/.test(l)) && labels15.some((l) => /:(15|45)$/.test(l)), `grade 15: só :00/:15/:30/:45 e usa :15/:45 (${labels15.slice(0, 8).join(",")})`);
    check(labels15[0] === "09:45", `grade 15: depois da Escova (09:00–09:45) o próximo é 09:45 (${labels15[0]})`);
  } finally {
    await p.appointment.deleteMany({ where: { idempotencyKey: key } });
    await setTenant("grade", { slotGranularityMin: 30 });
  }
  const so = S("solo");
  const day = addDaysISO(todayOf("solo"), 2);
  const ss = await allSlots("solo", so.services.Corte, so.pros.ze, day);
  check(ss.length > 0 && ss.every((x) => /:(00|15|30|45)$/.test(x.label)) && ss.some((x) => /:(15|45)$/.test(x.label)), `tenant com grade 15 (solo): horários em :00/:15/:30/:45 (${ss.map((x) => x.label).slice(0, 8).join(",")})`);
});

scenario("CA-37", "Serviço sem profissional com expediente e profissional sem expediente não aparecem; empresa sem serviço agendável → NO_SERVICES + atendente", "B-1", async () => {
  await sub("serviços e profissionais filtrados", async () => {
    const c = conv("bela");
    await start(c, { named: true });
    await c.pick(/Agendar/);
    let labels = opts(c).map((x) => x.label);
    await c.pick(/Ver mais/);
    labels = labels.concat(opts(c).map((x) => x.label));
    check(!labels.some((l) => /Limpeza de pele/.test(l)), '"Limpeza de pele" (sem profissional) não aparece');
    check(!labels.some((l) => /Sem expediente/.test(l)), '"Sem expediente" (só a Carla, sem horário) não aparece');
    check(!labels.some((l) => /Legado inativo/.test(l)), "serviço inativo não aparece");
    check(labels.some((l) => /Barba/.test(l)), '"Barba" (só o Bruno, que tem expediente) aparece');
    const c2 = conv("bela");
    await start(c2, { named: true });
    await c2.pick(/Agendar/);
    await c2.pick(/Corte feminino/);
    const names = opts(c2).map((x) => x.label).join("|");
    check(/Ana/.test(names) && /Bruno/.test(names) && !/Carla/.test(names) && !/Dani/.test(names), `profissionais: Ana e Bruno; sem Carla (sem expediente) nem Dani (inativa) (${names})`);
  });
  for (const key of ["semagenda", "vazio"]) {
    await sub(`${key}: NO_SERVICES`, async () => {
      const c = conv(key);
      await start(c);
      const r = await say(c, "1");
      check(T.NO_SERVICES.test(r.text) && opts(c).some((x) => /atendente/i.test(x.label)), `${key}: NO_SERVICES + atendente | ${brief(r.text)}`, "W-1");
    });
  }
});

// ================================================================ formatação
/** Varre as telas do fluxo e devolve todas as mensagens do bot (cacheado). */
let sweepCache = null;
async function sweep() {
  if (sweepCache) return sweepCache;
  const msgs = [];
  const grab = (r) => { for (const m of r.msgs || []) msgs.push(m); return r; };
  const safe = async (label, fn) => { try { await fn(); } catch (e) { /* tela inesperada: o que já foi coletado vale */ } };
  await safe("fluxo completo", async () => {
    const c = conv("dupla", { pushName: "Maria Souza" });
    const s = (t, o) => say(c, t, o).then(grab);
    await s("oi"); await s("1"); await s("1"); await s("1");
    await s("ajuda"); await s("oi");
    await s("1"); // Primeiro horário livre
    await s("voltar");
    await s(String(dayOpts(c.last)[1].n));
    await s("zzz");
    await s(String(timeOpts(c.last)[0].n));
    await s("."); await s("Maria Souza");
    await s("corrigir"); await s("voltar");
    await s("1");
    await s("2"); await s("2"); await s("2"); // detalhe → CONFIRM_CANCEL → "Não, manter"
    await s("2"); await s("2"); await s("1"); // detalhe → cancelar → sim
    await s("sair"); await s("oi"); await s("asdf"); await s("asdf");
    await s("", { kind: "audio" });
  });
  await safe("vazio", async () => { const v = conv("vazio"); grab(await say(v, "oi")); grab(await say(v, "1")); });
  await safe("limite", async () => { const l = convPhone("limite", S("limite").contactPhone); grab(await say(l, "oi")); grab(await say(l, "1")); });
  await safe("bela", async () => { const b = conv("bela"); grab(await say(b, "oi")); grab(await say(b, "1")); grab(await say(b, "ver mais")); });
  await safe("especial", async () => { const a = conv("especial", { pushName: "" }); grab(await say(a, "oi")); grab(await say(a, "1")); grab(await say(a, "corte")); });
  sweepCache = msgs;
  return msgs;
}
// O CA-44 roda o fluxo v1 (fixture) DE PROPÓSITO para gravar a sessão antiga: as falas dele não valem para as varreduras do v2.
const allRunMessages = (state) => state.results.filter((r) => r.id !== "CA-44").flatMap((r) => r.convos || []).flatMap((c) => c.log.flatMap((e) => e.msgs));

scenario("CA-38", "Nenhuma mensagem contém {variavel} (bases de texto v1 e v2, e mensagens renderizadas)", "B-3", async () => {
  const msgs = (await sweep()).concat(allRunMessages(state), state.cur.convos.flatMap((c) => c.log.flatMap((e) => e.msgs)));
  const bad = [...new Set(msgs)].filter((m) => /\{[A-Za-z_]+\}/.test(m));
  check(bad.length === 0, `nenhuma das ${new Set(msgs).size} mensagens tem variável literal (${bad.length} com: ${bad.slice(0, 2).map((m) => (m.match(/\{[A-Za-z_]+\}/) || [""])[0] + " em «" + firstLine(m) + "»").join("; ")})`, "W-1");
  const V1 = ["nome", "empresa", "servico", "profissional", "data", "hora", "preco", "quando"];
  const V2 = V1.concat(["duracao", "data_longa", "prazo", "retorno", "proximo", "anterior", "limite"]);
  for (const [flow, allowed] of [[undefined, V1], ["2", V2]]) {
    const phone = newPhone();
    const ch = new Chat(world, S("dupla").token, phone);
    const res = await api("dupla", "POST", "/messages/claim", { payload: ch.payload("text", "oi", `CA38${flow || 1}${Date.now()}`, Date.now()) }, flow ? { "x-innochat-flow": flow } : {});
    const texts = (res.body && res.body.texts) || {};
    const leaks = Object.entries(texts).flatMap(([k, v]) => [...String(v).matchAll(/\{([A-Za-z_]+)\}/g)].map((m) => [k, m[1]])).filter(([, name]) => !allowed.includes(name));
    check(res.status === 200 && Object.keys(texts).length > 0 && leaks.length === 0, `base de textos ${flow ? "v2 (header X-InnoChat-Flow: 2)" : "v1 (sem header)"}: só variáveis conhecidas (${leaks.slice(0, 3).map(([k, n]) => `${k}:{${n}}`).join(", ") || "ok"}; ${Object.keys(texts).length} textos)`, "B-3");
    if (res.body && res.body.session) await api("dupla", "POST", `/sessions/${encodeURIComponent(res.body.session.id)}/release`, { lockToken: res.body.session.lockToken });
  }
});

scenario("CA-39", 'Nenhuma mensagem tem 2 linhas em branco seguidas, ", !" ou "Olá, !" (pushName vazio, ".", "~")', "W-1", async () => {
  for (const push of ["", ".", "~", "  ", "😀", "!!!", "-"]) {
    await sub(`pushName "${push}"`, async () => {
      const c = conv("dupla", { pushName: push });
      const r = await say(c, "oi");
      check(!/Olá, ?[!.]/.test(r.text) && !/, !/.test(r.text) && !/\n\s*\n\s*\n/.test(r.text) && /Olá/.test(r.text), `pushName "${push}": saudação limpa | ${brief(r.text)}`);
    });
  }
  const msgs = (await sweep()).concat(allRunMessages(state));
  const bad = [...new Set(msgs)].filter((m) => /\n[ \t]*\n[ \t]*\n/.test(m) || /, !/.test(m) || /Olá, ?[!.]/.test(m));
  check(bad.length === 0, `nas ${new Set(msgs).size} mensagens da rodada: sem linhas em branco duplas nem pontuação órfã (${bad.length}; ex.: «${firstLine(bad[0])}»)`);
});

scenario("CA-40", 'Serviço "Corte *VIP*_2" aparece como "Corte VIP2" sem quebrar o negrito', "W-1", async () => {
  const c = conv("especial");
  await start(c, { named: true });
  await c.pick(/Agendar/);
  const vip = opts(c).find((x) => /VIP/.test(x.label));
  check(vip && labelOf(vip).replace(/^\*|\*$/g, "") === "Corte VIP2", `a lista mostra "Corte VIP2" (${vip && vip.label})`);
  check(!/\*VIP\*|_2/.test(c.last.split("\n").filter((l) => /VIP/.test(l)).join("\n")), "sem asteriscos/sublinhado do nome na linha");
  await c.pick(/VIP/);
  await fromDay(c, { day: 1 });
  check(/\*Serviço:\* Corte VIP2\n/.test(c.last), `CONFIRM: "*Serviço:* Corte VIP2" | ${brief(c.last)}`);
});

scenario("CA-41", "Toda mensagem com opções termina com FOOTER_HINT (MENU_HINT no menu) e usa keycaps", "W-1", async () => {
  const msgs = [...new Set((await sweep()).concat(allRunMessages(state)))];
  const withOpts = msgs.filter((m) => /^\s*\d+\. \S|^[0-9]\uFE0F?\u20E3 /m.test(m) && !/^0\. /m.test(m));
  check(withOpts.length > 5, `a rodada tem mensagens com opções para conferir (${withOpts.length})`);
  const bad = withOpts.map((m) => [m, lintMessage(m).filter((e) => /keycap|FOOTER/.test(e))]).filter(([, e]) => e.length);
  check(bad.length === 0, `todas as ${withOpts.length} mensagens com opções usam keycap e terminam no rodapé (${bad.length} fora: ${bad.slice(0, 2).map(([m, e]) => `«${firstLine(m)}» ${e[0]}`).join("; ")})`);
  const menu = msgs.find((m) => T.GREETING.test(m) && /Agendar/.test(m));
  check(menu && T.MENU_HINT.test(menu.split("\n").filter((l) => l.trim()).pop()), "o menu termina com MENU_HINT");
});

scenario("CA-42", "Fuso UTC+14 (kiribati): o rótulo do dia na lista, no resumo, na confirmação e em Meus agendamentos é o mesmo dia local", "B-1", async () => {
  const tz = TZ.kiribati;
  const c = conv("kiribati");
  await start(c);
  await c.pick(/Agendar/);
  if (T.CHOOSE_SERVICE.test(c.last)) await c.pick(/Consulta/);
  if (T.CHOOSE_PROFESSIONAL.test(c.last)) await c.pick(/Dr\. Noite/);
  check(T.CHOOSE_DAY.test(c.last), `chegou na escolha do dia | ${brief(c.last)}`);
  const first = dayOpts(c.last)[0];
  const today = todayOf("kiribati");
  const iso = [today, addDaysISO(today, 1)].find((d) => first && first.label.includes(ddmm(d)));
  check(!!iso, `1º dia da lista (${first && first.label}) é o dia LOCAL (hoje=${today}) ou o seguinte`);
  if (!iso) return;
  await say(c, String(first.n));
  check(c.last.includes(ddmm(iso)), `lista de horários mostra ${ddmm(iso)} | ${brief(c.last)}`);
  await say(c, String(timeOpts(c.last)[0].n));
  if (T.ASK_NAME.test(c.last)) await say(c, "Fulano Noite");
  const ctx = await ctxOf(c);
  check(ctx.startsAt && localISO(new Date(ctx.startsAt), tz) === iso, `startsAt cai no dia local ${iso} (=${ctx.startsAt})`);
  check(T.CONFIRM_SUMMARY.test(c.last) && c.last.includes(ddmm(iso)), `resumo mostra ${ddmm(iso)} | ${brief(c.last.split("\n").slice(3, 6).join(" "))}`);
  const r = await c.pick(/Confirmar/);
  check(T.BOOKED.test(r.text) && r.text.includes(ddmm(iso)), `confirmação mostra ${ddmm(iso)} | ${brief(r.text)}`);
  const m = await c.pick(/Meus agendamentos/);
  check(m.text.includes(ddmm(iso)), `Meus agendamentos mostra ${ddmm(iso)} | ${brief(m.text)}`);
});

scenario("CA-43", "Texto do menu editado pela empresa: a numeração continua gerada e a ação do \"2\" é sempre Meus agendamentos", "B-3", async () => {
  const t = S("menuedit");
  const header = "Oi! Aqui é o *Menu Editado*. Escolha abaixo:";
  try {
    await sql(`INSERT INTO bot_texts (id, "tenantId", "key", "text", "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, $1, 'MENU_PROMPT', $2, now(), now()) ON CONFLICT ("tenantId", "key") DO UPDATE SET "text" = EXCLUDED."text"`, t.tenantId, header);
  } catch (e) {
    check(false, `não foi possível gravar MENU_PROMPT (o enum BotTextKey ainda não o tem?): ${String(e.message).split("\n").pop()}`, "C-1");
    return;
  }
  const c = conv("menuedit");
  const r = await say(c, "oi");
  check(r.text.includes("Menu Editado"), `o cabeçalho editado (MENU_PROMPT) aparece | ${brief(r.text)}`, "B-3");
  const o = opts(c);
  check(o.length === 3 && /Agendar/.test(o[0].label) && /Meus agendamentos/.test(o[1].label) && /atendente/i.test(o[2].label), `numeração gerada: 1 Agendar, 2 Meus agendamentos, 3 atendente (${o.map((x) => `${x.n}:${x.label}`).join(" | ")})`, "W-1");
  check(!/^1\. Falar com atendente|^2\. Agendar horário/m.test(r.text), "a numeração do texto legado (MAIN_MENU editado) não é usada", "W-1");
  const r2 = await say(c, "2");
  check(T.NO_APPOINTMENTS.test(r2.text), `"2" é sempre Meus agendamentos | ${brief(r2.text)}`, "W-1");
  const c2 = conv("menuedit");
  await say(c2, "oi");
  const r3 = await say(c2, "1");
  check(T.CHOOSE_SERVICE.test(r3.text) || T.CHOOSE_DAY.test(r3.text) || T.CHOOSE_PROFESSIONAL.test(r3.text), `"1" é sempre Agendar | ${brief(r3.text)}`, "W-1");
});

// ================================================================ compatibilidade e publicação
scenario("CA-44", 'Sessão gravada pela v1 em CONFIRM (ids confirmar/outro) responde certo a "1" e "2" depois da troca', "W-1", async () => {
  const v1 = makeWorld(join(here, "fixtures", "innochat-bot.v1.json"));
  const seedV1 = async (c) => {
    await c.say("oi");
    await api(c.tenantKey, "PATCH", `/contacts/${await c.contactId()}`, { name: "Cliente V1" });
    await c.pick(/Agendar/);
    await c.pick(/Corte/);
    if (/Com quem/.test(c.last)) await c.pick(/Ana/);
    const day = parseOptions(c.last)[3];
    await c.say(String(day.n));
    const time = parseOptions(c.last)[1];
    await c.say(String(time.n));
    if (!/Confirma/.test(c.last)) throw new Error(`a v1 não chegou no CONFIRM: ${brief(c.last)}`);
  };
  await sub('"1" confirma', async () => {
    const c = conv();
    c.world = v1;
    await seedV1(c);
    const row = await c.sessionRow();
    check(row.state === "CONFIRM" && !(row.context || {}).v, `sessão gravada pela v1 (state=${row.state}, ctx.v=${(row.context || {}).v})`);
    c.world = world; // a partir daqui, o workflow v2
    const r = await say(c, "1");
    check(T.BOOKED.test(r.text), `v2 lê a sessão da v1: "1" confirma | ${brief(r.text)}`);
  });
  await sub('"2" corrige', async () => {
    const c = conv();
    c.world = v1;
    await seedV1(c);
    c.world = world;
    const r = await say(c, "2");
    check(T.CONFIRM_EDIT.test(r.text), `v2 lê a sessão da v1: "2" abre a correção | ${brief(r.text)}`);
  });
});

scenario("CA-45", "Painel novo + workflow v1 (n8n/legacy/innochat-bot.v1.json): os cenários verdes da auditoria continuam verdes, sem variável literal", "W-1", async () => {
  if (process.env.BOTSIM_SKIP_CA45 === "1") { check(true, "CA-45 pulado (BOTSIM_SKIP_CA45=1)"); return; }
  const legacy = join(REPO, "n8n", "legacy", "innochat-bot.v1.json");
  if (!existsSync(legacy)) { check(false, "n8n/legacy/innochat-bot.v1.json não existe (a W-1 move o fluxo v1 para lá)"); return; }
  const baseline = JSON.parse(readFileSync(join(here, "baseline-v1.json"), "utf8"));
  const r = spawnSync(process.execPath, [join(here, "scenarios.mjs")], { env: { ...process.env, BOTSIM_WORKFLOW: legacy }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 });
  const lines = String(r.stdout || "").split(/\r?\n/).filter((l) => /^(ok|FALHA|CRASH) /.test(l));
  const verdict = Object.fromEntries(lines.map((l) => { const [v, id] = l.split(/\s+/); return [id, v]; }));
  check(lines.length === baseline.green.length + baseline.red.length, `rodou os ${lines.length} cenários da auditoria (esperado ${baseline.green.length + baseline.red.length})${r.error ? " — " + r.error.message : ""}`);
  const regressed = baseline.green.filter((id) => verdict[id] !== "ok");
  check(regressed.length === 0, `todo cenário verde da auditoria continua verde com o painel novo (regrediram: ${regressed.join(", ") || "nenhum"})`, "B-1");
  const tr = existsSync(join(here, "out", "transcripts.md")) ? readFileSync(join(here, "out", "transcripts.md"), "utf8") : "";
  // o cenário X2 da auditoria GRAVA de propósito um texto com variável inválida (BUG-12): não conta como "texto padrão com literal"
  const bot = tr.split(/\n## /).filter((sec) => !/^X2 /.test(sec)).flatMap((sec) => [...sec.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]));
  const lit = bot.filter((m) => /\{[A-Za-z_]+\}/.test(m));
  check(bot.length > 20 && lit.length === 0, `nenhuma mensagem do fluxo v1 tem variável literal (${lit.length} de ${bot.length}; ex.: ${lit[0] ? (lit[0].match(/\{[A-Za-z_]+\}/) || [""])[0] + " em «" + firstLine(lit[0]) + "»" : "-"})`, "B-3");
});

external("CA-46", "Publicar: webhookId e path iguais, credenciais ligadas, errorWorkflow, drift, sobrescrever, voltar à versão anterior", "teste unitário com n8n falso da D-1 (src/modules/platform/__tests__) + ensaio no n8n real");

scenario("CA-47", "Empresa com MAIN_MENU editado: MENU_PROMPT = cabeçalho dela depois da migration; BotText legado intacto", "C-1", async () => {
  const t = S("menuport");
  const run = async () => { const err = await runPortMigration(); if (err) throw new Error(err); };
  try {
    await run();
    const rows = await sql(`SELECT "text" FROM bot_texts WHERE "tenantId" = $1 AND "key" = 'MENU_PROMPT'`, t.tenantId);
    const expected = "Oi {nome}! Aqui é a *{empresa}*.\nEscolha uma opção:";
    check(rows.length === 1 && rows[0].text === expected, `MENU_PROMPT = cabeçalho da empresa (${rows[0] ? J(rows[0].text) : "não portado"})`);
    const legacy = await sql(`SELECT "text" FROM bot_texts WHERE "tenantId" = $1 AND "key" = 'MAIN_MENU'`, t.tenantId);
    check(legacy.length === 1 && legacy[0].text === t.legacyMainMenu, "o BotText legado MAIN_MENU continua intacto");
    await run();
    const again = await sql(`SELECT count(*)::int AS n FROM bot_texts WHERE "tenantId" = $1 AND "key" = 'MENU_PROMPT'`, t.tenantId);
    check(again[0].n === 1, "rodar a migration de novo é idempotente (continua 1 linha)");
  } catch (e) {
    check(false, `a migration de porte falhou: ${String(e.message).split("\n").slice(-2).join(" ").slice(0, 250)}`);
  }
});

