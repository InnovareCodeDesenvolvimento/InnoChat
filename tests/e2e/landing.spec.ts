import { test, expect } from "@playwright/test";
import { prisma } from "./fixtures/db";

/**
 * Landing pública (`/`): carrega, CTAs, planos vindos do banco, FAQ por teclado e sem overflow em
 * 390px. Sem sessão (contexto limpo).
 */
test.describe("Landing pública", () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("carrega com h1, microcopy do teste e celular da demo", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("agenda sozinho");
    await expect(page.getByText("sem cartão de crédito").first()).toBeVisible();
    await expect(page.getByTestId("phone-demo")).toBeAttached();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://innochat.innovarecode.com.br");
    const ld = await page.locator('script[type="application/ld+json"]').textContent();
    expect(ld).toContain("SoftwareApplication");
  });

  test("CTAs levam a /cadastro e /login", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Começar teste grátis" }).first().click();
    await expect(page).toHaveURL(/\/cadastro$/);

    await page.goto("/");
    await page.getByRole("link", { name: "Já tenho conta" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("planos renderizam a partir do banco", async ({ page }) => {
    const active = await prisma.plan.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } });
    await page.goto("/");
    const section = page.locator("#planos");
    await expect(section).toBeVisible();
    if (active.length === 0) {
      await expect(page.getByTestId("planos-sem-preco")).toBeVisible();
      return;
    }
    // O cache da vitrine é de 60 s: aceita que o banco tenha mudado há pouco, mas exige pelo menos
    // um plano ativo atual renderizado com o preço certo.
    const cards = page.getByTestId("plano-card");
    await expect(cards.first()).toBeVisible();
    const first = active.find((p) => p.priceCents > 0) ?? active[0];
    const price = (first.priceCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/ /g, " ");
    const text = (await section.innerText()).replace(/ /g, " ");
    expect(text).toContain(first.name);
    expect(text).toContain(price);
  });

  test("FAQ abre e fecha pelo teclado", async ({ page }) => {
    await page.goto("/");
    const summary = page.locator("#faq summary").first();
    await summary.scrollIntoViewIfNeeded();
    await summary.focus();
    const details = page.locator("#faq details").first();
    await expect(details).not.toHaveAttribute("open", "");
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await page.keyboard.press("Space");
    await expect(details).not.toHaveAttribute("open", "");
  });

  test("390px: sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const r = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    expect(r.sw).toBeLessThanOrEqual(r.cw);
  });

  test("com movimento reduzido a conversa aparece completa, com o prazo padrão de 2 horas", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const demo = page.getByTestId("phone-demo");
    await expect(demo.getByText("Agendamento confirmado!")).toBeVisible();
    await expect(demo.getByText(/até 2 horas antes/)).toBeVisible();
    await expect(demo.getByText("Studio Bella").first()).toBeVisible();
  });

  test("a demo anima: 'digitando...' no cabeçalho e o chat rola até o fim", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.evaluate(() => document.querySelector('[data-testid="phone-demo"]')?.scrollIntoView({ block: "center" }));
    await expect(page.getByTestId("phone-demo-status")).toHaveText("digitando...", { timeout: 8_000 });
    await expect(page.getByTestId("phone-demo-status")).toHaveText("online", { timeout: 8_000 });
    await expect
      .poll(() => page.getByTestId("phone-demo").getByRole("region").evaluate((el) => el.scrollTop), { timeout: 15_000 })
      .toBeGreaterThan(0);
  });

  test("o Inno ao lado do celular reage à demo: balão 'digitando' e depois 'Agendado!', sem cobrir a conversa", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.evaluate(() => document.querySelector('[data-testid="phone-demo"]')?.scrollIntoView({ block: "center" }));
    const inno = page.getByTestId("inno");
    await expect(inno).toBeVisible();
    await expect(inno).toHaveAttribute("aria-hidden", "true");
    await expect(inno.getByRole("img")).toHaveCount(0);
    await expect(inno).toHaveAttribute("data-face", "typing", { timeout: 8_000 });
    await expect(page.getByTestId("inno-bubble")).toHaveAttribute("data-face", "typing");
    await expect(inno).toHaveAttribute("data-face", "done", { timeout: 60_000 });
    await expect(page.getByTestId("inno-bubble")).toContainText("Agendado!");
    // O Inno fica ao lado do aparelho, nunca por cima da tela do celular.
    const gap = await page.evaluate(() => {
      const phone = document.querySelector('[data-testid="phone-demo"] [role="region"]')!.getBoundingClientRect();
      const img = document.querySelector('[data-testid="inno"] img')!.getBoundingClientRect();
      return img.left - phone.right;
    });
    expect(gap).toBeGreaterThanOrEqual(0);
  });

  test("'Você conhece esse dia': o interruptor alterna por teclado e muda o conteúdo", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const section = page.locator('section[aria-labelledby="dor-titulo"]');
    await section.evaluate((el) => el.scrollIntoView());
    const sw = page.getByRole("switch", { name: "Mostrar o dia com o InnoChat" });
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect(section.getByText(/ninguém responde/)).toBeVisible();
    await expect(section.getByText(/o bot responde na hora/)).toBeHidden();
    const box = await sw.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await sw.focus();
    await page.keyboard.press("Space");
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect(section.getByText(/o bot responde na hora/)).toBeVisible({ timeout: 4_000 });
    await expect(section.getByText(/ninguém responde/)).toBeHidden();
    await expect(section.getByRole("status")).toContainText("com o InnoChat");
    await page.keyboard.press("Enter");
    await expect(sw).toHaveAttribute("aria-checked", "false");
  });

  test("'Você conhece esse dia': o nicho troca por teclado (setas) e muda personagem e serviço", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const section = page.locator('section[aria-labelledby="dor-titulo"]');
    await section.evaluate((el) => el.scrollIntoView());
    const group = section.getByRole("radiogroup", { name: "Seu negócio:" });
    const first = group.getByRole("radio").first();
    await expect(first).toHaveAttribute("aria-checked", "true");
    // O estado inicial é neutro: nada de salão/cadeira no texto.
    await expect(section.getByText(/Abro as portas/).first()).toBeVisible();
    await expect(section.getByText(/cadeira/)).toHaveCount(0);
    await first.focus();
    await page.keyboard.press("ArrowRight");
    await expect(group.getByRole("radio", { name: "Salão" })).toHaveAttribute("aria-checked", "true");
    await expect(section.getByText(/Abro o salão/).first()).toBeVisible();
    await page.keyboard.press("End");
    await expect(group.getByRole("radio", { name: "Pet shop" })).toHaveAttribute("aria-checked", "true");
    await expect(section.getByText(/Abro a loja/).first()).toBeVisible();
    await expect(section.getByText(/Abro o salão/)).toHaveCount(0);
  });

  test("'Você conhece esse dia': com movimento reduzido o interruptor funciona sem animação", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const section = page.locator('section[aria-labelledby="dor-titulo"]');
    await section.evaluate((el) => el.scrollIntoView());
    // Estado final estático: a cena já aparece sem esperar rolagem.
    await expect(section.getByText(/Abro as portas/).first()).toBeVisible();
    const sw = page.getByRole("switch");
    await sw.click();
    await expect(section.getByText(/o bot responde na hora/)).toBeVisible({ timeout: 1_000 });
    const t = await section.locator(".ds-pane.ds-before").first().evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(t).toBe("0s");
    const r = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    expect(r.sw).toBeLessThanOrEqual(r.cw);
  });

  test("cabeçalho usa o logo oficial (balão ⓘ) e a página não estoura em 1440, 1024, 768 e 390", async ({ page }) => {
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const r = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }));
      expect(r.sw, `overflow em ${width}px`).toBeLessThanOrEqual(r.cw);
    }
    await expect(page.locator('header img[src*="innochat-balao"]').first()).toBeAttached();
    await expect(page.getByRole("link", { name: "InnoChat, início" }).first()).toBeVisible();
  });

  // ─── Melhorias da landing: botão "Tirar dúvidas", rede da hero, painel 3D e jornada ───────────────

  const WA_MESSAGE = "Olá! Vim pelo site e quero tirar uma dúvida sobre o InnoChat.";

  /** O número vem do banco (Admin → Dados da empresa). Sem número cadastrado o botão não existe. */
  async function openWithSalesButton(page: import("@playwright/test").Page) {
    await page.goto("/");
    const botao = page.getByTestId("duvidas-botao");
    test.skip((await botao.count()) === 0, "WhatsApp comercial não cadastrado no banco de dev (Admin → Dados da empresa)");
    return botao;
  }

  test("botão 'Tirar dúvidas': link wa.me com a mensagem certa, nova aba e alvo de 44 px", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const botao = await openWithSalesButton(page);
    const href = (await botao.getAttribute("href")) ?? "";
    expect(href).toMatch(/^https:\/\/wa\.me\/\d{10,15}\?text=/);
    expect(href.split("?text=")[1]).toBe(encodeURIComponent(WA_MESSAGE));
    await expect(botao).toHaveAttribute("target", "_blank");
    await expect(botao).toHaveAttribute("rel", /noopener/);
    await expect(botao).toHaveAttribute("aria-label", /Tirar dúvidas/);
    await expect(botao).toContainText("Tirar dúvidas");
    const box = await botao.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
    // Teclado: recebe foco e mostra o contorno.
    await botao.focus();
    const outline = await botao.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
  });

  test("botão 'Tirar dúvidas' no celular recolhe o rótulo mas mantém 44 px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const botao = await openWithSalesButton(page);
    await expect(botao).toHaveAttribute("aria-label", /Tirar dúvidas/);
    const box = await botao.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeLessThan(80);
  });

  test("convite do botão aparece depois de uns 8 s, fecha e não volta na mesma sessão", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openWithSalesButton(page);
    const convite = page.getByTestId("duvidas-convite");
    await expect(convite).toHaveCount(0);
    await expect(convite).toBeVisible({ timeout: 14_000 });
    await expect(convite).toContainText("Ficou com dúvida? Fala comigo!");
    const fechar = convite.getByRole("button", { name: "Fechar convite" });
    await page.waitForTimeout(500); // o convite entra com uma animação de escala de ~320 ms
    expect((await fechar.boundingBox())!.height).toBeGreaterThanOrEqual(43.9);
    await fechar.click();
    await expect(convite).toHaveCount(0);
    expect(await page.evaluate(() => sessionStorage.getItem("innochat:convite-duvidas"))).toBe("1");
    // Mesma sessão: recarregar não convida de novo.
    await page.reload();
    await page.waitForTimeout(9_500);
    await expect(page.getByTestId("duvidas-convite")).toHaveCount(0);
    await expect(page.getByTestId("duvidas-botao")).toBeVisible();
  });

  test("botão 'Tirar dúvidas' nunca cobre um CTA de cadastro e some sobre o rodapé", async ({ page }) => {
    test.setTimeout(60_000);
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      const botao = await openWithSalesButton(page);
      await expect(botao).toBeVisible();
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      const overlaps: string[] = [];
      for (let y = 0; y < total; y += 250) {
        await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
        await page.waitForTimeout(120);
        const r = await page.evaluate(() => {
          const box = document.querySelector('[data-testid="duvidas-box"]')!;
          const mine = box.getBoundingClientRect();
          const hidden = getComputedStyle(box).visibility === "hidden";
          const hits = [...document.querySelectorAll('main a[href^="/cadastro"], footer')].filter((el) => {
            const b = el.getBoundingClientRect();
            return b.left < mine.right && b.right > mine.left && b.top < mine.bottom && b.bottom > mine.top;
          });
          return { hidden, hits: hits.length, y: scrollY };
        });
        // Dá um respiro para o rAF da colisão (assíncrono) quando acabou de rolar.
        if (!r.hidden && r.hits > 0) {
          await page.waitForTimeout(400);
          const again = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="duvidas-box"]')!).visibility === "hidden");
          if (!again) overlaps.push(`${width}px @ y=${r.y}`);
        }
      }
      expect(overlaps, `cobriu CTA/rodapé: ${overlaps.join(", ")}`).toEqual([]);
      // No fim da página o rodapé está na tela e o botão se recolhe.
      await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }));
      await expect(page.getByTestId("duvidas-box")).toHaveAttribute("data-avoiding", "true");
    }
  });

  test("hero: rede de fundo é decorativa, não captura o mouse e desenha", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const canvas = page.getByTestId("hero-network");
    await expect(canvas).toBeAttached();
    await expect(canvas).toHaveAttribute("aria-hidden", "true");
    expect(await canvas.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    // Começa quando o navegador está ocioso; depois disso há pixels azuis desenhados.
    await expect
      .poll(
        () =>
          canvas.evaluate((el) => {
            const c = el as HTMLCanvasElement;
            const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
            for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 0) return true;
            return false;
          }),
        { timeout: 6_000 },
      )
      .toBe(true);
    // O h1 continua legível e clicável por cima da rede.
    await expect(page.getByRole("link", { name: "Começar teste grátis" }).first()).toBeVisible();
  });

  test("painel em 3D: inclinado ao entrar, reto quando inteiro na tela, e reto com movimento reduzido", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "animation-timeline: view() é testado no Chromium");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const supports = await page.evaluate(() => CSS.supports("animation-timeline: view()"));
    test.skip(!supports, "sem animation-timeline: view() (cai no fallback por rolagem, coberto à parte)");
    const transformAt = (topFromViewport: number) =>
      page.evaluate((offset) => {
        const stage = document.querySelector('[data-testid="painel-3d"]')!;
        window.scrollTo({ top: stage.getBoundingClientRect().top + scrollY - offset, behavior: "instant" });
        return new Promise<string>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(getComputedStyle(stage.querySelector(".pt-body")!).transform))),
        );
      }, topFromViewport);
    const start = await transformAt(870);
    expect(start).toContain("matrix3d");
    const end = await transformAt(100);
    expect(end).toBe("matrix(1, 0, 0, 1, 0, 0)");

    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await transformAt(870);
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(reduced);
  });

  test("jornada em 1440: o celular fica parado e o conteúdo muda a cada passo ao rolar", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    const stage = page.getByTestId("journey-stage");
    await expect(stage).toBeAttached();
    const sections = page.locator("#jornada");
    await expect(sections.getByRole("heading", { level: 2 })).toContainText("Da primeira mensagem");

    const goTo = (index: number) =>
      page.evaluate((i) => {
        const s = document.querySelectorAll('[data-testid="journey-sentinel"]')[i] as HTMLElement;
        const r = s.getBoundingClientRect();
        window.scrollTo({ top: scrollY + r.top + r.height / 2 - innerHeight / 2, behavior: "instant" });
      }, index);
    const phoneTop = () => page.getByTestId("journey-phone").evaluate((el) => Math.round(el.getBoundingClientRect().top));

    await goTo(0);
    await expect(stage).toHaveAttribute("data-step", "1");
    const chat = page.getByTestId("journey-phone");
    await expect(chat).toContainText("oi");

    await goTo(1);
    await expect(stage).toHaveAttribute("data-step", "2");
    const parked = await phoneTop();
    await expect(chat).toContainText("Agendar horário", { timeout: 4_000 });
    await expect(page.getByRole("status").filter({ hasText: "Passo 2 de 5" })).toHaveCount(1);

    await goTo(2);
    await expect(stage).toHaveAttribute("data-step", "3");
    await expect(chat).toContainText("Agendamento confirmado!", { timeout: 4_000 });
    await expect(page.locator('[data-testid="journey-slot"][data-active="true"]')).toContainText("A agenda preenche");

    await goTo(3);
    await expect(stage).toHaveAttribute("data-step", "4");
    await expect(chat).toContainText(/lembr/i, { timeout: 4_000 });
    await expect(chat).toContainText("sem ninguém digitar nada");

    await goTo(4);
    await expect(stage).toHaveAttribute("data-step", "5");
    await expect(page.locator('[data-testid="journey-slot"][data-active="true"]')).toContainText("O cliente aparece");
    expect(Math.abs((await phoneTop()) - parked)).toBeLessThanOrEqual(1);

    // Voltar também funciona (sem "pular" nem prender).
    await goTo(1);
    await expect(stage).toHaveAttribute("data-step", "2");

    // Indicador de 5 pontos: alvos de 44 px, clique leva ao passo.
    const dots = page.getByRole("navigation", { name: "Passos da jornada" }).getByRole("button");
    await expect(dots).toHaveCount(5);
    for (let i = 0; i < 5; i++) expect((await dots.nth(i).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await dots.nth(3).click();
    await expect(stage).toHaveAttribute("data-step", "4", { timeout: 5_000 });
    await expect(dots.nth(3)).toHaveAttribute("aria-current", "step");
  });

  test("jornada em 390: sequência vertical legível, sem palco fixo e sem overflow", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByTestId("journey-track")).toHaveCount(0);
    const steps = page.getByTestId("journey-step");
    await expect(steps).toHaveCount(5);
    const tops: number[] = [];
    for (let i = 0; i < 5; i++) {
      await steps.nth(i).evaluate((el) => el.scrollIntoView({ block: "start" }));
      await expect(steps.nth(i).getByRole("heading", { level: 3 })).toBeVisible();
      tops.push(await steps.nth(i).evaluate((el) => Math.round(el.getBoundingClientRect().height)));
    }
    tops.forEach((h) => expect(h).toBeGreaterThan(300));
    // Cada passo traz o celular com o recorte certo da conversa.
    await expect(steps.nth(2)).toContainText("Agendamento confirmado!");
    await expect(steps.nth(0)).not.toContainText("Agendamento confirmado!");
    await expect(steps.nth(3)).toContainText("sem ninguém digitar nada");
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    expect(r.sw).toBeLessThanOrEqual(r.cw);
  });

  test("jornada com movimento reduzido: os 5 passos em sequência, sem palco fixo", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.getByTestId("journey-track")).toHaveCount(0);
    const steps = page.getByTestId("journey-step");
    await expect(steps).toHaveCount(5);
    for (const title of ["Chega a mensagem", "O Inno responde", "A agenda preenche", "O lembrete sai", "O cliente aparece"]) {
      await expect(page.locator("#jornada").getByRole("heading", { level: 3, name: title })).toBeAttached();
    }
    await steps.nth(2).evaluate((el) => el.scrollIntoView({ block: "center" }));
    await expect(steps.nth(2).getByTestId("journey-phone")).toContainText("Agendamento confirmado!");
    // Nenhuma animação em curso na rede: o canvas existe mas está parado (um único quadro).
    await expect(page.getByTestId("hero-network")).toBeAttached();
  });

  test("sem overflow horizontal em 1440, 1280, 1024, 768 e 390 (rede, painel 3D, jornada e botão)", async ({ page }) => {
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
      [1024, 768],
      [768, 1024],
      [390, 844],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/");
      // Percorre a página inteira: o painel inclinado e o palco da jornada são os que poderiam estourar.
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y < total; y += 600) {
        await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), y);
        const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
        expect(r.sw, `overflow em ${width}px, y=${y}`).toBeLessThanOrEqual(r.cw);
      }
    }
  });
});
