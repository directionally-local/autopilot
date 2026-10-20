/**
 * Startup banner printed above the TUI. Plain text — no artwork.
 */

const accent = "\x1b[38;2;255;153;0m";
const dim = "\x1b[2m";
const bold = "\x1b[1m";
const reset = "\x1b[0m";

/** Render the startup banner for `version`, naming the configured model and the provider serving it. */
export function renderLogo(version: string, model?: string, provider = "OpenRouter"): string {
  // "moonshotai/kimi-k2.6" → "kimi-k2.6"
  const running = model ? `${model.slice(model.indexOf("/") + 1)} via ${provider}` : `runs on ${provider}`;
  return [
    "",
    `  ${bold}${accent}autopilot${reset} ${dim}(formerly kimiflare)${reset}`,
    `  ${dim}Terminal coding agent · ${running} · v${version}${reset}`,
    "",
  ].join("\n");
}
