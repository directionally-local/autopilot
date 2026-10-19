/**
 * Context document generator for `/init`.
 *
 * Replaces the naive single-prompt approach with a structured, multi-phase
 * discovery pipeline that adapts to any project type (Node, Python, Go, Rust,
 * etc.).  The generator itself does not call the LLM; it builds the prompt
 * that is sent to the agent so the agent can use its tools (glob, read, grep,
 * bash) to perform the investigation.
 */

import { existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import type { Task } from "../tools/registry.js";

export type ProjectFlavor =
  | "node"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "java"
  | "dotnet"
  | "php"
  | "elixir"
  | "haskell"
  | "c"
  | "cpp"
  | "zig"
  | "generic";

export interface ProjectProfile {
  flavor: ProjectFlavor;
  primaryLanguage: string;
  packageFile: string | null;
  lockFile: string | null;
  buildFile: string | null;
  testConfig: string | null;
  lintConfig: string | null;
  typeConfig: string | null;
  ciConfig: string | null;
  readme: string | null;
  sourceRoots: string[];
  hasGit: boolean;
}

const FLAVOR_SIGNATURES: Record<ProjectFlavor, string[]> = {
  node: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "node_modules"],
  python: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "poetry.lock", "uv.lock", "tox.ini"],
  go: ["go.mod", "go.sum"],
  rust: ["Cargo.toml", "Cargo.lock"],
  ruby: ["Gemfile", "Gemfile.lock", "*.gemspec"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
  dotnet: ["*.csproj", "*.fsproj", "*.sln"],
  php: ["composer.json", "composer.lock"],
  elixir: ["mix.exs", "mix.lock"],
  haskell: ["package.yaml", "*.cabal", "stack.yaml"],
  c: ["Makefile", "CMakeLists.txt", "configure.ac"],
  cpp: ["Makefile", "CMakeLists.txt", "configure.ac"],
  zig: ["build.zig", "build.zig.zon"],
  generic: [],
};

const SOURCE_ROOT_CANDIDATES = [
  "src",
  "lib",
  "app",
  "source",
  "Sources",
  "pkg",
  "internal",
  "cmd",
  "bin",
  "packages",
  "projects",
];

const CI_PATHS = [
  ".github/workflows",
  ".gitlab-ci.yml",
  ".circleci",
  "azure-pipelines.yml",
  "Jenkinsfile",
  ".buildkite",
  "cloudbuild.yaml",
];

function detectFlavor(cwd: string): ProjectFlavor {
  for (const [flavor, signatures] of Object.entries(FLAVOR_SIGNATURES)) {
    if (flavor === "generic") continue;
    for (const sig of signatures) {
      const path = join(cwd, sig);
      if (sig.includes("*")) {
        // Simple glob check — if any file matches the prefix
        try {
          const parts = sig.split("*");
          const prefix = parts[0] ?? "";
          const suffix = parts[1] ?? "";
          const entries = require("node:fs").readdirSync(cwd);
          if (entries.some((e: string) => e.startsWith(prefix) && e.endsWith(suffix))) {
            return flavor as ProjectFlavor;
          }
        } catch { /* ignore */ }
      } else if (existsSync(path)) {
        return flavor as ProjectFlavor;
      }
    }
  }
  return "generic";
}

function findFile(cwd: string, candidates: string[]): string | null {
  for (const c of candidates) {
    if (existsSync(join(cwd, c))) return c;
  }
  return null;
}

function findSourceRoots(cwd: string): string[] {
  const roots: string[] = [];
  for (const r of SOURCE_ROOT_CANDIDATES) {
    const p = join(cwd, r);
    try {
      const s = statSync(p);
      if (s.isDirectory()) roots.push(r);
    } catch { /* ignore */ }
  }
  return roots;
}

function findCiConfig(cwd: string): string | null {
  for (const c of CI_PATHS) {
    if (existsSync(join(cwd, c))) {
      try {
        const s = statSync(join(cwd, c));
        return s.isDirectory() ? c : c;
      } catch { /* ignore */ }
    }
  }
  return null;
}

