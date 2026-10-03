import { test, expect, type Page } from "@playwright/test";
import { prisma } from "./fixtures/db";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { SEED_OWNER_PASSWORD } from "./fixtures/test-data";

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

  test("Chave do backup: aparece inteira uma única vez, com copiar e baixar, e depois só a impressão digital", async ({ page }) => {
    await prisma.backupConfig.updateMany({ data: { encryptionKeyEnc: null, encryptionKeyFingerprint: null, encryptionKeyCreatedAt: null, encryptionKeyShownAt: null } });
    await page.goto("/admin/backup");
    await expect(main(page).getByRole("heading", { name: "Chave do backup" })).toBeVisible();
    await expect(page.getByText(/Ainda não há chave/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Conferir backup", exact: true })).toBeDisabled();

    await page.getByRole("button", { name: "Gerar chave", exact: true }).click();
    const key = page.getByTestId("backup-key");
    await expect(key).toBeVisible();
    await expect(key).toHaveText(/^([0-9a-f]{8}-){7}[0-9a-f]{8}$/);
    await expect(page.getByText("Guarde fora do servidor. Sem ela os backups não abrem.")).toBeVisible();
    const shownKey = ((await key.textContent()) ?? "").trim();

    // Baixar o .txt: tem a chave e as instruções.
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Baixar arquivo .txt" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^chave-backup-innochat-[0-9a-f]{8}\.txt$/);
    const text = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
    expect(text).toContain(`CHAVE: ${shownKey}`);
    expect(text).toContain("decrypt-backup.mjs");

    // No banco: só cifrada, e a impressão digital bate com a que a tela mostrou.
    const row = await prisma.backupConfig.findFirstOrThrow();
    expect(row.encryptionKeyEnc).toMatch(/^enc:v1:/);
    expect(row.encryptionKeyEnc).not.toContain(shownKey.replace(/-/g, ""));
    expect(row.encryptionKeyShownAt).not.toBeNull();
    await expect(page.getByText(`Chave (impressão digital ${row.encryptionKeyFingerprint})`)).toBeVisible();

    // Cabe nas duas larguras (a chave tem 71 caracteres seguidos: quebra, não estoura).
    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `overflow a ${w}px`).toBeLessThanOrEqual(0);
      const box = await key.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(w);
    }

    // "Já guardei, esconder" some com ela; recarregar também. Sobra só a impressão digital.
    await page.getByRole("button", { name: "Já guardei, esconder" }).click();
    await expect(key).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("backup-key")).toHaveCount(0);
    await expect(page.getByTestId("backup-key-fingerprint")).toHaveText(row.encryptionKeyFingerprint!);
    await expect(page.locator("body")).not.toContainText(shownKey);
  });

  test("Gerar nova chave só vai adiante com a frase de confirmação digitada", async ({ page }) => {
    const before = (await prisma.backupConfig.findFirstOrThrow()).encryptionKeyFingerprint;
    expect(before).toMatch(/^[0-9a-f]{8}$/);
    await page.goto("/admin/backup");
    await page.getByRole("button", { name: "Gerar nova chave" }).click();
    await expect(page.getByText(/continuam precisando da chave antiga/)).toBeVisible();
    const confirm = page.getByRole("button", { name: "Trocar a chave" });
    await expect(confirm).toBeDisabled();
    await page.getByLabel(/Para confirmar, digite GERAR NOVA CHAVE/).fill("gerar nova");
    await expect(confirm).toBeDisabled();
    expect((await prisma.backupConfig.findFirstOrThrow()).encryptionKeyFingerprint).toBe(before);
    await page.getByLabel(/Para confirmar, digite GERAR NOVA CHAVE/).fill("GERAR NOVA CHAVE");
    // Desde o 5f0e348 trocar a chave também pede a senha (ou o código de 2 etapas): só a frase não habilita o botão.
    await expect(confirm).toBeDisabled();
    await page.getByLabel("Sua senha").fill(SEED_OWNER_PASSWORD);
    await confirm.click();
    await expect(page.getByTestId("backup-key")).toBeVisible();
    const after = (await prisma.backupConfig.findFirstOrThrow()).encryptionKeyFingerprint;
    expect(after).not.toBe(before);
  });
});
