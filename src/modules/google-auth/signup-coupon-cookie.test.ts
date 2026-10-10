import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
const set = vi.fn((name: string, value: string) => void store.set(name, value));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (store.has(n) ? { value: store.get(n)! } : undefined), set, delete: (n: string) => void store.delete(n) }),
}));

const { SIGNUP_COUPON_COOKIE, clearSignupCouponCookie, readSignupCouponCookie, sanitizeCouponCode, setSignupCouponCookie } = await import("./signup-coupon-cookie");

beforeEach(() => {
  store.clear();
  set.mockClear();
});

describe("cookie do cupom do link de cadastro", () => {
  it("grava o código em maiúsculo, httpOnly, lax, por 30 min", async () => {
    expect(await setSignupCouponCookie(" verao10 ")).toBe(true);
    const [name, value, options] = set.mock.calls[0]! as unknown as [string, string, Record<string, unknown>];
    expect(name).toBe(SIGNUP_COUPON_COOKIE);
    expect(value).toBe("VERAO10");
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 1800 });
  });

  it("não grava lixo, vazio nem valor que não é texto", async () => {
    expect(await setSignupCouponCookie("a b; drop table")).toBe(false);
    expect(await setSignupCouponCookie("")).toBe(false);
    expect(await setSignupCouponCookie(null)).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it("lê de volta o código e ignora cookie adulterado", async () => {
    await setSignupCouponCookie("VERAO10");
    expect(await readSignupCouponCookie()).toBe("VERAO10");
    store.set(SIGNUP_COUPON_COOKIE, "<script>");
    expect(await readSignupCouponCookie()).toBeNull();
  });

  it("clear apaga o cookie", async () => {
    await setSignupCouponCookie("VERAO10");
    await clearSignupCouponCookie();
    expect(await readSignupCouponCookie()).toBeNull();
  });

  it("sanitizeCouponCode normaliza e recusa formato inválido", () => {
    expect(sanitizeCouponCode("promo_1")).toBe("PROMO_1");
    expect(sanitizeCouponCode("ab")).toBeNull();
    expect(sanitizeCouponCode(42)).toBeNull();
  });
});