function languageForFlavor(f: ProjectFlavor): string {
  const map: Record<ProjectFlavor, string> = {
    node: "JavaScript / TypeScript",
    python: "Python",
    go: "Go",
    rust: "Rust",
    ruby: "Ruby",
    java: "Java / Kotlin",
    dotnet: "C# / F#",
    php: "PHP",
    elixir: "Elixir",
    haskell: "Haskell",
    c: "C",
    cpp: "C++",
    zig: "Zig",
    generic: "Unknown",
  };
  return map[f];
}

export function analyzeProject(cwd: string): ProjectProfile {
  const flavor = detectFlavor(cwd);

  const packageFiles: Record<ProjectFlavor, string[]> = {
    node: ["package.json"],
    python: ["pyproject.toml", "setup.py", "setup.cfg"],
    go: ["go.mod"],
    rust: ["Cargo.toml"],
    ruby: ["Gemfile"],
    java: ["pom.xml", "build.gradle", "build.gradle.kts"],
    dotnet: ["*.csproj"],
    php: ["composer.json"],
    elixir: ["mix.exs"],
    haskell: ["package.yaml", "*.cabal"],
    c: ["Makefile", "CMakeLists.txt"],
    cpp: ["Makefile", "CMakeLists.txt"],
    zig: ["build.zig"],
    generic: [],
  };

  const lockFiles: Record<ProjectFlavor, string[]> = {
    node: ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"],
    python: ["poetry.lock", "uv.lock", "Pipfile.lock"],
    go: ["go.sum"],
    rust: ["Cargo.lock"],
    ruby: ["Gemfile.lock"],
    java: [],
    dotnet: [],
    php: ["composer.lock"],
    elixir: ["mix.lock"],
    haskell: [],
    c: [],
    cpp: [],
    zig: [],
    generic: [],
  };

  const buildFiles: Record<ProjectFlavor, string[]> = {
    node: ["tsup.config.ts", "vite.config.ts", "webpack.config.js", "rollup.config.js", "esbuild.js", "next.config.js", "nuxt.config.ts", "astro.config.mjs", "svelte.config.js"],
    python: ["setup.py", "setup.cfg", "pyproject.toml"],
    go: ["Makefile"],
    rust: ["Cargo.toml"],
    ruby: ["Rakefile"],
    java: ["pom.xml", "build.gradle"],
    dotnet: ["*.sln"],
    php: [],
    elixir: ["mix.exs"],
    haskell: ["package.yaml", "*.cabal"],
    c: ["Makefile", "CMakeLists.txt"],
    cpp: ["Makefile", "CMakeLists.txt"],
    zig: ["build.zig"],
    generic: [],
  };

  const testConfigs: Record<ProjectFlavor, string[]> = {
    node: ["vitest.config.ts", "jest.config.js", "playwright.config.ts", "cypress.config.ts", "ava.config.js"],
    python: ["pytest.ini", "tox.ini", "setup.cfg"],
    go: [],
    rust: [],
    ruby: ["Rakefile", "spec_helper.rb"],
    java: [],
    dotnet: [],
    php: ["phpunit.xml"],
    elixir: ["test/test_helper.exs"],
    haskell: [],
    c: ["Makefile"],
    cpp: ["Makefile"],
    zig: [],
    generic: [],
  };

  const lintConfigs: Record<ProjectFlavor, string[]> = {
    node: [".eslintrc", ".eslintrc.js", ".eslintrc.json", ".prettierrc", "biome.json", "deno.json"],
    python: [".flake8", "pyproject.toml", "setup.cfg", ".pylintrc", "ruff.toml"],
    go: [],
    rust: ["rustfmt.toml", "clippy.toml"],
    ruby: [".rubocop.yml"],
    java: [],
    dotnet: [],
    php: [],
    elixir: [".formatter.exs"],
    haskell: [],
    c: [".clang-format", ".clang-tidy"],
    cpp: [".clang-format", ".clang-tidy"],
    zig: [],
    generic: [],
  };

  const typeConfigs: Record<ProjectFlavor, string[]> = {
    node: ["tsconfig.json", "jsconfig.json"],
    python: ["pyproject.toml", "setup.cfg", "mypy.ini"],
    go: [],
    rust: [],
    ruby: [],
    java: [],
    dotnet: [],
    php: [],
    elixir: [],
    haskell: [],
    c: [],
    cpp: [],
    zig: [],
    generic: [],
  };

  return {
    flavor,
    primaryLanguage: languageForFlavor(flavor),
    packageFile: findFile(cwd, packageFiles[flavor]),
    lockFile: findFile(cwd, lockFiles[flavor]),
    buildFile: findFile(cwd, buildFiles[flavor]),
    testConfig: findFile(cwd, testConfigs[flavor]),
    lintConfig: findFile(cwd, lintConfigs[flavor]),
    typeConfig: findFile(cwd, typeConfigs[flavor]),
    ciConfig: findCiConfig(cwd),
    readme: findFile(cwd, ["README.md", "README.rst", "README.txt", "Readme.md"]),
    sourceRoots: findSourceRoots(cwd),
    hasGit: existsSync(join(cwd, ".git")),
  };
}

