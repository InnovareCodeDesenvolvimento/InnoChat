import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { prisma } from "./db";
import { SEED_OWNER_EMAIL } from "./test-data";
import { encryptSecret } from "../../../src/lib/crypto";
import { totpCode } from "../../../src/modules/two-factor/totp";

/**
 * O dono de seed (`dev@innochat.local`) também é admin da plataforma, e o admin é OBRIGADO a ter a
 * verificação em 2 etapas (senão o /admin só mostra a tela de ativação). Por isso o `global-setup`
 * liga a 2FA dele com este segredo FIXO de teste (só existe no banco de dev durante a suíte; o
 * `global-teardown` desliga) e os logins pela UI geram o código na hora, como o app do celular faria.
 */
export const SEED_OWNER_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

/** O runner do Playwright não lê o `.env`; o segredo do app (que cifra o TOTP) vem de lá. Nunca é impresso. */
export function ensureAuthSecret() {
  if (process.env.AUTH_SECRET) return;
  const content = fs.readFileSync(path.join(process.cwd(), ".env"), "utf-8");
  const match = content.match(/^AUTH_SECRET=(.+)$/m);
  if (!match) throw new Error("AUTH_SECRET não encontrado no .env: não dá para cifrar o segredo TOTP de teste.");
  process.env.AUTH_SECRET = match[1]!.trim().replace(/^["']|["']$/g, "");
}

export async function enableTwoFactorForSeedOwner() {
  ensureAuthSecret();
  await prisma.user.update({
    where: { email: SEED_OWNER_EMAIL },
    data: { totpSecretEnc: encryptSecret(SEED_OWNER_TOTP_SECRET), totpEnabledAt: new Date(), totpLastUsedStep: null },
  });
}

export async function disableTwoFactorForSeedOwner() {
  await prisma.user.updateMany({
    where: { email: SEED_OWNER_EMAIL },
    data: { totpSecretEnc: null, totpEnabledAt: null, totpLastUsedStep: null },
  });
}

/**
 * Anti-replay: o mesmo passo de 30 s não vale duas vezes. Dois logins do mesmo usuário na mesma
 * janela (global-setup + auth.spec) colidiriam, então quem vai logar de novo zera o marcador antes.
 */
export async function resetSeedOwnerReplayGuard() {
  await prisma.user.updateMany({ where: { email: SEED_OWNER_EMAIL }, data: { totpLastUsedStep: null } });
}

/** Segundo passo da tela de login: digita o código gerado do segredo e envia. */
export async function submitTwoFactorCode(page: Page, secretOrCode: string, isCode = false) {
  await page.getByLabel("Código de verificação").fill(isCode ? secretOrCode : totpCode(secretOrCode));
  await page.getByRole("button", { name: "Verificar e entrar" }).click();
}
