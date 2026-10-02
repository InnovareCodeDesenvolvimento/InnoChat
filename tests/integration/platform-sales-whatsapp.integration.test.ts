/**
 * WhatsApp comercial da plataforma (botão "Tirar dúvidas" da landing) contra Postgres real:
 * salvar/ler normalizando para E.164, limpar, telefone inválido, leitura pública que nunca
 * lança, e guarda de admin (sem sessão: UNAUTHENTICATED; usuário comum: FORBIDDEN).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

const sessionState: { userId: string | null } = { userId: null };
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => (sessionState.userId ? { user: { id: sessionState.userId } } : null)) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const actions = await import("@/modules/platform/actions");
const { getPublicSalesWhatsapp } = await import("@/modules/platform/sales-contact");

const prisma = getPrisma();
const userIds: string[] = [];
let saved: { salesWhatsappE164: string | null } | null = null;

async function makeUser(isPlatformAdmin: boolean) {
  const u = await prisma.user.create({ data: { email: `it-sw-${randomUUID().slice(0, 8)}@example.test`, passwordHash: "x", isPlatformAdmin, totpSecretEnc: isPlatformAdmin ? "enc:v1:x" : null, totpEnabledAt: isPlatformAdmin ? new Date() : null } });
  userIds.push(u.id);
  return u;
}

beforeAll(async () => {
  saved = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { salesWhatsappE164: true } });
});

afterAll(async () => {
  await prisma.platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, salesWhatsappE164: saved?.salesWhatsappE164 ?? null },
    update: { salesWhatsappE164: saved?.salesWhatsappE164 ?? null, updatedByUserId: null },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("WhatsApp comercial", () => {
  it("admin salva com máscara, lê formatado e normalizado; a leitura pública devolve o mesmo", async () => {
    const admin = await makeUser(true);
    sessionState.userId = admin.id;

    const result = await actions.updatePlatformSalesWhatsappAction({ phone: "+55 (84) 3113-2584" });
    expect(result).toEqual({ ok: true, data: { e164: "558431132584", display: "(84) 3113-2584" } });

    const row = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { salesWhatsappE164: true, updatedByUserId: true } });
    expect(row).toEqual({ salesWhatsappE164: "558431132584", updatedByUserId: admin.id });

    expect(await actions.getPlatformSalesWhatsappAction()).toEqual({ ok: true, data: { e164: "558431132584", display: "(84) 3113-2584" } });
    expect(await getPublicSalesWhatsapp()).toEqual({ e164: "558431132584", display: "(84) 3113-2584" });
  });

  it("telefone inválido: INVALID_PHONE e o valor anterior fica intacto", async () => {
    sessionState.userId = (await makeUser(true)).id;
    await actions.updatePlatformSalesWhatsappAction({ phone: "(84) 3113-2584" });
    expect(await actions.updatePlatformSalesWhatsappAction({ phone: "123" })).toMatchObject({ ok: false, error: { code: "INVALID_PHONE" } });
    expect(await getPublicSalesWhatsapp()).toMatchObject({ e164: "558431132584" });
  });

  it("vazio limpa: leitura pública devolve null (botão some)", async () => {
    sessionState.userId = (await makeUser(true)).id;
    expect(await actions.updatePlatformSalesWhatsappAction({ phone: "  " })).toEqual({ ok: true, data: null });
    expect(await getPublicSalesWhatsapp()).toBeNull();
  });

  it("sem sessão: UNAUTHENTICATED; usuário comum: FORBIDDEN, e nada é gravado", async () => {
    const admin = await makeUser(true);
    sessionState.userId = admin.id;
    await actions.updatePlatformSalesWhatsappAction({ phone: "(84) 3113-2584" });

    const normal = await makeUser(false);
    for (const userId of [null, normal.id]) {
      sessionState.userId = userId;
      const expected = userId ? "FORBIDDEN" : "UNAUTHENTICATED";
      expect(await actions.updatePlatformSalesWhatsappAction({ phone: "(11) 98765-4321" })).toMatchObject({ ok: false, error: { code: expected } });
      expect(await actions.getPlatformSalesWhatsappAction()).toMatchObject({ ok: false, error: { code: expected } });
    }
    expect(await getPublicSalesWhatsapp()).toMatchObject({ e164: "558431132584" });
  });
});
