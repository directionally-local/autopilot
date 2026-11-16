import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.tsx",
    "sdk/index": "src/sdk/index.ts",
    secrets: "src/secrets.ts",
    // Code Mode's sandbox host: forked as its own process (dist/sandbox-host.js),
    // so a native crash in isolated-vm cannot take Autopilot down.
    "sandbox-host": "src/code-mode/sandbox-host.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  dts: true,
  splitting: false,
  shims: false,
  minify: false,
  banner: { js: "" },
  external: [
    // keep runtime deps out of the bundle so they resolve from node_modules
    "ink",
    "react",
    "commander",
    "turndown",
    "camouflage-tui",
    "@resvg/resvg-js",
    // Native optional dependency: bundling it inlines node-gyp-build, whose
    // dynamic require() throws in the ESM bundle and silently disables the
    // secure sandbox.
    "isolated-vm",
  ],
});