function bashDiscoveryCommands(profile: ProjectProfile): string[] {
  const cmds: string[] = [];

  if (profile.hasGit) {
    cmds.push(
      "git log --oneline -20",
      "git branch -a | head -20",
    );
  }

  switch (profile.flavor) {
    case "node":
      cmds.push(
        "cat package.json | jq -r '.scripts | to_entries[] | \"\\(.key): \\(.value)\"' 2>/dev/null || node -e \"const p=require('./package.json'); Object.entries(p.scripts||{}).forEach(([k,v])=>console.log(k+': '+v))\"",
        "ls -la node_modules/.bin 2>/dev/null | head -30 || true",
      );
      break;
    case "python":
      cmds.push(
        "python -c \"import tomllib; f=open('pyproject.toml','rb'); d=tomllib.load(f); [print(f'{k}: {v}') for k,v in d.get('project',{}).get('scripts',{}).items()]\" 2>/dev/null || true",
        "make -p 2>/dev/null | grep -E '^[a-zA-Z_-]+:.*$' | head -20 || true",
      );
      break;
    case "go":
      cmds.push("go help 2>/dev/null | head -10 || true");
      break;
    case "rust":
      cmds.push("cargo --list 2>/dev/null | head -20 || true");
      break;
    case "ruby":
      cmds.push("bundle exec rake -T 2>/dev/null | head -20 || true");
      break;
    case "java":
      cmds.push("./mvnw help:describe -Dplugin=help 2>/dev/null | head -10 || true");
      break;
  }

  // Generic: list top-level dirs and key files
  cmds.push("ls -la");

  return cmds;
}

