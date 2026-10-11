import { describe, it } from "node:test";
import assert from "node:assert";
import React from "react";
import { renderToString } from "ink";
import { ToolView } from "./tool-view.js";
import { ThemeProvider } from "./theme-context.js";
import { resolveTheme } from "./theme.js";

const theme = resolveTheme();

describe("ToolView guardrail results", () => {
  it("shows blocked calls quietly without exposing agent-only recovery text", () => {
    const output = renderToString(
      <ThemeProvider theme={theme}>
        <ToolView
          evt={{
            id: "blocked-fetch",
            name: "web_fetch",
            args: JSON.stringify({ url: "https://huggingface.co/example" }),
            status: "blocked",
            result: "Loop detected. Consider a different approach or synthesize existing findings.",
          }}
          verbose
        />
      </ThemeProvider>,
    );

    assert.match(output, /\[skip\]/);
    assert.doesNotMatch(output, /Loop detected|Consider a different approach|synthesize existing findings/);
  });
});
