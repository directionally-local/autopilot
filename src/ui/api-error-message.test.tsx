import { describe, it } from "node:test";
import assert from "node:assert";
import React from "react";
import { renderToString } from "ink";
import { ApiErrorMessage } from "./api-error-message.js";
import { ThemeProvider } from "./theme-context.js";
import { resolveTheme } from "./theme.js";

const testTheme = resolveTheme();

function render(props: { message: string; httpStatus?: number; code?: number; statusUrl?: string }): string {
  return renderToString(
    <ThemeProvider theme={testTheme}>
      <ApiErrorMessage {...props} />
    </ThemeProvider>,
  );
}

describe("ApiErrorMessage", () => {
  it("renders the error message", () => {
    const out = render({ message: "Rate limit exceeded" });
    assert.ok(out.includes("Rate limit exceeded"));
  });

  it("renders HTTP status and code", () => {
    const out = render({ message: "Rate limit exceeded", httpStatus: 429, code: 3040 });
    assert.ok(out.includes("HTTP 429"));
    assert.ok(out.includes("code: 3040"));
  });

  it("points at the active provider's status page and /model", () => {
    const out = render({ message: "Something went wrong", statusUrl: "https://status.deepseek.com" });
    assert.ok(out.includes("status.deepseek.com"));
    assert.ok(!out.includes("openrouter"));
    assert.ok(out.includes("/model"));
  });

  it("omits the status link for providers without one", () => {
    const out = render({ message: "Something went wrong" });
    assert.ok(!out.includes("Provider status"));
    assert.ok(out.includes("/model"));
  });
});
