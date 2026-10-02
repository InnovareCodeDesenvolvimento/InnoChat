import { afterEach, describe, expect, it, vi } from "vitest";
import { logger, setErrorSink } from "./logger";

afterEach(() => {
  setErrorSink(null);
  vi.restoreAllMocks();
});

describe("gancho do logger.error", () => {
  it("só o nível error chama o sink, com os campos já redigidos", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sink = vi.fn();
    setErrorSink(sink);
    logger.warn("aviso", { a: 1 });
    logger.error("quebrou", { token: "segredo", errorName: "X" });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith("quebrou", { token: "[redacted]", errorName: "X" });
  });

  it("sink que lança não derruba quem logou", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setErrorSink(() => {
      throw new Error("sink ruim");
    });
    expect(() => logger.error("x")).not.toThrow();
  });
});
