import { describe, it } from "node:test";
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { resolveTurnCodeMode } from "./agent/turn-code-mode.js";
import { createQueueBatch } from "./agent/queue-batch.js";
import { replaceQueuedPrompt, replaceUserPromptEvent } from "./ui/app-helpers.js";
import type { ChatEvent } from "./ui/view-types.js";

describe("interactive Code Mode wiring", () => {
  it("passes the configured decision to the turn and status state, not the raw tier", async () => {
    // Inspect the real app without mounting the renderer or running startup I/O.
    // assembleTurn's host options are the options consumed by runAgentTurn.
    const source = ts.createSourceFile("app.tsx", await readFile(new URL("./app.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const nodes: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      nodes.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const isIdentifier = (node: ts.Node | undefined, name: string): node is ts.Identifier =>
      node !== undefined && ts.isIdentifier(node) && node.text === name;
    const imports = nodes.filter(ts.isImportDeclaration).filter((node) =>
      ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./agent/turn-code-mode.js");
    assert.strictEqual(imports.length, 1);
    const bindings = imports[0]!.importClause?.namedBindings;
    assert.ok(bindings && ts.isNamedImports(bindings));
    const policyImport = bindings.elements.find((node) => (node.propertyName ?? node.name).text === "resolveTurnCodeMode");
    assert.ok(policyImport);

    // Resolve identifiers to declarations, rather than pinning the local's spelling
    // (or accepting an unrelated same-named variable from another scope).
    const compilerHost = ts.createCompilerHost({ noResolve: true });
    compilerHost.getSourceFile = (fileName) => fileName === source.fileName ? source : undefined;
    const checker = ts.createProgram([source.fileName], { noResolve: true, noLib: true }, compilerHost).getTypeChecker();
    const policySymbol = checker.getSymbolAtLocation(policyImport.name);
    assert.ok(policySymbol);
    const decisions = nodes.filter(ts.isVariableDeclaration).filter((node) =>
      node.initializer && ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      checker.getSymbolAtLocation(node.initializer.expression) === policySymbol);
    assert.strictEqual(decisions.length, 1, "the app must compute its decision through resolveTurnCodeMode");
    const decision = decisions[0]!;
    assert.ok(ts.isIdentifier(decision.name));
    const decisionSymbol = checker.getSymbolAtLocation(decision.name);
    assert.ok(decisionSymbol);
    const call = decision.initializer;
    assert.ok(call && ts.isCallExpression(call));
    assert.strictEqual(call.arguments.length, 2);
    const [configured, tier] = call.arguments;
    assert.ok(configured && ts.isPropertyAccessExpression(configured));
    assert.ok(isIdentifier(configured.expression, "cfg"));
    assert.strictEqual(configured.name.text, "codeMode");
    assert.ok(configured.questionDotToken);
    assert.ok(tier && ts.isPropertyAccessExpression(tier));
    assert.ok(isIdentifier(tier.expression, "classification"));
    assert.strictEqual(tier.name.text, "tier");

    const starts = nodes.filter(ts.isCallExpression).filter((node) =>
      ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "startTurn");
    assert.strictEqual(starts.length, 1);
    const assembled = starts[0]!.arguments[0];
    assert.ok(assembled && ts.isCallExpression(assembled));
    assert.ok(isIdentifier(assembled.expression, "assembleTurn"));
    const options = assembled.arguments[0];
    assert.ok(options && ts.isObjectLiteralExpression(options));
    const property = (object: ts.ObjectLiteralExpression, name: string): ts.Expression => {
      const matches = object.properties.filter(ts.isPropertyAssignment).filter((node) =>
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === name);
      assert.strictEqual(matches.length, 1, `expected one ${name} option`);
      return matches[0]!.initializer;
    };
    const host = property(options, "host");
    assert.ok(ts.isObjectLiteralExpression(host));
    const codeMode = property(host, "codeMode");
    assert.ok(ts.isIdentifier(codeMode), "host codeMode must use the resolved decision, not the raw tier");
    assert.strictEqual(checker.getSymbolAtLocation(codeMode), decisionSymbol, "host codeMode must reference the policy-bound variable");
    // Ignore lifecycle resets in nested callbacks; check this turn's setter.
    const decisionBlock = decision.parent.parent.parent;
    const setters = nodes.filter(ts.isCallExpression).filter((node) =>
      isIdentifier(node.expression, "setCodeMode") && node.parent.parent === decisionBlock);
    assert.strictEqual(setters.length, 1);
    const status = setters[0]!.arguments[0];
    assert.ok(status && ts.isIdentifier(status));
    assert.strictEqual(checker.getSymbolAtLocation(status), decisionSymbol, "status must reference the same policy-bound variable");

    // The checked initializer consumes cfg.codeMode and classification.tier;
    // both option/state identifiers resolve to that declaration. Substitute the
    // configured-false heavy-turn inputs into the real policy, not a raw-tier rule.
    assert.strictEqual(resolveTurnCodeMode(false, "heavy"), false, "assembleTurn's policy-bound host option is false on a disabled heavy turn");
  });
});

describe("prompt editing", () => {
  it("replaces a queued prompt instead of adding another item", () => {
    const queue = [
      { key: "prompt-1", full: "original", display: "original" },
      { key: "prompt-2", full: "follow-up", display: "follow-up" },
    ];
    const edited = replaceQueuedPrompt(queue, "prompt-1", "amended", "amended");
    assert.deepStrictEqual(edited, [
      { key: "prompt-1", full: "amended", display: "amended" },
      { key: "prompt-2", full: "follow-up", display: "follow-up" },
    ]);
    assert.strictEqual(replaceQueuedPrompt(queue, "missing", "text", "text"), null);
  });

  it("rebuilds a grouped queue batch when one of its prompts is edited", () => {
    const batch = createQueueBatch([
      { key: "prompt-1", full: "first", display: "first" },
      { key: "prompt-2", full: "second", display: "second" },
    ])!;
    const edited = replaceQueuedPrompt([batch], "prompt-2", "amended second", "amended second");
    assert.deepStrictEqual(edited?.[0]?.batchPrompts, ["first", "amended second"]);
    assert.deepStrictEqual(edited?.[0]?.sourceKeys, ["prompt-1", "prompt-2"]);
  });

  it("replaces a submitted prompt and drops its old output while retaining queued follow-ups", () => {
    const events: ChatEvent[] = [
      { kind: "user", key: "prompt-1", text: "original" },
      { kind: "info", key: "turn-output", text: "old response metadata" },
      { kind: "user", key: "prompt-2", text: "follow-up", queued: true },
    ];
    const edited = replaceUserPromptEvent(events, "prompt-1", "amended", true);
    assert.deepStrictEqual(edited, [
      { kind: "user", key: "prompt-1", text: "amended", images: undefined },
      { kind: "user", key: "prompt-2", text: "follow-up", queued: true },
    ]);
  });
});
