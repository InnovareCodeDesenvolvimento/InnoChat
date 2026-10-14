import { describe, it, expect } from "vitest";
import { forbidDuringSupport, SupportForbiddenError, FORBIDDEN_SUPPORT_ACTIONS } from "@/modules/support/forbid";

describe("forbidDuringSupport", () => {
  it("permite qualquer ação se não for impersonação de suporte (isSupportImpersonation undefined)", () => {
    expect(() => {
      forbidDuringSupport(undefined, "tenant.delete");
      forbidDuringSupport(null, "whatsapp.disconnect");
      forbidDuringSupport({}, "user.change_email");
    }).not.toThrow();
  });

  it("permite qualquer ação se isSupportImpersonation for false", () => {
    const ctx = { isSupportImpersonation: false, supportSessionId: null };
    expect(() => {
      forbidDuringSupport(ctx, "tenant.delete");
      forbidDuringSupport(ctx, "whatsapp.disconnect");
      forbidDuringSupport(ctx, "membership.delete");
    }).not.toThrow();
  });

  it("permite ações seguras mesmo se for impersonação de suporte", () => {
    const ctx = { isSupportImpersonation: true, supportSessionId: "session-123" };
    expect(() => {
      forbidDuringSupport(ctx, "appointment.create");
      forbidDuringSupport(ctx, "service.update");
      forbidDuringSupport(ctx, "contact.list");
    }).not.toThrow();
  });

  it("lança SupportForbiddenError para todas as ações da blacklist quando isSupportImpersonation é true", () => {
    const ctx = { isSupportImpersonation: true, supportSessionId: "session-123" };
    for (const action of FORBIDDEN_SUPPORT_ACTIONS) {
      expect(() => {
        forbidDuringSupport(ctx, action);
      }).toThrowError(SupportForbiddenError);
    }
  });
});
