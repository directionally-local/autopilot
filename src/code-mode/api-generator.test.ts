import { describe, it } from "node:test";
import assert from "node:assert";
import { generateTypeScriptApi } from "./api-generator.js";
import type { ToolSpec } from "../tools/registry.js";

function makeTool(name: string, description: string, properties?: Record<string, unknown>, required?: string[]): ToolSpec {
  return {
    name,
    description,
    parameters: properties ? { type: "object", properties, required } : { type: "object" },
    needsPermission: false,
    run: async () => "",
  };
}

describe("generateTypeScriptApi", () => {
  it("produces identical output for the same tools in different property-key order", () => {
    const toolsA: ToolSpec[] = [
      makeTool("read", "Read a file.", {
        z: { type: "string", description: "Z field" },
        a: { type: "number", description: "A field" },
        m: { type: "boolean", description: "M field" },
      }, ["z", "a"]),
      makeTool("write", "Write a file.", {
        path: { type: "string" },
        content: { type: "string" },
      }, ["path", "content"]),
    ];

    const toolsB: ToolSpec[] = [
      makeTool("read", "Read a file.", {
        a: { type: "number", description: "A field" },
        m: { type: "boolean", description: "M field" },
        z: { type: "string", description: "Z field" },
      }, ["a", "z"]),
      makeTool("write", "Write a file.", {
        content: { type: "string" },
        path: { type: "string" },
      }, ["content", "path"]),
    ];

    const outA = generateTypeScriptApi(toolsA);
    const outB = generateTypeScriptApi(toolsB);
    assert.strictEqual(outA, outB);
  });

  it("produces identical output when called twice with the same tools", () => {
    const tools: ToolSpec[] = [
      makeTool("grep", "Search files.", {
        pattern: { type: "string" },
        path: { type: "string" },
      }),
    ];

    const out1 = generateTypeScriptApi(tools);
    const out2 = generateTypeScriptApi(tools);
    assert.strictEqual(out1, out2);
  });

  it("sorts tools by name for stable output", () => {
    const toolsA: ToolSpec[] = [
      makeTool("z_last", "Z tool."),
      makeTool("a_first", "A tool."),
    ];
    const toolsB: ToolSpec[] = [
      makeTool("a_first", "A tool."),
      makeTool("z_last", "Z tool."),
    ];

    const outA = generateTypeScriptApi(toolsA);
    const outB = generateTypeScriptApi(toolsB);
    assert.strictEqual(outA, outB);
  });

  it("generates expected declarations for a simple tool", () => {
    const tools: ToolSpec[] = [
      makeTool("read", "Read a file.", {
        path: { type: "string", description: "File path" },
      }, ["path"]),
    ];

    const out = generateTypeScriptApi(tools);
    assert.ok(out.includes("interface read_Input {"));
    assert.ok(out.includes("  path: string;"));
    assert.ok(out.includes("read(input: read_Input): Promise<string>;"));
  });

  it("handles tools with no parameters", () => {
    const tools: ToolSpec[] = [makeTool("exit", "Exit the app.")];
    const out = generateTypeScriptApi(tools);
    assert.ok(out.includes("exit(): Promise<string>;"));
    assert.ok(!out.includes("interface exit_Input"));
  });

  it("notes that mutating tools reject on failure and leaves read-only tools unchanged", () => {
    const params = { path: { type: "string" } };
    const write = { ...makeTool("write", "Write a file.", params, ["path"]), isReadOnly: false };
    const read = { ...makeTool("read", "Read a file.", params, ["path"]), isReadOnly: true };
    const out = generateTypeScriptApi([write, read]);
    const note = "Rejects with the tool's error if the call fails (e.g. permission denied).";
    const writeDocs = out.slice(out.indexOf("   * Write a file."), out.indexOf("write(input:"));
    const readDocs = out.slice(out.indexOf("   * Read a file."), out.indexOf("read(input:"));
    assert.ok(writeDocs.includes(note));
    assert.ok(!readDocs.includes(note));
  });

  it("handles nested object properties in sorted order", () => {
    const tools: ToolSpec[] = [
      makeTool("complex", "Complex tool.", {
        config: {
          type: "object",
          properties: {
            z: { type: "string" },
            a: { type: "number" },
          },
        },
      }),
    ];

    const out = generateTypeScriptApi(tools);
    const configIndex = out.indexOf("config");
    const aIndex = out.indexOf("a?:");
    const zIndex = out.indexOf("z?:");
    assert.ok(configIndex !== -1);
    assert.ok(aIndex !== -1);
    assert.ok(zIndex !== -1);
    assert.ok(aIndex < zIndex, "nested properties should be sorted alphabetically");
  });
});
