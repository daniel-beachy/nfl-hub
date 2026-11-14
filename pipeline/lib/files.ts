import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, wherever the pipeline is run from. */
export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

/** Write via a temp file and rename, so a crash never leaves a half-written file. */
export function writeFileAtomic(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Remove `<file>.tmp-<pid>` leftovers of writeFileAtomic under `dir` (a process killed
 * between write and rename leaves one; QA-M0-15). Returns how many were removed.
 */
export function removeStaleTemps(dir: string): number {
  let removed = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  } catch {
    return 0; // no such directory yet
  }
  for (const e of entries) {
    if (e.isFile() && /\.tmp-\d+$/.test(e.name)) {
      rmSync(join(e.parentPath, e.name), { force: true });
      removed++;
    }
  }
  return removed;
}

/** Parsed JSON, or undefined when the file does not exist. Other errors throw. */
export function readJsonIfExists(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text);
}

/** True when this module is the script being run (not imported). */
export function isMain(importMetaUrl: string): boolean {
  return process.argv[1] !== undefined && fileURLToPath(importMetaUrl) === process.argv[1];
}

/** `--name value` and `--flag` from argv; bare words go to `_`. */
export function parseArgs(argv: string[]): { _: string[]; [key: string]: string | boolean | string[] } {
  const out: { _: string[]; [key: string]: string | boolean | string[] } = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) out._.push(arg);
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) out[arg.slice(2)] = argv[++i]!;
    else out[arg.slice(2)] = true;
  }
  return out;
}
