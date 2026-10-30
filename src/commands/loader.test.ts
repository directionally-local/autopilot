import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { filenameToCommandName, loadCustomCommands } from "./loader.js";

async function setup(): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), "kf-loader-"));
  return {
    cwd,
    cleanup: async () => {
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

async function writeCmd(dir: string, rel: string, content: string): Promise<void> {
  const path = join(dir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

describe("filenameToCommandName", () => {
  it("strips extension", () => {
    assert.equal(filenameToCommandName("/root/test.md", "/root"), "test");
  });
  it("uses subdir as namespace", () => {
    assert.equal(filenameToCommandName("/root/git/commit.md", "/root"), "git/commit");
  });
  it("rejects path traversal", () => {
    assert.equal(filenameToCommandName("/elsewhere/x.md", "/root"), null);
  });
  it("rejects empty stem", () => {
    assert.equal(filenameToCommandName("/root/.md", "/root"), null);
  });
});

describe("loadCustomCommands", () => {
  it("returns empty when no dirs exist", async () => {
    const { cwd, cleanup } = await setup();
    try {
      const r = await loadCustomCommands(cwd);
      assert.equal(r.commands.length, 0);
      assert.equal(r.warnings.length, 0);
    } finally {
      await cleanup();
    }
  });

  it("parses frontmatter and body", async () => {
    const { cwd, cleanup } = await setup();
    try {
      await writeCmd(
        join(cwd, ".kimiflare", "commands"),
        "test.md",
        "---\ndescription: Run tests\nmode: plan\nmodel: foo\neffort: high\n---\nBody here\n",
      );
      const r = await loadCustomCommands(cwd);
      assert.equal(r.commands.length, 1);
      const c = r.commands[0]!;
      assert.equal(c.name, "test");
      assert.equal(c.description, "Run tests");
      assert.equal(c.mode, "plan");
      assert.equal(c.model, "foo");
      assert.equal(c.effort, "high");
      assert.equal(c.source, "project");
      assert.match(c.template, /Body here/);
    } finally {
      await cleanup();
    }
  });

  it("treats agent as alias for mode and maps build->edit", async () => {
    const { cwd, cleanup } = await setup();
    try {
      await writeCmd(
        join(cwd, ".kimiflare", "commands"),
        "x.md",
        "---\nagent: build\n---\nbody\n",
      );
      const r = await loadCustomCommands(cwd);
      assert.equal(r.commands[0]!.mode, "edit");
    } finally {
      await cleanup();
    }
  });

  it("namespaces commands by subdir", async () => {
    const { cwd, cleanup } = await setup();
    try {
      await writeCmd(
        join(cwd, ".kimiflare", "commands"),
        "git/commit.md",
        "---\ndescription: Commit\n---\nbody\n",
      );
      const r = await loadCustomCommands(cwd);
      assert.equal(r.commands[0]!.name, "git/commit");
    } finally {
      await cleanup();
    }
  });

  it("warns on unknown mode and ignores it", async () => {
    const { cwd, cleanup } = await setup();
    try {
      await writeCmd(
        join(cwd, ".kimiflare", "commands"),
        "x.md",
        "---\nmode: nonsense\n---\nbody\n",
      );
      const r = await loadCustomCommands(cwd);
      assert.equal(r.commands[0]!.mode, undefined);
      assert.ok(r.warnings.some((w) => w.includes("unknown mode")));
    } finally {
      await cleanup();
    }
  });

  it("skips files with unclosed frontmatter and warns", async () => {
    const { cwd, cleanup } = await setup();
    try {
      await writeCmd(
        join(cwd, ".kimiflare", "commands"),
        "x.md",
        "---\ndescription: oops\nbody without close\n",
      );
      const r = await loadCustomCommands(cwd);
      assert.equal(r.commands.length, 0);
      assert.ok(r.warnings.some((w) => w.includes("not closed")));
    } finally {
      await cleanup();
    }
  });

  it("project commands override global on name collision", async () => {
    const { cwd, cleanup } = await setup();
    const xdg = await mkdtemp(join(tmpdir(), "kf-loader-xdg-"));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      await writeCmd(join(xdg, "kimiflare", "commands"), "test.md", "---\ndescription: from-global\n---\nGLOBAL\n");
      await writeCmd(join(cwd, ".kimiflare", "commands"), "test.md", "---\ndescription: from-project\n---\nPROJECT\n");
      const r = await loadCustomCommands(cwd);
      const test = r.commands.find((c) => c.name === "test");
      assert.ok(test, "expected test command to load");
      assert.equal(test!.source, "project");
      assert.equal(test!.description, "from-project");
      assert.match(test!.template, /PROJECT/);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      await rm(xdg, { recursive: true, force: true });
      await cleanup();
    }
  });

  it("skips files with unparseable frontmatter lines", async () => {
    const { cwd, cleanup } = await setup();
    try {
      await writeCmd(
        join(cwd, ".kimiflare", "commands"),
        "x.md",
        "---\nthis is not a valid line\n---\nbody\n",
      );
      const r = await loadCustomCommands(cwd);
      assert.equal(r.commands.length, 0);
      assert.ok(r.warnings.some((w) => w.includes("unparseable line")));
    } finally {
      await cleanup();
    }
  });

  it("rejects project commands dir when it is a symlink escaping cwd", async () => {
    const { cwd, cleanup } = await setup();
    const outside = await mkdtemp(join(tmpdir(), "kf-loader-outside-"));
    try {
      await writeCmd(outside, "test.md", "---\ndescription: leaked\n---\nbody\n");
      await mkdir(join(cwd, ".kimiflare"), { recursive: true });
      await symlink(outside, join(cwd, ".kimiflare", "commands"));
      const r = await loadCustomCommands(cwd);
      assert.equal(r.commands.length, 0);
      assert.ok(r.warnings.some((w) => w.includes("escapes workspace")));
    } finally {
      await rm(outside, { recursive: true, force: true });
      await cleanup();
    }
  });

  it("returns commands sorted by name", async () => {
    const { cwd, cleanup } = await setup();
    try {
      const dir = join(cwd, ".kimiflare", "commands");
      await writeCmd(dir, "zebra.md", "x");
      await writeCmd(dir, "alpha.md", "x");
      await writeCmd(dir, "mike.md", "x");
      const r = await loadCustomCommands(cwd);
      assert.deepEqual(
        r.commands.map((c) => c.name),
        ["alpha", "mike", "zebra"],
      );
    } finally {
      await cleanup();
    }
  });

  it("parses shell and files frontmatter flags", async () => {
    const { cwd, cleanup } = await setup();
    try {
      await writeCmd(
        join(cwd, ".kimiflare", "commands"),
        "test.md",
        "---\nshell: true\nfiles: yes\n---\nbody\n",
      );
      const r = await loadCustomCommands(cwd);
      assert.equal(r.commands.length, 1);
      assert.equal(r.commands[0]!.shell, true);
      assert.equal(r.commands[0]!.files, true);
    } finally {
      await cleanup();
    }
  });

  it("warns when template contains ungated shell substitution", async () => {
    const { cwd, cleanup } = await setup();
    try {
      await writeCmd(
        join(cwd, ".kimiflare", "commands"),
        "test.md",
        "---\ndescription: test\n---\nRun !`echo hello`\n",
      );
      const r = await loadCustomCommands(cwd);
      assert.equal(r.commands.length, 1);
      assert.ok(r.warnings.some((w) => w.includes("shell substitution") && w.includes("not set")));
    } finally {
      await cleanup();
    }
  });

  it("warns when template contains ungated file inclusion", async () => {
    const { cwd, cleanup } = await setup();
    try {
      await writeCmd(
        join(cwd, ".kimiflare", "commands"),
        "test.md",
        "---\ndescription: test\n---\nRead @foo.txt\n",
      );
      const r = await loadCustomCommands(cwd);
      assert.equal(r.commands.length, 1);
      assert.ok(r.warnings.some((w) => w.includes("file inclusion") && w.includes("not set")));
    } finally {
      await cleanup();
    }
  });

  it("warns when project command shadows global command", async () => {
    const { cwd, cleanup } = await setup();
    const xdg = await mkdtemp(join(tmpdir(), "kf-loader-xdg-"));
    const prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      await writeCmd(join(xdg, "kimiflare", "commands"), "test.md", "---\ndescription: global\n---\nGLOBAL\n");
      await writeCmd(join(cwd, ".kimiflare", "commands"), "test.md", "---\ndescription: project\n---\nPROJECT\n");
      const r = await loadCustomCommands(cwd);
      assert.equal(r.commands.length, 1);
      assert.ok(r.warnings.some((w) => w.includes("shadows global")));
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
      await rm(xdg, { recursive: true, force: true });
      await cleanup();
    }
  });

  it("reads .autopilot/commands and the legacy .kimiflare/commands; .autopilot wins", async () => {
    const { cwd, cleanup } = await setup();
    try {
      await writeCmd(join(cwd, ".kimiflare", "commands"), "old.md", "OLD\n");
      await writeCmd(join(cwd, ".kimiflare", "commands"), "both.md", "---\ndescription: legacy\n---\nLEGACY\n");
      await writeCmd(join(cwd, ".autopilot", "commands"), "both.md", "---\ndescription: new\n---\nNEW\n");
      const r = await loadCustomCommands(cwd);
      assert.deepEqual(r.commands.map((c) => c.name), ["both", "old"]);
      assert.equal(r.commands[0]!.description, "new");
      assert.equal(r.warnings.length, 0);
    } finally {
      await cleanup();
    }
  });
});
