import { test, expect } from "@playwright/test";
import { login } from "./fixtures/auth";
import { SEED_TENANT_SLUG, SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD, loadRunFixtures } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { SEED_OWNER_TOTP_SECRET, resetSeedOwnerReplayGuard } from "./fixtures/two-factor";

/**
 * Único spec (com `csp.spec.ts` "login: sem violação de CSP") que ainda loga de VERDADE pela UI
 * com `dev@innochat.local` — é a própria tela de login sob teste. Mantido a 1 login real por
 * rodada com esse e-mail (só o teste "credenciais corretas" abaixo): "senha errada" usa o STAFF
 * (e-mail distinto) para não somar no mesmo teto de 8/15min (ver `login_rate_limit_e2e` na
 * memória), e os testes que só precisam estar autenticados (tenant alheio, sair) usam
 * `storageState` em vez de logar de novo.
 */
test.describe("Autenticação e proteção de rota (docs/contratos.md Fase 1)", () => {
  test("login com credenciais corretas leva ao painel da empresa", async ({ page }) => {
    // O dono de seed é admin: tem 2FA ligada pelo global-setup. O marcador anti-replay é zerado porque
    // o global-setup já usou o código desta janela de 30 s.
    await resetSeedOwnerReplayGuard();
    await login(page, SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD, SEED_OWNER_TOTP_SECRET);
    // A página Início (docs/plano-implementacao.md Etapa B) passou a ser o destino pós-login —
    // `pos-login/page.tsx` redireciona para `/inicio`, não mais direto para `/agenda`.
    await expect(page).toHaveURL(new RegExp(`/${SEED_TENANT_SLUG}/inicio`));
  });

  test("senha errada mostra mensagem genérica (sem dizer se o e-mail existe)", async ({ page }) => {
    const { staffEmail } = loadRunFixtures();
    await login(page, staffEmail, "senha-totalmente-errada");
    await expect(page).toHaveURL(/\/login$/);
    const alert = page.getByRole("alert").filter({ hasText: "E-mail ou senha inválidos." });
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText("E-mail ou senha inválidos.");
  });

  test("e-mail inexistente mostra a MESMA mensagem genérica (sem enumeration)", async ({ page }) => {
    await login(page, "ninguem-com-este-email@e2e.innochat.local", "qualquer-coisa-123");
    await expect(page).toHaveURL(/\/login$/);
    const alert = page.getByRole("alert").filter({ hasText: "E-mail ou senha inválidos." });
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText("E-mail ou senha inválidos.");
  });

  test("rota protegida sem sessão redireciona para /login", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/agenda`);
    await expect(page).toHaveURL(/\/login/);
  });

  test.describe(() => {
    // Só precisa estar autenticado (não testa a tela de login em si) — storageState em vez de
    // logar de novo pela UI.
    test.use({ storageState: OWNER_STORAGE_STATE });

    test("tenant alheio (slug que não existe, ou que o usuário não é membro) devolve 404, nunca 403", async ({ page }) => {
      await page.goto(`/${SEED_TENANT_SLUG}/agenda`);

      // Empresa que existe, mas o usuário logado (OWNER só de studio-demo) não é membro dela.
      const { tenantBSlug } = loadRunFixtures();
      const response = await page.goto(`/${tenantBSlug}/agenda`);
      expect(response?.status()).toBe(404);

      // Slug que nem existe.
      const response2 = await page.goto(`/empresa-que-nunca-existiu-e2e/agenda`);
      expect(response2?.status()).toBe(404);
    });

    test("botão Sair encerra a sessão e volta para /login", async ({ page }) => {
      await page.goto(`/${SEED_TENANT_SLUG}/agenda`);

      await page.getByRole("button", { name: "Sair" }).click();
      await expect(page).toHaveURL(/\/login/);

      // Sessão de fato encerrada: rota protegida volta a mandar para /login.
      await page.goto(`/${SEED_TENANT_SLUG}/agenda`);
      await expect(page).toHaveURL(/\/login/);
    });
  });
});
