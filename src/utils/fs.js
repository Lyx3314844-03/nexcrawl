import { appendFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function ensureDir(targetPath) {
  await mkdir(targetPath, { recursive: true });
  return targetPath;
}

export async function writeJson(targetPath, value) {
  await ensureDir(dirname(targetPath));
  const tempPath = `${targetPath}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2));
  try {
    await rename(tempPath, targetPath);
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      // Fallback for Windows file locking issues
      await writeFile(targetPath, JSON.stringify(value, null, 2));
    } else {
      throw error;
    }
  }
}

export async function readJson(targetPath) {
  const raw = await readFile(targetPath, 'utf8');
  return JSON.parse(raw);
}

export async function appendNdjson(targetPath, record) {
  await ensureDir(dirname(targetPath));
  await appendFile(targetPath, `${JSON.stringify(record)}\n`);
}
