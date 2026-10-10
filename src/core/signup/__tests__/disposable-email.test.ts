import { describe, expect, it } from "vitest";
import { emailDomain, isDisposableEmail } from "../disposable-email";

describe("isDisposableEmail", () => {
  it("barra os serviços de e-mail descartável mais comuns", () => {
    for (const email of ["a@mailinator.com", "a@yopmail.com", "a@guerrillamail.com", "a@10minutemail.com", "a@temp-mail.org", "a@sharklasers.com", "a@getnada.com", "a@maildrop.cc"]) {
      expect(isDisposableEmail(email), email).toBe(true);
    }
  });

  it("ignora maiúsculas e pega subdomínio do serviço", () => {
    expect(isDisposableEmail("Fulano@MAILINATOR.COM")).toBe(true);
    expect(isDisposableEmail("fulano@x.mailinator.com")).toBe(true);
  });

  it("não barra provedores normais nem domínio parecido", () => {
    for (const email of ["a@gmail.com", "a@hotmail.com", "a@outlook.com", "a@empresa.com.br", "a@mailinatorfake.com", "a@notyopmail.com"]) {
      expect(isDisposableEmail(email), email).toBe(false);
    }
  });

  it("e-mail sem domínio não é considerado descartável (quem valida o formato é o zod)", () => {
    expect(isDisposableEmail("semarroba")).toBe(false);
    expect(isDisposableEmail("a@")).toBe(false);
    expect(emailDomain("a@Gmail.com")).toBe("gmail.com");
  });
});
