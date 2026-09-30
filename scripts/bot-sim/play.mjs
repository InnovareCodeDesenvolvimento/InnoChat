// Conversa manual: node scripts/bot-sim/play.mjs <tenant> <telefone> <msg1> <msg2> ...
// (prefixos especiais: "@audio", "@image", "@empty", "@sticker" enviam mídia)
// Requer o painel em BOTSIM_PANEL (padrão http://localhost:3900) e o seed rodado.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./engine.mjs";
import { World, Chat } from "./chat.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, ".seed.json"), "utf8"));
const [, , tenantKey, phone, ...msgs] = process.argv;
const engine = new Engine({ workflowPath: process.env.BOTSIM_WORKFLOW || join(here, "../../n8n/innochat-bot.json"), painelUrl: `${process.env.BOTSIM_PANEL || "http://localhost:3900"}/api/internal/v1`, secret: seed.secret });
const world = new World(engine);
const chat = new Chat(world, seed.tenants[tenantKey].token, phone);
for (const m of msgs) {
  if (m.startsWith("@")) await chat.say("", { kind: m.slice(1) });
  else await chat.say(m);
}
console.log(chat.transcript(`${tenantKey} ${phone}`));