function discoveryChecklist(profile: ProjectProfile): string {
  const lines: string[] = [];

  lines.push("## PHASE 1: Project Identity & Configuration");
  lines.push("");

  if (profile.readme) {
    lines.push(`- [ ] Read \`${profile.readme}\` — extract project name, description, purpose.`);
  }
  if (profile.packageFile) {
    lines.push(`- [ ] Read \`${profile.packageFile}\` — extract dependencies, scripts, metadata.`);
  }
  if (profile.buildFile) {
    lines.push(`- [ ] Read \`${profile.buildFile}\` — understand build system and entry points.`);
  }
  if (profile.typeConfig) {
    lines.push(`- [ ] Read \`${profile.typeConfig}\` — note strictness, target, module system.`);
  }
  if (profile.testConfig) {
    lines.push(`- [ ] Read \`${profile.testConfig}\` — understand test runner and conventions.`);
  }
  if (profile.lintConfig) {
    lines.push(`- [ ] Read \`${profile.lintConfig}\` — note style rules and formatter.`);
  }
  if (profile.ciConfig) {
    lines.push(`- [ ] Inspect CI config in \`${profile.ciConfig}\` — note checks, matrix, deployment.`);
  }

  lines.push("");
  lines.push("## PHASE 2: Source Structure Discovery");
  lines.push("");

  for (const root of profile.sourceRoots) {
    lines.push(`- [ ] Use \`glob\` to list files in \`${root}/**/*\` (limit to ~50 files).`);
    lines.push(`- [ ] Read 3-5 representative files from \`${root}\` to understand code patterns.`);
  }

  if (profile.sourceRoots.length === 0) {
    lines.push("- [ ] Use `glob` to find source files (`**/*.{js,ts,py,go,rs,rb,java,cs,php,ex,hs,c,cpp,zig}`) — list top 50.");
    lines.push("- [ ] Read 3-5 representative source files to understand code patterns.");
  }

  lines.push("- [ ] Use `glob` to find test files and note their location/naming pattern.");
  lines.push("- [ ] Use `glob` to find config files at root level.");

  lines.push("");
  lines.push("## PHASE 3: Convention Extraction");
  lines.push("");
  lines.push("- [ ] Use `grep` to find import patterns (e.g., `import .* from` or `require(`).");
  lines.push("- [ ] Use `grep` to find export patterns (e.g., `export ` or `module.exports`).");
  lines.push("- [ ] Check for any `.editorconfig`, `.gitignore`, or `CONTRIBUTING.md`.");

  if (profile.hasGit) {
    lines.push("- [ ] Run `git log --oneline -20` to understand commit style and recent activity.");
    lines.push("- [ ] Run `git branch -a | head -20` to understand branching strategy.");
  }

  lines.push("");
  lines.push("## PHASE 4: Build & Development Workflow");
  lines.push("");

  const bashCmds = bashDiscoveryCommands(profile);
  for (const cmd of bashCmds) {
    lines.push(`- [ ] Run \`bash\` with: \`${cmd}\``);
  }

  lines.push("");
  lines.push("## PHASE 5: Architecture & Patterns (Deep Dive)");
  lines.push("");
  lines.push("- [ ] Identify the main entry point(s) of the application.");
  lines.push("- [ ] Identify the testing framework and how tests are organized.");
  lines.push("- [ ] Look for any architectural patterns: MVC, hexagonal, actor model, etc.");
  lines.push("- [ ] Note any code-generation, build-time transforms, or code-mod tools.");
  lines.push("- [ ] Check for Docker, docker-compose, or deployment configs.");
  lines.push("- [ ] Note any monorepo patterns (workspaces, turborepo, nx, etc.).");

  return lines.join("\n");
}

function sectionTemplate(): string {
  return `
Generate the context document with these sections. Be concise but comprehensive.
Aim for 100–200 lines total. Use markdown tables where they save space.

### Required Sections

1. **Project** — One-line description + primary language/runtime + key frameworks.

2. **Build / test / run** — Exact shell commands. Include:
   - Development server / watch mode
   - Production build
   - Test commands (unit, integration, e2e if separate)
   - Lint / format commands
   - Type-checking commands
   - Any setup / install commands
   Note which commands are slow or require special setup.

3. **Layout** — Table of key directories AND a one-sentence rationale for each.
   Explain *why* things live where they do, not just *what* is there.

4. **Conventions** — Cover:
   - Naming conventions (files, variables, types, tests)
   - Import style and path resolution quirks
   - File organization patterns
   - Commit message style (if discernible from git history)
   - Branching strategy
   - TypeScript / type system strictness rules
   - Testing conventions (naming, location, mocks)
   - Anything surprising or non-obvious

5. **Dependencies** — Rules for adding dependencies:
   - Package manager commands
   - Dev vs runtime dependency conventions
   - Native deps that must stay external (if bundling)
   - Version pinning policy

6. **Do / Don't** — Numbered list of hard rules:
   - Security rules (never commit secrets, etc.)
   - Performance rules (don't bundle X, etc.)
   - Style rules that aren't caught by linters
   - Common mistakes to avoid
   - Anything that would make a maintainer sad

7. **Debugging & Troubleshooting** — Common issues:
   - How to run in debug mode
   - Common build failures and fixes
   - How to reset / clean the project
   - Where logs live

8. **Architecture Notes** (if applicable) — Brief notes on:
   - Key abstractions and their responsibilities
   - Data flow
   - External integrations
   - State management approach
`.trim();
}

