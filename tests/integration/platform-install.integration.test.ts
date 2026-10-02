/**
 * Instalação única do primeiro admin da plataforma (docs/contratos.md, `src/modules/platform/
 * install.ts`) contra Postgres real: gera código, consome uma única vez, bloqueia depois de
 * existir um admin. Limpa `PlatformInstallCode`/o `User` de teste no fim — nunca toca no admin
 * de dev de verdade (não filtra por `isPlatformAdmin: true` em massa, só pelos ids criados
 * aqui).
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { bootstrapInstallCodeIfNeeded, hasPlatformAdmin, installPlatformAdmin } from "@/modules/platform/install";

const prisma = getPrisma();
const createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
  await prisma.platformInstallCode.deleteMany({});
});

function extractLoggedCode(spy: ReturnType<typeof captureConsoleLog>): string {
  const line = spy.lines.find((l) => l.includes("InnoChat: código de instalação ="));
  expect(line).toBeDefined();
  const match = line!.match(/= (\S+) \(/);
  expect(match).not.toBeNull();
  return match![1]!;
}

function captureConsoleLog() {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

describe("bootstrapInstallCodeIfNeeded + installPlatformAdmin — instalação única", () => {
  it("imprime o código no boot quando não há admin, e ele instala o primeiro admin", async () => {
    // Pré-condição: nenhum admin no banco de teste (garantida pelo cleanup de outras suítes —
    // se algum teste anterior criou um admin de teste e não limpou, este teste falha alto e
    // visível, o que é o comportamento certo a ter aqui).
    const hadAdminBefore = await hasPlatformAdmin();

    const spy = captureConsoleLog();
    try {
      await bootstrapInstallCodeIfNeeded();
    } finally {
      spy.restore();
    }

    if (hadAdminBefore) {
      // Ambiente de teste já tem um admin (ex.: seed rodou antes) — bootstrap não deve ter feito nada.
      expect(spy.lines.some((l) => l.includes("código de instalação"))).toBe(false);
      return;
    }

    const code = extractLoggedCode(spy);

    const email = `it-install-${Date.now()}-${randomUUID().slice(0, 6)}@example.com`;
    const result = await installPlatformAdmin({ code, name: "Admin de Teste", email, password: "senha-forte-123" });
    createdUserIds.push(result.userId);

    const user = await prisma.user.findUnique({ where: { id: result.userId } });
    expect(user?.isPlatformAdmin).toBe(true);
    expect(user?.name).toBe("Admin de Teste"); // nome (opcional) agora é persistido
    expect(user?.emailVerifiedAt).not.toBeNull();

    expect(await hasPlatformAdmin()).toBe(true);
  });

  it("duas instalações concorrentes com o MESMO código: exatamente 1 sucesso, a outra falha (nunca dois admins)", async () => {
    if (await hasPlatformAdmin()) return; // ambiente já instalado — nada a provar aqui

    const spy = captureConsoleLog();
    await bootstrapInstallCodeIfNeeded();
    spy.restore();
    const code = extractLoggedCode(spy);

    const email1 = `it-install-race-a-${Date.now()}-${randomUUID().slice(0, 6)}@example.com`;
    const email2 = `it-install-race-b-${Date.now()}-${randomUUID().slice(0, 6)}@example.com`;

    const results = await Promise.allSettled([
      installPlatformAdmin({ code, name: "A", email: email1, password: "senha-forte-123" }),
      installPlatformAdmin({ code, name: "B", email: email2, password: "senha-forte-123" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    createdUserIds.push((fulfilled[0] as PromiseFulfilledResult<{ userId: string }>).value.userId);

    const admins = await prisma.user.count({ where: { isPlatformAdmin: true } });
    expect(admins).toBe(1);
  });

  it("código expirado é rejeitado", async () => {
    if (await hasPlatformAdmin()) return;

    const spy = captureConsoleLog();
    await bootstrapInstallCodeIfNeeded();
    spy.restore();
    const code = extractLoggedCode(spy);

    // Simula expiração sem esperar 24h de verdade.
    await prisma.platformInstallCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const email = `it-install-expired-${Date.now()}-${randomUUID().slice(0, 6)}@example.com`;
    await expect(installPlatformAdmin({ code, name: "Admin", email, password: "senha-forte-123" })).rejects.toMatchObject({
      code: "INSTALL_CODE_INVALID",
    });
  });

  it("bootstrapInstallCodeIfNeeded não faz nada (nem loga) quando já existe um admin", async () => {
    const email = `it-install-existing-${Date.now()}-${randomUUID().slice(0, 6)}@example.com`;
    const admin = await prisma.user.create({ data: { email, passwordHash: "x", isPlatformAdmin: true, totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() } });
    createdUserIds.push(admin.id);

    const spy = captureConsoleLog();
    try {
      await bootstrapInstallCodeIfNeeded();
    } finally {
      spy.restore();
    }

    expect(spy.lines.some((l) => l.includes("código de instalação"))).toBe(false);
    expect(await prisma.platformInstallCode.count({})).toBe(0);
  });
});
