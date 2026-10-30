/**
 * Side-effect module: imported first by the CLI entry point so the
 * one-time move of the pre-rename kimiflare directories happens before
 * any module reads config, sessions or data, and before a renderer owns
 * the terminal. The notice goes to stderr once (the move itself is what
 * makes it one-time: afterwards the legacy paths are symlinks).
 */
import { migrateLegacyDirs, migrationNoticeText } from "./app-dirs.js";

try {
  const notice = migrationNoticeText(migrateLegacyDirs());
  if (notice) process.stderr.write(notice + "\n");
} catch {
  // Never block startup: readers fall back to the legacy paths.
}
