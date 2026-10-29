import type { ToolSpec } from "./registry.js";
import { modelProfileFor } from "../models/profile.js";
import { strictEditParameters } from "./edit.js";

/**
 * Apply a model profile's tool-schema variants (#999). Only the definitions
 * sent to the model change; the tool implementations and the module-level
 * `ALL_TOOLS` stay as they are, so session_start's schema hash reflects what
 * the model actually saw.
 */
export function applyToolProfile(tools: ToolSpec[], modelId: string | undefined | null): ToolSpec[] {
  const profile = modelProfileFor(modelId);
  if (!profile?.strictEditSchema) return tools;
  return tools.map((tool) => (tool.name === "edit" ? { ...tool, parameters: strictEditParameters } : tool));
}
