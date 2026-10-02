import { test, expect, type Page } from "@playwright/test";
import { prisma } from "./fixtures/db";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";

/**
 * Admin → Backup: a tela renderiza e o servidor RECUSA ligar o automático sem destino completo (uma cópia
 * que fica no mesmo servidor do banco morre junto com ele). Não configura S3/Drive reais e devolve a
 * configuração e o histórico ao estado em que estavam.
 */
test.use({ storageState: OWNER_STORAGE_STATE });

function main(page: Page) {
  return page.getByRole("main");
}

let originalConfig: Record<string, unknown> | null = null;
let runIdsBefore: string[] = [];

test.beforeAll(async () => {
  const row = await prisma.backupConfig.findFirst();
  originalConfig = row ? { ...row } : null;
  runIdsBefore = (await prisma.backupRun.findMany({ select: { id: true } })).map((r) => r.id);
});

test.afterAll(async () => {
  await prisma.backupRun.deleteMany({ where: { id: { notIn: runIdsBefore } } });
  if (originalConfig) {
    const { id, ...rest } = originalConfig as { id: number } & Record<string, unknown>;
    await prisma.backupConfig.update({ where: { id }, data: rest as never });
  } else {
    await prisma.backupConfig.deleteMany({});
  }
});

test.describe.serial("Admin → Backup", () => {
  test("renderiza os cartões, o aviso de destino incompleto e o histórico sem quebrar", async ({ page }) => {
    await page.goto("/admin/backup");
    await expect(main(page).getByRole("heading", { name: "Backup do banco", level: 1 })).toBeVisible();
    await expect(page.getByText("Última cópia enviada")).toBeVisible();
    await expect(page.getByText("Próxima cópia automática")).toBeVisible();
    await expect(main(page).getByRole("heading", { name: "Agendamento" })).toBeVisible();
    await expect(main(page).getByRole("heading", { name: "Destino" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Fazer backup agora" })).toBeEnabled();
    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `overflow a ${w}px`).toBeLessThanOrEqual(0);
    }
  });

  test("ligar o automático sem destino é recusado e nada é gravado como ligado", async ({ page }) => {
    await prisma.backupConfig.updateMany({ data: { enabled: false, destination: null } });
    await page.goto("/admin/backup");
    await page.getByRole("switch", { name: "Backup automático" }).click();
    await expect(page.getByRole("switch", { name: "Backup automático" })).toBeChecked();
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText(/Escolha o destino e complete os dados antes de ligar o backup automático/)).toBeVisible();
    expect((await prisma.backupConfig.findFirst())?.enabled ?? false).toBe(false);

    // Recarrega: continua desligado e o selo diz isso.
    await page.reload();
    await expect(page.getByRole("switch", { name: "Backup automático" })).not.toBeChecked();
    await expect(page.getByText("Desligado", { exact: true })).toBeVisible();
  });

  test("destino S3 pela metade (só o bucket) também não deixa ligar", async ({ page }) => {
    await page.goto("/admin/backup");
    await page.getByLabel("Guardar em").selectOption("S3");
    await page.getByLabel("Bucket", { exact: true }).fill("bucket-e2e-incompleto");
    await page.getByRole("switch", { name: "Backup automático" }).click();
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText(/Escolha o destino e complete os dados/)).toBeVisible();
    expect((await prisma.backupConfig.findFirst())?.enabled ?? false).toBe(false);
  });

  test("hora fora de 0 a 23 é barrada no formulário e nada muda no banco", async ({ page }) => {
    const before = (await prisma.backupConfig.findFirst())?.hourLocal;
    await page.goto("/admin/backup");
    const hour = page.getByLabel("Hora", { exact: true });
    await hour.fill("24");
    await page.getByRole("button", { name: "Salvar" }).click();
    expect(await hour.evaluate((el) => (el as HTMLInputElement).validity.rangeOverflow)).toBe(true);
    await page.waitForTimeout(500);
    expect((await prisma.backupConfig.findFirst())?.hourLocal).toBe(before);
  });

  test("Fazer backup agora sem destino não vale como backup e a tela avisa, sem quebrar", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/admin/backup");
    await expect(page.getByText(/Enquanto o destino não estiver completo/)).toBeVisible();
    await page.getByRole("button", { name: "Fazer backup agora" }).click();
    // Resultado possível: teste conferido e descartado (aviso) ou falha clara se o pg_dump não existe aqui.
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 100_000 });
    await expect(main(page).getByRole("heading", { name: "Backup do banco", level: 1 })).toBeVisible();
  });
});
