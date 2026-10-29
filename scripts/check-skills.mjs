#!/usr/bin/env node
/**
 * Quick script to check what skills are indexed in the local DB.
 * Run: node scripts/check-skills.mjs
 */
import { DatabaseSync as Database } from "node:sqlite";
import { join } from "node:path";

const dbPath = join(process.cwd(), ".kimiflare", "memory.db");

try {
  const db = new Database(dbPath);

  const skills = db.prepare("SELECT id, name, description, file_path, content_hash FROM skill_index").all();
  console.log(`\n📚 Indexed Skills: ${skills.length}\n`);
  for (const skill of skills) {
    const sections = db.prepare("SELECT COUNT(*) as c FROM skill_sections WHERE skill_id = ?").get(skill.id);
    console.log(`  • ${skill.name}`);
    console.log(`    file: ${skill.file_path}`);
    console.log(`    desc: ${skill.description || "(none)"}`);
    console.log(`    sections: ${sections.c}`);
    console.log("");
  }

  const totalSections = db.prepare("SELECT COUNT(*) as c FROM skill_sections").get();
  console.log(`Total sections: ${totalSections.c}`);
  db.close();
} catch (err) {
  console.error("Error reading DB:", err.message);
  console.error("Make sure you've run kimiflare at least once to create the DB.");
  process.exit(1);
}
