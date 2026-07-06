import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export async function readJson(filePath) {
  const rawText = await fs.readFile(filePath, 'utf8');
  return JSON.parse(rawText);
}

export async function listImageFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .filter((filePath) => /\.(png|jpe?g|webp)$/i.test(filePath))
    .sort((a, b) => a.localeCompare(b, 'en'));
}
