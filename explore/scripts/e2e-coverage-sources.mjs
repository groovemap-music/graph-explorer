import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const root = resolve(process.env.GROOVEMAP_E2E_ROOT ?? repositoryRoot);
export const backupRoot = resolve(root, ".build/e2e-original");

function javascriptSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return javascriptSources(path);
    return entry.isFile() && entry.name.endsWith(".js") ? [relative(root, path)] : [];
  });
}

export const sources = javascriptSources(resolve(root, "explore/static/js"));

export function restoreSources() {
  for (const relativePath of sources) {
    const backup = resolve(backupRoot, relativePath);
    if (existsSync(backup)) cpSync(backup, resolve(root, relativePath));
  }
  if (existsSync(backupRoot)) rmSync(backupRoot, { recursive: true, force: true });
}
