import { describe, it } from "node:test";
import assert from "node:assert";
import { BUILTIN_COMMAND_NAMES } from "../commands/builtins.js";
import { CATEGORIES } from "./help-catalog.js";
import {
  markProductTourSeen,
  productTourSeen,
  runProductTour,
  styledTourFrame,
  tourFooter,
  tourFrame,
  tourHint,
  tourKey,
  tourMove,
  tourHintUntilSeen,
  tourSteps,
  type TourDeps,
} from "./product-tour.js";
import { textRows } from "./terminal-wait.js";

const DL = { AUTOPILOT_LAUNCHED_BY: "dl" };

describe("/tour steps", () => {
  it("names only slash commands that exist", () => {
    // /jobs and /agents are the renderer's own activity browser (camouflage-view.ts routeActivityCommand).
    const known = new Set([...BUILTIN_COMMAND_NAMES, "jobs", "agents"]);
    for (const env of [{}, DL]) {
      for (const step of tourSteps({ env, sessions: "~/sessions" })) {
        for (const [, name] of step.lines.join(" ").matchAll(/(?:^|\s)\/([a-z][a-z-]*)/g)) {
          assert.ok(known.has(name!), `/${name} in "${step.title}" is a real command`);
        }
      }
    }
  });

  it("is listed in /help", () => {
    const all = CATEGORIES.flatMap((c) => c.commands.map((i) => i.command));
    assert.ok(all.includes("/tour"));
    assert.ok(all.includes("/ideas"), "the project summary moved to /ideas");
  });

  it("covers the dl-only steps only under dl, and keeps every step short", () => {
    const dl = tourSteps({ env: DL, sessions: "/s" });
    const plain = tourSteps({ env: {}, sessions: "/s" });
    assert.strictEqual(dl.length, 8);
    assert.strictEqual(plain.length, 7);
    assert.ok(dl.some((s) => s.title === "your own GPUs"));
    assert.ok(!plain.some((s) => s.lines.join(" ").includes("dl model")));
    assert.match(plain[4]!.lines.join(" "), /`autopilot --from-claude-code`/);
    assert.match(dl[4]!.lines.join(" "), /`dl --from-claude-code`/);
    for (const step of dl) assert.ok(step.lines.length >= 1 && step.lines.length <= 4, step.title);
  });

  it("promises no invite reward", () => {
    const invite = tourSteps({ env: DL }).find((s) => s.title === "invite friends")!;
    assert.doesNotMatch(invite.lines.join(" "), /bonus|credit|token|free \w+ for/i);
  });

  it("the startup hint is short", () => {
    assert.strictEqual(tourHint(DL), "/tour · what's different about dl");
    assert.strictEqual(tourHint({}), "/tour · what's different about autopilot");
    assert.ok(tourHint({}).length <= 50);
  });
});

describe("/tour keys and navigation", () => {
  it("maps → l Enter to next, ← h to back, Esc q Ctrl+C to close", () => {
    for (const k of ["\x1b[C", "\x1bOC", "l", "\r", "\n", "\x1b[13u"]) assert.strictEqual(tourKey(k), "next", JSON.stringify(k));
    for (const k of ["\x1b[D", "\x1bOD", "h"]) assert.strictEqual(tourKey(k), "back", JSON.stringify(k));
    for (const k of ["\x1b", "q", "\x03", "\x1b[27u"]) assert.strictEqual(tourKey(k), "close", JSON.stringify(k));
    for (const k of ["x", "\x1b[A", "1"]) assert.strictEqual(tourKey(k), null);
  });

  it("stays in bounds: back on the first step stays, next on the last closes", () => {
    assert.strictEqual(tourMove(0, "back", 7), 0);
    assert.strictEqual(tourMove(0, "next", 7), 1);
    assert.strictEqual(tourMove(3, "back", 7), 2);
    assert.strictEqual(tourMove(6, "next", 7), null);
    assert.strictEqual(tourMove(2, "close", 7), null);
  });

  it("the footer counts and names the keys", () => {
    assert.strictEqual(tourFooter(0, 7), "1 of 7 · → next · esc close");
    assert.strictEqual(tourFooter(1, 7), "2 of 7 · → next · ← back · esc close");
    assert.strictEqual(tourFooter(6, 7), "7 of 7 · → done · ← back · esc close");
  });

  it("wraps to the terminal: nothing wider than 79 or 39 columns", () => {
    const steps = tourSteps({ env: DL, sessions: "/home/me/.local/share/autopilot/sessions" });
    for (const width of [79, 39]) {
      steps.forEach((_, i) => {
        for (const line of tourFrame(steps, i, width)) assert.ok(line.length <= width || !line.includes(" "), `${width}: ${line}`);
      });
    }
    // Styling takes no columns when the screen is erased.
    const styled = styledTourFrame(steps, 1, 79);
    assert.strictEqual(textRows(styled, 80), tourFrame(steps, 1, 79).length);
  });

  it("runs on the lent terminal: next, back, Esc; seen counts the furthest step", async () => {
    const steps = tourSteps({ env: DL, sessions: "/s" });
    const drawn: string[] = [];
    const deps: TourDeps = {
      screen: async (draw, onKey) => {
        drawn.push(draw());
        for (const key of ["l", "\x1b[C", "x", "h", "\x1b"]) {
          if (onKey(key)) return true;
          drawn.push(draw());
        }
        assert.fail("Esc closes the tour");
      },
      select: async () => assert.fail("not used when the terminal is lent"),
    };
    assert.strictEqual(await runProductTour(steps, deps, () => 79), 3);
    const footers = drawn.map((d) => d.split("\n").at(-1)!.replace(/\x1b\[\d+m/g, ""));
    assert.deepStrictEqual(footers.map((f) => f.split(" · ")[0]), ["1 of 8", "2 of 8", "3 of 8", "3 of 8", "2 of 8"]);
  });

  it("next past the last step closes it", async () => {
    const steps = tourSteps({ env: {}, sessions: "/s" });
    let keys = 0;
    const deps: TourDeps = {
      screen: async (_draw, onKey) => {
        while (!onKey("\r")) keys++;
        return true;
      },
      select: async () => null,
    };
    assert.strictEqual(await runProductTour(steps, deps, () => 79), steps.length);
    assert.strictEqual(keys, steps.length - 1);
  });

  it("falls back to one list per step where the terminal can't be lent", async () => {
    const steps = tourSteps({ env: DL, sessions: "/s" });
    const answers = ["next", "back", "next", "next", null];
    const titles: string[] = [];
    const deps: TourDeps = {
      screen: async () => false,
      select: async (title, options) => {
        titles.push(title);
        assert.ok(options.some((o) => o.value === "close"));
        return answers.shift() ?? null;
      },
    };
    assert.strictEqual(await runProductTour(steps, deps, () => 79), 3);
    assert.deepStrictEqual(titles.map((t) => t.split(" · ").at(-1)), ["1 of 8", "2 of 8", "1 of 8", "2 of 8", "3 of 8"]);
  });
});

describe("/tour seen once", () => {
  it("the startup hint shows until /tour is opened once, then never", async () => {
    assert.strictEqual(await productTourSeen(), false);
    assert.strictEqual(await tourHintUntilSeen(DL), "/tour · what's different about dl");
    assert.strictEqual(await tourHintUntilSeen(DL), "/tour · what's different about dl", "not used up by showing it");
    await markProductTourSeen();
    assert.strictEqual(await productTourSeen(), true);
    assert.strictEqual(await tourHintUntilSeen(DL), undefined);
  });
});
