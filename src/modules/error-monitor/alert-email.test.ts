import { describe, expect, it } from "vitest";
import { buildErrorAlertEmail } from "./alert";

const group = (over: Partial<Parameters<typeof buildErrorAlertEmail>[0][number]>) => ({
  id: "g", type: "TypeError", message: "falhou", route: "/api/x", source: "SERVER", lastVersion: "1.0.0", count: 1, ...over,
});

describe("e-mail de alerta de erro", () => {
  it("texto de erro do NAVEGADOR (público, do atacante) nunca entra: só contagem e o link", () => {
    const evil = group({ id: "c", source: "CLIENT", type: "Aviso", message: "Sua conta foi bloqueada, entre em https://evil.example/login", route: "/p?x=https://evil.example" });
    const mail = buildErrorAlertEmail([evil], 0, "https://app.example/admin/erros");
    for (const body of [mail.text, mail.html]) {
      expect(body).not.toContain("evil.example");
      expect(body).not.toContain("bloqueada");
      expect(body).not.toContain("Aviso");
    }
    expect(mail.text).toContain("1 erro novo no navegador");
    expect(mail.text).toContain("https://app.example/admin/erros");
    expect(mail.html).toContain('href="https://app.example/admin/erros"');
  });

  it("erro do servidor segue com o detalhe; o do navegador entra só como contagem", () => {
    const mail = buildErrorAlertEmail(
      [group({ id: "s", message: "Contato não achado" }), group({ id: "c1", source: "CLIENT", message: "xx" }), group({ id: "c2", source: "CLIENT", message: "yy" })],
      0,
      null,
    );
    expect(mail.subject).toBe("3 erros novos no InnoChat");
    expect(mail.text).toContain("No servidor: TypeError, Contato não achado");
    expect(mail.text).toContain("2 erros novos no navegador");
    expect(mail.text).not.toContain("xx");
  });
});
