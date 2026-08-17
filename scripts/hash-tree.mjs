import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const input = process.argv[2];
if (!input) {
  throw new Error("Usage: node scripts/hash-tree.mjs <directory>");
}

const root = resolve(input);

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolute));
    } else if (entry.isFile()) {
      files.push(absolute);
    } else {
      throw new Error(`Unsupported non-file entry in digest tree: ${absolute}`);
    }
  }
  return files;
}

const files = (await collectFiles(root)).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
const records = [];
for (const absolute of files) {
  const bytes = await readFile(absolute);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const path = relative(root, absolute).split(sep).join("/");
  records.push(`${hash}  ${path}\n`);
}

const digest = createHash("sha256").update(records.join(""), "utf8").digest("hex");
process.stdout.write(`${JSON.stringify({ root, files: files.length, algorithm: "sha256(sorted sha256 records)", digest })}\n`);
