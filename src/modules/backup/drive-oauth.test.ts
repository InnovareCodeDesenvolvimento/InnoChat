import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAuthorizationUrl, OAUTH_CALLBACK_PATH, OAUTH_DRIVE_SCOPE, redirectUriFor, signOAuthState, verifyOAuthState } from "./drive-oauth";

const original = process.env.AUTH_SECRET;
beforeEach(() => {
  process.env.AUTH_SECRET = "segredo-de-teste-com-mais-de-16-chars";
});
afterEach(() => {
  process.env.AUTH_SECRET = original;
});

describe("state do OAuth: assinado, com prazo e de uma pessoa só", () => {
  it("ida e volta", () => {
    const { state, nonce } = signOAuthState("admin-1");
    const payload = verifyOAuthState(state);
    expect(payload?.adminId).toBe("admin-1");
    expect(payload?.nonce).toBe(nonce);
  });
  it("recusa adulteração do corpo ou da assinatura", () => {
    const { state } = signOAuthState("admin-1");
    const [body, sig] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ adminId: "atacante", nonce: "x", iat: 1, exp: Date.now() + 100000 })).toString("base64url");
    expect(verifyOAuthState(`${forged}.${sig}`)).toBeNull();
    expect(verifyOAuthState(`${body}.${sig.slice(0, -2)}AA`)).toBeNull();
    expect(verifyOAuthState("lixo")).toBeNull();
    expect(verifyOAuthState("")).toBeNull();
  });
  it("recusa vencido (10 minutos)", () => {
    const now = Date.now();
    const { state } = signOAuthState("admin-1", now - 11 * 60 * 1000);
    expect(verifyOAuthState(state, now)).toBeNull();
    expect(verifyOAuthState(state, now - 9 * 60 * 1000 + 1)).not.toBeNull();
  });
  it("não vale com outro AUTH_SECRET", () => {
    const { state } = signOAuthState("admin-1");
    process.env.AUTH_SECRET = "outro-segredo-totalmente-diferente-123";
    expect(verifyOAuthState(state)).toBeNull();
  });
});

describe("URL de autorização", () => {
  it("pede acesso offline com consentimento e escopo mínimo, e o retorno vem da URL pública", () => {
    const redirectUri = redirectUriFor("https://app.exemplo.com/");
    expect(redirectUri).toBe(`https://app.exemplo.com${OAUTH_CALLBACK_PATH}`);
    const url = new URL(buildAuthorizationUrl({ clientId: "cid", redirectUri, state: "st" }));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")).toBe(OAUTH_DRIVE_SCOPE);
    expect(OAUTH_DRIVE_SCOPE).toMatch(/drive\.file$/);
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("state")).toBe("st");
  });
});
