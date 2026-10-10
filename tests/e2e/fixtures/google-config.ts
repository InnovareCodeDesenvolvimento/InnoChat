import { readFileSync } from "node:fs";
import { prisma } from "./db";
import { encryptSecret } from "../../../src/lib/crypto";

/**
 * Liga/desliga o login com Google direto no banco (credenciais FALSAS: nada sai para o Google), só para
 * as telas mostrarem o botão. O servidor guarda a configuração por 30 s: quem liga espera o botão aparecer.
 */
type GoogleRow = { googleAuthEnabled: boolean; googleClientId: string | null; googleClientSecretEnc: string | null };

function ensureAuthSecret(): void {
  if (process.env.AUTH_SECRET) return;
  const m = readFileSync(".env", "utf8").match(/^AUTH_SECRET\s*=\s*"?([^"\r\n]+)"?/m);
  if (!m) throw new Error("AUTH_SECRET não encontrado");
  process.env.AUTH_SECRET = m[1]!;
}

export async function readGoogleRow(): Promise<GoogleRow> {
  return prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 }, select: { googleAuthEnabled: true, googleClientId: true, googleClientSecretEnc: true } });
}

export async function restoreGoogleRow(row: GoogleRow): Promise<void> {
  await prisma.platformSettings.update({ where: { id: 1 }, data: row });
}

export async function enableFakeGoogle(): Promise<void> {
  ensureAuthSecret();
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: {
      googleAuthEnabled: true,
      googleClientId: ["1234567890-abcdefghijk", "apps", "googleusercontent", "com"].join("."),
      googleClientSecretEnc: encryptSecret(["GOCSPX", "e2e-falso"].join("-")),
    },
  });
}
