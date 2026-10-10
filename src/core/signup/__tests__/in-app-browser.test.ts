import { describe, expect, it } from "vitest";
import { carriedQuery, detectInAppBrowser, externalBrowserHref, isInAppBrowser } from "../in-app-browser";

const INSTAGRAM_ANDROID =
  "Mozilla/5.0 (Linux; Android 13; SM-A546E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Mobile Safari/537.36 Instagram 310.0.0.37.109 Android (33/13; 420dpi; 1080x2340; samsung; SM-A546E; a54x; s5e8835; pt_BR; 543798905)";
const FACEBOOK_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/21B74 [FBAN/FBIOS;FBAV/440.0.0.30.113;FBBV/512345;FBDV/iPhone14,5;FBMD/iPhone;FBSN/iOS;FBSV/17.1;FBLC/pt_BR;FBOP/5]";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 13; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36";
const SAFARI_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";

describe("isInAppBrowser", () => {
  it("reconhece o navegador do Instagram e do Facebook", () => {
    expect(isInAppBrowser(INSTAGRAM_ANDROID)).toBe(true);
    expect(isInAppBrowser(FACEBOOK_IOS)).toBe(true);
    expect(isInAppBrowser("Mozilla/5.0 [FB_IAB/FB4A;FBAV/400.0]")).toBe(true);
  });

  it("deixa o Google visível em Chrome, Safari e quando não há user-agent", () => {
    expect(isInAppBrowser(CHROME_ANDROID)).toBe(false);
    expect(isInAppBrowser(SAFARI_IOS)).toBe(false);
    expect(isInAppBrowser(null)).toBe(false);
    expect(isInAppBrowser("")).toBe(false);
  });
});

describe("detectInAppBrowser", () => {
  it("separa Android de iOS dentro do navegador embutido", () => {
    expect(detectInAppBrowser(INSTAGRAM_ANDROID)).toEqual({ inApp: true, platform: "android" });
    expect(detectInAppBrowser(FACEBOOK_IOS)).toEqual({ inApp: true, platform: "ios" });
    expect(detectInAppBrowser("Mozilla/5.0 (X11; Linux) Instagram 300.0")).toEqual({ inApp: true, platform: "other" });
  });

  it("navegador comum e user-agent vazio não são embutidos", () => {
    expect(detectInAppBrowser(CHROME_ANDROID)).toEqual({ inApp: false, platform: "other" });
    expect(detectInAppBrowser(SAFARI_IOS).inApp).toBe(false);
    expect(detectInAppBrowser(undefined).inApp).toBe(false);
  });
});

describe("carriedQuery", () => {
  it("leva cupom, utm_* e fbclid, descarta o resto e soma o parâmetro extra", () => {
    const q = carriedQuery({ cupom: "BEMVINDO", utm_source: "ig", fbclid: "abc123", error: "x", token: "segredo" }, { via: "google" });
    const params = new URLSearchParams(q);
    expect(params.get("cupom")).toBe("BEMVINDO");
    expect(params.get("utm_source")).toBe("ig");
    expect(params.get("fbclid")).toBe("abc123");
    expect(params.get("via")).toBe("google");
    expect(params.has("error")).toBe(false);
    expect(params.has("token")).toBe(false);
  });

  it("sem parâmetros, só o extra; aceita valor repetido (usa o primeiro)", () => {
    expect(carriedQuery({}, { via: "google" })).toBe("via=google");
    expect(carriedQuery({ cupom: ["A", "B"] })).toBe("cupom=A");
  });
});

describe("externalBrowserHref", () => {
  const host = "innochat.innovarecode.com.br";
  it("Android: intent para o Chrome com a URL https de reserva", () => {
    const href = externalBrowserHref("android", host, "/cadastro", "cupom=A&via=google");
    expect(href).toBe(
      `intent://${host}/cadastro?cupom=A&via=google#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(`https://${host}/cadastro?cupom=A&via=google`)};end`,
    );
  });

  it("iOS: x-safari-https; outros: https puro; sem query não deixa ponto de interrogação", () => {
    expect(externalBrowserHref("ios", host, "/cadastro", "via=google")).toBe(`x-safari-https://${host}/cadastro?via=google`);
    expect(externalBrowserHref("other", host, "/cadastro", "")).toBe(`https://${host}/cadastro`);
  });
});
