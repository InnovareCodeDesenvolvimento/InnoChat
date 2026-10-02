import { describe, expect, it } from "vitest";
import { parseConsent, serializeConsent } from "./meta-events";

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
