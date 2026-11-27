import type { ToolSpec } from "../tools/registry.js";

interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  additionalProperties?: boolean | JsonSchemaProperty;
}

function schemaToTsType(prop: JsonSchemaProperty | undefined, required = true): string {
  if (!prop) return "unknown";

  const types: string[] = [];

  if (prop.type === "string") {
    if (prop.enum && prop.enum.length > 0) {
      types.push(prop.enum.map((e) => (typeof e === "string" ? `"${e}"` : String(e))).join(" | "));
    } else {
      types.push("string");
    }
  } else if (prop.type === "integer" || prop.type === "number") {
    types.push("number");
  } else if (prop.type === "boolean") {
    types.push("boolean");
  } else if (prop.type === "array") {
    const itemType = schemaToTsType(prop.items, true);
    types.push(`${itemType}[]`);
  } else if (prop.type === "object") {
    if (prop.properties && Object.keys(prop.properties).length > 0) {
      const entries = Object.entries(prop.properties)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => {
          const isReq = prop.required?.includes(key) ?? false;
          return `  ${key}${isReq ? "" : "?"}: ${schemaToTsType(val, isReq)};`;
        })
        .join("\n");
      types.push(`{\n${entries}\n}`);
    } else {
      types.push("Record<string, unknown>");
    }
  } else if (Array.isArray(prop.type)) {
    for (const t of prop.type) {
      types.push(schemaToTsType({ type: t }, true));
    }
  } else {
    types.push("unknown");
  }

  const result = types.join(" | ");
  return required ? result : `${result} | undefined`;
}

function generateInterface(name: string, properties: Record<string, JsonSchemaProperty>, required: string[] = []): string {
  const entries = Object.entries(properties)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => {
      const isReq = required.includes(key);
      return `  ${key}${isReq ? "" : "?"}: ${schemaToTsType(val, isReq)};`;
    })
    .join("\n");
  return `interface ${name} {\n${entries}\n}`;
}

function sanitizeTypeName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^[0-9]/, "_$&")
    .replace(/_+/g, "_");
}

export function generateTypeScriptApi(tools: ToolSpec[]): string {
  const lines: string[] = [];
  lines.push("// Available APIs for Code Mode");
  lines.push("// Use these functions to interact with the system.");
  lines.push("// Only console.log() output will be returned to the agent.");
  lines.push("");

  const inputInterfaces: string[] = [];
  const outputInterfaces: string[] = [];
  const methodEntries: string[] = [];

  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const baseName = sanitizeTypeName(tool.name);
    const inputName = `${baseName}_Input`;
    const outputName = `${baseName}_Output`;

    const params = tool.parameters as {
      type?: string;
      properties?: Record<string, JsonSchemaProperty>;
      required?: string[];
    };

    const sortedPropKeys = params.properties ? Object.keys(params.properties).sort((a, b) => a.localeCompare(b)) : [];
    const failureNote =
      tool.isReadOnly === true ? null : "Rejects with the tool's error if the call fails (e.g. permission denied).";
    if (sortedPropKeys.length > 0 && params.properties) {
      inputInterfaces.push(generateInterface(inputName, params.properties, [...(params.required ?? [])].sort((a, b) => a.localeCompare(b))));
      inputInterfaces.push("");
      methodEntries.push(`  /**`);
      methodEntries.push(`   * ${tool.description.replace(/\n/g, "\n   * ")}`);
      if (failureNote) methodEntries.push(`   * ${failureNote}`);
      methodEntries.push(`   */`);
      methodEntries.push(`  ${tool.name}(input: ${inputName}): Promise<string>;`);
    } else {
      methodEntries.push(`  /**`);
      methodEntries.push(`   * ${tool.description.replace(/\n/g, "\n   * ")}`);
      if (failureNote) methodEntries.push(`   * ${failureNote}`);
      methodEntries.push(`   */`);
      methodEntries.push(`  ${tool.name}(): Promise<string>;`);
    }
    methodEntries.push("");
  }

  lines.push(...inputInterfaces);
  lines.push("declare const api: {");
  lines.push(...methodEntries.map((l) => (l ? `  ${l}` : "  ")));
  lines.push("};");

  return lines.join("\n");
}
