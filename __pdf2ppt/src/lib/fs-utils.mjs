import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function listImageFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) =>
      path.basename(a).localeCompare(path.basename(b), 'zh-CN', {
        numeric: true,
        sensitivity: 'base',
      })
    );
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function safeStem(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}
