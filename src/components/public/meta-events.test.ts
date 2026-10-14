import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSENT_STORAGE_KEY, isPixelActive, parseConsent, serializeConsent, trackPixel, urlWithoutQuery } from "./meta-events";

describe("consentimento", () => {
  it("ida e volta", () => {
    expect(parseConsent(serializeConsent("granted"))).toBe("granted");
    expect(parseConsent(serializeConsent("denied"))).toBe("denied");
  });

  it("vazio, lixo ou versão desconhecida valem como sem escolha (o banner pergunta de novo)", () => {
    expect(parseConsent(null)).toBeNull();
    expect(parseConsent("")).toBeNull();
    expect(parseConsent("granted")).toBeNull();
    expect(parseConsent("{}")).toBeNull();
    expect(parseConsent(JSON.stringify({ v: 2, choice: "granted" }))).toBeNull();
    expect(parseConsent(JSON.stringify({ v: 1, choice: "talvez" }))).toBeNull();
  });
});

describe("URL enviada ao Pixel", () => {
  it("sai sem query e sem fragmento (token, e-mail e cupom nunca vão à Meta)", () => {
    expect(urlWithoutQuery("https://innochat.app/cadastro/google?t=abc.def&email=a%40b.com#x")).toBe("https://innochat.app/cadastro/google");
    expect(urlWithoutQuery("https://innochat.app/cadastro?error=google")).toBe("https://innochat.app/cadastro");
  });
});

describe("retirada do consentimento", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeWindow(stored: string | null) {
    const fbq = vi.fn();
    vi.stubGlobal("window", {
      fbq,
      __innochatPixelId: "123456789012345",
      localStorage: { getItem: (k: string) => (k === CONSENT_STORAGE_KEY ? stored : null) },
    });
    return fbq;
  }

  it("com aceite o Pixel está ativo e dispara", () => {
    const fbq = fakeWindow(serializeConsent("granted"));
    expect(isPixelActive()).toBe(true);
    trackPixel("CompleteRegistration", "evt-12345678");
    expect(fbq).toHaveBeenCalledWith("track", "CompleteRegistration", {}, { eventID: "evt-12345678" });
  });

  it("quem recusa DEPOIS de aceitar para de enviar na hora (o cadastro também não manda o id do evento)", () => {
    const fbq = fakeWindow(serializeConsent("denied"));
    expect(isPixelActive()).toBe(false);
    trackPixel("PageView");
    expect(fbq).not.toHaveBeenCalled();
  });

  it("sem escolha salva (banner reaberto) também não envia", () => {
    fakeWindow(null);
    expect(isPixelActive()).toBe(false);
  });
});

describe("páginas que levam dado pessoal na URL", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("/cadastro/google (token com e-mail e nome na URL) NÃO monta o Pixel nem dispara evento do navegador", () => {
    const page = read("../../app/(public)/cadastro/google/page.tsx");
    const form = read("../../app/(public)/cadastro/google/google-signup-form.tsx");
    expect(page).not.toMatch(/MetaTracking/);
    expect(form).not.toMatch(/trackPixel|isPixelActive|metaEventId/);
  });

  it("/cadastro monta o Pixel com a query removida da URL (sem banner de consentimento, decisao 2026-10-14)", () => {
    const page = read("../../app/(public)/cadastro/page.tsx");
    expect(page).toMatch(/<MetaAutoTracking stripQuery \/>/);
    expect(page).not.toMatch(/<MetaTracking stripQuery \/>/);
  });
});
