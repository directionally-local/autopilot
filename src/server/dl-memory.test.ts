import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DlMemory } from "./dl-memory.js";

/** A fake OpenRouter that replies with the queued extraction results and records prompts. */
function fakeModel(replies: unknown[]) {
  const prompts: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    prompts.push(body.messages[1]!.content);
    const reply = replies.shift() ?? { upserts: [], deletes: [], session: null };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, prompts };
}

function withMemory(replies: unknown[], run: (memory: DlMemory, prompts: string[]) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "dl-memory-"));
    const { fetchImpl, prompts } = fakeModel(replies);
    const memory = new DlMemory(join(dir, "dl.db"), { apiKey: "test", fetchImpl, model: "test/model" });
    try {
      await run(memory, prompts);
    } finally {
      memory.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("dl server memory", () => {
  it("keeps people and projects as cards that are updated in place, plus facts and chat summaries", withMemory([
    {
      upserts: [
        { kind: "person", key: "person:sara-ahmadi", title: "Sara Ahmadi", content: "Founder of Lumen Studio; the user's new freelance client.", pinned: false },
        { kind: "project", key: "project:lumen-site", title: "Lumen site", content: "Marketing site redesign for Lumen Studio, client Sara Ahmadi.", pinned: false },
        { kind: "fact", title: "Freelancing", content: "The user started freelancing in October 2026.", pinned: false },
      ],
      session: { title: "New freelance gig with Lumen", summary: "Brainstormed the Lumen site scope." },
    },
    {
      upserts: [
        { kind: "project", key: "Project:Lumen Site", title: "Lumen site", content: "Marketing site redesign for Lumen Studio (client Sara Ahmadi). Chose Astro + Tailwind; launch in November.", pinned: false },
        { kind: "fact", title: "Prefers PDFs", content: "Prefers slides delivered as PDF.", pinned: true },
        { kind: "fact", title: "Leaked", content: "key is sk-or-v1-0123456789abcdef0123456789abcdef", pinned: true },
      ],
      session: { title: "New freelance gig with Lumen", summary: "Picked Astro + Tailwind for the Lumen site." },
    },
  ], async (memory, prompts) => {
    const first = await memory.remember({ conversationId: "c1", userText: "I got a freelance job with Sara from Lumen Studio", assistantText: "Congrats!" });
    assert.deepEqual(first.map((change) => `${change.kind}:${change.change}`), ["person:added", "project:added", "fact:added"]);

    const second = await memory.remember({ conversationId: "c1", userText: "let's use Astro. remember I prefer PDFs", assistantText: "Noted." });
    assert.deepEqual(second.map((change) => `${change.kind}:${change.change}`), ["project:updated", "fact:added"], "the leaked key is never stored");
    assert.match(prompts[1]!, /person:sara-ahmadi/, "extraction sees current memory");

    const projects = memory.list("project");
    assert.equal(projects.length, 1, "same key, normalized, updates the card instead of duplicating it");
    assert.match(projects[0]!.content, /Astro/);
    assert.equal(memory.list("session").length, 1);
    assert.match(memory.list("session")[0]!.content, /Astro/);

    const pinned = memory.list("fact").find((fact) => fact.pinned)!;
    assert.match(pinned.content, /PDF/);
    assert.ok(!JSON.stringify(memory.list()).includes("sk-or-v1-"));
  }));

  it("never deletes pinned items on the model's say-so", withMemory([
    { upserts: [{ kind: "fact", title: "Pinned", content: "Remember: my dog is Miso.", pinned: true }] },
  ], async (memory) => {
    await memory.remember({ conversationId: "c1", userText: "remember my dog is Miso", assistantText: "ok" });
    const id = memory.list("fact")[0]!.id;
    const { fetchImpl } = fakeModel([{ deletes: [id] }]);
    const other = new DlMemory(undefined as never, { apiKey: "x", fetchImpl });
    other.close();
    // Direct check through a second extraction on the same store.
    (memory as unknown as { options: { fetchImpl: typeof fetch } }).options.fetchImpl = fetchImpl;
    const changes = await memory.remember({ conversationId: "c2", userText: "whatever", assistantText: "ok" });
    assert.deepEqual(changes, []);
    assert.equal(memory.list("fact").length, 1);
  }));

  it("briefs a new chat once, then only adds newly mentioned cards", withMemory([], async (memory) => {
    const tick = () => new Promise((resolve) => setTimeout(resolve, 3));
    // Omid is the oldest card, so he is neither mentioned nor among the most recent ones.
    memory.upsert({ kind: "person", key: "person:omid-k", title: "Omid K", content: "Designer friend." });
    await tick();
    memory.upsert({ kind: "fact", title: "Freelancing", content: "The user freelances.", pinned: true });
    memory.upsert({ kind: "person", key: "person:sara-ahmadi", title: "Sara Ahmadi", content: "Client at Lumen Studio." });
    await tick();
    memory.upsert({ kind: "project", key: "project:lumen-site", title: "Lumen site", content: "Site redesign for Sara." });
    await tick();
    memory.upsert({ kind: "project", key: "project:aster", title: "Aster", content: "The user's iOS app." });
    await tick();
    memory.upsert({ kind: "project", key: "project:tea-shop", title: "Tea shop", content: "Side project." });
    memory.upsert({ kind: "session", key: "older-chat", title: "Lumen kickoff", content: "Scoped the Lumen site." });

    const brief = memory.brief("c-new", "what should I send Sara this week?");
    assert.match(brief, /The user freelances/);
    assert.match(brief, /Sara Ahmadi \(person\): Client at Lumen Studio/);
    assert.match(brief, /Recent chats:\n- Lumen kickoff: Scoped the Lumen site/);
    assert.match(brief, /memory\.md/);
    assert.match(brief, /Also known \(details in memory\.md\): Omid K/);

    assert.equal(memory.brief("c-new", "and Sara again"), "", "nothing new to add");
    const later = memory.brief("c-new", "also loop in Omid on this");
    assert.match(later, /Omid K \(person\): Designer friend/);
    assert.doesNotMatch(later, /Sara/);

    assert.match(memory.snapshot(), /## People[\s\S]*### Sara Ahmadi[\s\S]*## Projects/);
  }));
});
