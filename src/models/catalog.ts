/**
 * Load the model catalog of the active provider (cache-first; public
 * endpoints, no key needed). One entry point for the CLI, SDK and server so
 * the picker, capabilities and pricing always describe the provider in use.
 */

import { providerIdOf, type LlmAuth } from "../agent/llm-auth.js";

export async function ensureCatalogForProvider(auth: LlmAuth): Promise<void> {
  switch (providerIdOf(auth)) {
    case "openrouter": {
      const { ensureOpenRouterCatalog } = await import("./openrouter-catalog.js");
      await ensureOpenRouterCatalog();
      return;
    }
    case "requesty": {
      const { ensureRequestyCatalog } = await import("./requesty-catalog.js");
      await ensureRequestyCatalog();
      return;
    }
    default:
      // Other providers' catalogs: see models.dev loading (#805).
      return;
  }
}
