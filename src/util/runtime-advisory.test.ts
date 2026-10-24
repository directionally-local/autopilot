import { describe, it } from "node:test";
import assert from "node:assert";
import { brotliRuntimeAdvisory } from "./runtime-advisory.js";

const node = (version: string) => ({ ...process.versions, node: version }) as NodeJS.ProcessVersions;

describe("brotliRuntimeAdvisory (CVE-2026-111497)", () => {
  it("flags Node lines before their fix and lines that get none", () => {
    for (const v of ["20.19.5", "22.23.3", "22.22.0", "23.11.1", "24.22.0", "25.9.0", "26.12.0", "18.20.8"]) {
      assert.match(brotliRuntimeAdvisory(node(v)) ?? "", /CVE-2026-111497/, v);
    }
    assert.match(brotliRuntimeAdvisory(node("20.19.5")) ?? "", /gets no fix/);
    assert.match(brotliRuntimeAdvisory(node("24.22.0")) ?? "", /24\.22\.1/);
  });

  it("passes fixed and newer Node versions", () => {
    for (const v of ["22.23.4", "22.24.0", "24.22.1", "24.23.0", "26.12.1", "27.0.0"]) {
      assert.equal(brotliRuntimeAdvisory(node(v)), null, v);
    }
  });

  it("checks Bun by its own version", () => {
    const bun = (version: string) => ({ ...node("24.3.0"), bun: version }) as NodeJS.ProcessVersions;
    assert.match(brotliRuntimeAdvisory(bun("1.4.3")) ?? "", /Bun 1\.4\.4/);
    assert.equal(brotliRuntimeAdvisory(bun("1.4.4")), null);
    assert.equal(brotliRuntimeAdvisory(bun("1.5.0")), null);
  });
});
