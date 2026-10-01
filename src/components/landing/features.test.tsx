import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Features } from "./features";

describe("Features da landing", () => {
  it("só promete login com Google quando ele está configurado no Admin", () => {
    expect(renderToStaticMarkup(createElement(Features, { googleLogin: false }))).not.toContain("Entre com o Google");
    expect(renderToStaticMarkup(createElement(Features, { googleLogin: true }))).toContain("Entre com o Google");
  });
});
