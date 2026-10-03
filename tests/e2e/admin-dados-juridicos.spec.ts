import { test, expect } from "@playwright/test";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";

/**
 * Admin → Configurações → "Dados da empresa (Termos e Privacidade)" — salva os marcadores
 * jurídicos e confirma que `/termos` (ISR, `revalidate = 60` em `src/app/(public)/termos/page.tsx`)
 * reflete o CNPJ novo. **Limpa os dados no final** (volta os campos a vazio) — são dados reais da
 * empresa dona do produto, não fixture de teste.
 */
test.use({ storageState: OWNER_STORAGE_STATE });

const TEST_CNPJ = "11.222.333/0001-81"; // dígitos verificadores válidos (mesmo algoritmo de document.ts)

test.describe("Admin → Configurações → Dados jurídicos", () => {
  test.afterAll(async () => {
    // Restaura tudo para vazio — `updatePlatformLegalInfo` aceita string vazia como "limpar".
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: { companyLegalName: null, companyCnpj: null, companyAddress: null },
    });
  });

  test("salvar CNPJ em Configurações reflete em /termos", async ({ page }) => {
    await page.goto("/admin/configuracoes/geral");
    const legalCard = page.getByRole("heading", { name: "Dados da empresa (Termos e Privacidade)" }).locator("xpath=ancestor::div[contains(@class,'rounded-hero')][1]");
    await legalCard.getByLabel("CNPJ", { exact: true }).fill(TEST_CNPJ);
    await legalCard.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByText("Dados da empresa salvos.").first()).toBeVisible();

    await page.goto("/termos");
    // O CNPJ aparece formatado (com pontuação) — `fillLegalSections`/`fillLegalIntro` usam o
    // valor salvo (com dígitos apenas) formatado para exibição; procura pelos dígitos, que sempre
    // aparecem independente da máscara escolhida.
    await expect(page.getByText(/11\.222\.333\/0001-81|11222333000181/).first()).toBeVisible();
  });
});
