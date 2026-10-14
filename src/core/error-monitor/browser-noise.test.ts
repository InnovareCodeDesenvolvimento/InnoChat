import { describe, expect, it } from "vitest";
import { isBrowserNoiseError } from "./browser-noise";

describe("isBrowserNoiseError", () => {
  describe("caso (a) iabjs (Chrome Android WebView)", () => {
    it("descarta pelo stack real iabjs://navigation_performance_logger_android:1:...", () => {
      const stack = [
        "Error: Error invoking postMessage: Java object is gone",
        "    at iabjs://navigation_performance_logger_android:1:1234",
      ].join("\n");
      expect(isBrowserNoiseError("Error", "Error invoking postMessage: Java object is gone", stack)).toBe(true);
    });

    it("descarta pela mensagem exata 'Error invoking postMessage: Java object is gone' mesmo sem stack", () => {
      expect(isBrowserNoiseError("Error", "Error invoking postMessage: Java object is gone", undefined)).toBe(true);
      expect(isBrowserNoiseError(undefined, "Error invoking postMessage: Java object is gone", "")).toBe(true);
    });

    it("descarta por linha no stack começando com iabjs:// mesmo com mensagem genérica", () => {
      const stack = "Error: something failed\n    at iabjs://custom_logger:2:50";
      expect(isBrowserNoiseError("Error", "something failed", stack)).toBe(true);
    });

    it("não descarta erro legítimo que apenas contenha iabjs em outro contexto", () => {
      expect(isBrowserNoiseError("Error", "User visited /iabjs page", "Error\n    at fn (https://app.innochat.com.br/_next/static/chunks/app.js:1:1)")).toBe(false);
    });
  });

  describe("caso (b) Load failed do fetch abortado pela navegação", () => {
    it("descarta 'Load failed' sem frames do nosso app no stack", () => {
      expect(isBrowserNoiseError("TypeError", "Load failed", undefined)).toBe(true);
      expect(isBrowserNoiseError("TypeError", "Load failed", "")).toBe(true);
      expect(isBrowserNoiseError("TypeError", "Load failed", "TypeError: Load failed\n    at <anonymous>")).toBe(true);
    });

    it("descarta variações case-insensitive de 'Load failed', 'Failed to load' e 'NetworkError when attempting to fetch resource'", () => {
      expect(isBrowserNoiseError("TypeError", "load failed", undefined)).toBe(true);
      expect(isBrowserNoiseError("TypeError", "Failed to load", undefined)).toBe(true);
      expect(isBrowserNoiseError("TypeError", "failed to load", undefined)).toBe(true);
      expect(isBrowserNoiseError("TypeError", "NetworkError when attempting to fetch resource", undefined)).toBe(true);
      expect(isBrowserNoiseError("TypeError", "networkerror when attempting to fetch resource", undefined)).toBe(true);
    });

    it("NÃO descarta quando há frame do nosso app com /_next/", () => {
      const stackWithNext = [
        "TypeError: Load failed",
        "    at fetchData (https://innochat.innovarecode.com.br/_next/static/chunks/app/cadastro/page.js:12:34)",
      ].join("\n");
      expect(isBrowserNoiseError("TypeError", "Load failed", stackWithNext)).toBe(false);
    });

    it("NÃO descarta quando há frame com appHost informado em opts", () => {
      const stackWithHost = [
        "TypeError: Load failed",
        "    at doSomething (https://innochat.innovarecode.com.br/custom-script.js:10:20)",
      ].join("\n");
      // Sem passar host nem /_next/, seria considerado ruído
      expect(isBrowserNoiseError("TypeError", "Load failed", stackWithHost)).toBe(true);
      // Com appHost string
      expect(isBrowserNoiseError("TypeError", "Load failed", stackWithHost, { appHost: "innochat.innovarecode.com.br" })).toBe(false);
      // Com appHost RegExp
      expect(isBrowserNoiseError("TypeError", "Load failed", stackWithHost, { appHost: /innochat\.innovarecode\.com\.br/ })).toBe(false);
    });

    it("não confunde outros erros com ruído de fetch", () => {
      expect(isBrowserNoiseError("TypeError", "Cannot read properties of undefined (reading 'foo')", undefined)).toBe(false);
      expect(isBrowserNoiseError("Error", "Failed to compile", undefined)).toBe(false);
    });
  });
});
