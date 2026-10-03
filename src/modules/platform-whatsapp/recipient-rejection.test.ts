import { describe, expect, it } from "vitest";
import { EvolutionApiError } from "@/modules/whatsapp/evolution-client";
import { isRecipientRejection } from "./sender";

describe("isRecipientRejection (a Evolution recusou o NÚMERO, não o canal)", () => {
  it("400 é recusa do número", () => {
    expect(isRecipientRejection(new EvolutionApiError("x", 400))).toBe(true);
  });

  it("corpo com exists:false é recusa do número, mesmo com outro status", () => {
    expect(isRecipientRejection(new EvolutionApiError("x", 500, undefined, '{"response":{"message":[{"jid":"5584@s.whatsapp.net","exists":false}]}}'))).toBe(true);
  });

  it("5xx, rede e erro comum não são recusa do número", () => {
    expect(isRecipientRejection(new EvolutionApiError("x", 503))).toBe(false);
    expect(isRecipientRejection(new EvolutionApiError("timeout"))).toBe(false);
    expect(isRecipientRejection(new Error("boom"))).toBe(false);
    expect(isRecipientRejection(new EvolutionApiError("x", 401))).toBe(false);
  });
});
