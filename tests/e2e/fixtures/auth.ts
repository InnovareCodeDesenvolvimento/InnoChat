import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { submitTwoFactorCode } from "./two-factor";

/** Faz login pela UI de verdade (nunca injeta cookie/sessão) — é a própria tela que testamos. */
export async function login(page: Page, email: string, password: string, totpSecret?: string) {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  // Conta com verificação em 2 etapas (o dono de seed é admin): o segundo passo pede o código.
  if (totpSecret) await submitTwoFactorCode(page, totpSecret);
}

export async function loginAndWaitForPanel(page: Page, email: string, password: string, tenantSlug: string, totpSecret?: string) {
  await login(page, email, password, totpSecret);
  await expect(page).toHaveURL(new RegExp(`/${tenantSlug}(/|$)`), { timeout: 10_000 });
}
