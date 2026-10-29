#!/usr/bin/env node
/**
 * Test script to index skills and verify semantic search works.
 * Run: node scripts/index-skills-test.mjs
 */
import { DatabaseSync as Database } from "node:sqlite";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const dbPath = join(process.cwd(), ".kimiflare", "memory.db");
const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// Init schema
db.exec(`
  CREATE TABLE IF NOT EXISTS skill_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    parser_version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS skill_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL,
    heading TEXT NOT NULL,
    body TEXT NOT NULL,
    embedding BLOB NOT NULL,
    FOREIGN KEY (skill_id) REFERENCES skill_index(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_skill_path ON skill_index(file_path);
`);

// Simple parser for testing
function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { data: {}, content: text };
  const lines = match[1].split("\n");
  const data = {};
  for (const line of lines) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length > 0) {
      data[key.trim()] = rest.join(":").trim();
    }
  }
  return { data, content: match[2] };
}

function splitSections(content) {
  const lines = content.split("\n");
  const sections = [];
  let heading = "";
  let body = [];
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      const b = body.join("\n").trim();
      if (b.length > 0 || heading) sections.push({ heading, body: b });
      heading = h2[1].trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  const b = body.join("\n").trim();
  if (b.length > 0 || heading) sections.push({ heading, body: b });
  return sections;
}

// Discover and parse
const skillFiles = [
  ".kimiflare/skills/testing.md",
  ".kimiflare/skills/build.md",
  ".kimiflare/skills/skills-system.md",
  "AGENTS.md",
];

let indexed = 0;
for (const file of skillFiles) {
  try {
    const text = readFileSync(file, "utf-8");
    const { data, content } = parseFrontmatter(text);

    if (file === "AGENTS.md") {
      // AGENTS.md: each ## section is a virtual skill
      const sections = splitSections(content);
      for (const section of sections) {
        if (!section.heading) continue;
        const hash = sha256(`${file}:${section.heading}`);
        const result = db.prepare(
          `INSERT INTO skill_index (name, description, file_path, content_hash, parser_version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(section.heading, section.body.slice(0, 100), file, hash, 1, Date.now());
        const skillId = result.lastInsertRowid;
        // Fake embedding (768 dims of zeros for testing structure)
        db.prepare(
          `INSERT INTO skill_sections (skill_id, heading, body, embedding)
           VALUES (?, ?, ?, ?)`
        ).run(skillId, section.heading, section.body, Buffer.from(new Float32Array(768).buffer));
        indexed++;
      }
    } else {
      // Standard skill file
      const name = data.name || "";
      if (!name) continue;
      const sections = splitSections(content);
      if (sections.length === 0) sections.push({ heading: name, body: content.trim() });
      if (sections[0].heading === "") sections[0].heading = name;

      const hash = sha256(text);
      const result = db.prepare(
        `INSERT INTO skill_index (name, description, file_path, content_hash, parser_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(name, data.description || "", file, hash, 1, Date.now());
      const skillId = result.lastInsertRowid;

      for (const section of sections) {
        db.prepare(
          `INSERT INTO skill_sections (skill_id, heading, body, embedding)
           VALUES (?, ?, ?, ?)`
        ).run(skillId, section.heading, section.body, Buffer.from(new Float32Array(768).buffer));
      }
      indexed++;
    }
  } catch (err) {
    console.error(`Failed to index ${file}:`, err.message);
  }
}

console.log(`Indexed ${indexed} skills.\n`);

// Show what's in the DB
const skills = db.prepare("SELECT id, name, description, file_path FROM skill_index").all();
for (const skill of skills) {
  const sections = db.prepare("SELECT COUNT(*) as c FROM skill_sections WHERE skill_id = ?").get(skill.id);
  console.log(`✓ ${skill.name} (${sections.c} sections) — ${skill.file_path}`);
}

const totalSections = db.prepare("SELECT COUNT(*) as c FROM skill_sections").get();
console.log(`\nTotal: ${skills.length} skills, ${totalSections.c} sections`);
db.close();