export interface InitPromptResult {
  prompt: string;
  targetFilename: string;
  isRefresh: boolean;
  tasks: Task[];
}

export function buildInitTasks(targetFilename: string): Task[] {
  return [
    { id: "identity", title: "Inspect project identity and configuration", status: "in_progress" },
    { id: "structure", title: "Discover source structure, tests, and conventions", status: "pending" },
    { id: "workflow", title: "Identify build and development workflows", status: "pending" },
    { id: "architecture", title: "Map architecture and project patterns", status: "pending" },
    { id: "write", title: "Write or refresh " + targetFilename, status: "pending" },
    { id: "verify", title: "Re-read and verify " + targetFilename, status: "pending" },
  ];
}

export function buildInitPrompt(cwd: string): InitPromptResult {
  const existingName = ["AGENTS.md", "KIMI.md", "KIMIFLARE.md", "AGENT.md"].find((n) =>
    existsSync(join(cwd, n))
  );
  const isRefresh = existingName !== undefined;
  const targetFilename = existingName ?? "AGENTS.md";

  const profile = analyzeProject(cwd);
  const checklist = discoveryChecklist(profile);
  const sections = sectionTemplate();
  const tasks = buildInitTasks(targetFilename);

  const promptParts = [
    isRefresh
      ? `Regenerate \`${targetFilename}\` at the repository root to refresh project context. The file already exists — read it first and preserve anything still accurate, updating only what has changed or is missing.`
      : `Generate a \`${targetFilename}\` at the repository root so future agents have comprehensive project context.`,
    "",
    "This is a **structured investigation**. Follow the checklist below systematically. Use the `glob`, `read`, `grep`, and `bash` tools to gather information. Do not skip steps.",
    `Visible task list (already initialized in the UI; keep these IDs and titles):\n${tasks.map((task) => "- " + task.id + ": " + task.status + ": " + task.title).join("\n")}`,
    "Keep the visible task checklist synchronized with your progress using `tasks_set`: update the current phase and mark the next phase active before moving on. Map the detailed checklist below onto these high-level tasks.",
    "",
    `**Detected project profile:** ${profile.primaryLanguage} (${profile.flavor})`,
    profile.packageFile ? `- Package file: ${profile.packageFile}` : null,
    profile.buildFile ? `- Build file: ${profile.buildFile}` : null,
    profile.testConfig ? `- Test config: ${profile.testConfig}` : null,
    profile.typeConfig ? `- Type config: ${profile.typeConfig}` : null,
    profile.lintConfig ? `- Lint config: ${profile.lintConfig}` : null,
    profile.ciConfig ? `- CI config: ${profile.ciConfig}` : null,
    profile.sourceRoots.length > 0 ? `- Source roots: ${profile.sourceRoots.join(", ")}` : null,
    profile.hasGit ? `- Git repository: yes` : null,
    "",
    "---",
    "",
    checklist,
    "",
    "---",
    "",
    sections,
    "",
    isRefresh
      ? `After writing the file, re-read \`${targetFilename}\` and verify it is complete and accurate.`
      : "After writing the file, re-read it and verify all sections are present and accurate.",
    "",
    "The visible task checklist is already initialized. Mark investigation phases complete as you finish them, and complete the write and verification tasks only after re-reading the generated file.",
  ];

  const prompt = promptParts.filter((p): p is string => p !== null).join("\n");

  return { prompt, targetFilename, isRefresh, tasks };
}
