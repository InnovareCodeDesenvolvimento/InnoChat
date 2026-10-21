import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthorizationUrl, OAUTH_CALLBACK_PATH, OAUTH_DRIVE_SCOPE, redirectUriFor, refreshAccessToken, signOAuthState, verifyOAuthState } from "./drive-oauth";
import { DriveFailure } from "./drive";

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

describe("refreshAccessToken: invalid_client é o Client ID/Secret do app OAuth, não uma conta de serviço", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("vira DriveFailure categoria oauth_client_invalid (bug real: cliente OAuth trocado no Google Cloud)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: "invalid_client", error_description: "The OAuth client was not found." }),
      })),
    );
    let thrown: unknown;
    try {
      await refreshAccessToken({ clientId: "id-velho", clientSecret: "segredo-velho", refreshToken: "refresh-velho" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DriveFailure);
    expect((thrown as DriveFailure).category).toBe("oauth_client_invalid");
    expect((thrown as Error).message).toMatch(/Client ID ou o Client Secret/);
  });

  it("continua distinguindo invalid_grant (revogado) de invalid_client (credencial errada)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }),
      })),
    );
    let thrown: unknown;
    try {
      await refreshAccessToken({ clientId: "id", clientSecret: "segredo", refreshToken: "refresh-revogado" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(DriveFailure);
    expect((thrown as DriveFailure).category).toBe("oauth_disconnected");
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
