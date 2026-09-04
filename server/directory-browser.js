import fs from 'node:fs';
import path from 'node:path';
import { resolveWorkingDirectory } from './config.js';

export const MAX_DIRECTORY_ENTRIES = 500;

export function resolveAnyDirectory(requestedPath = path.parse(process.cwd()).root) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0 || requestedPath.length > 1024) {
    throw new Error('目录路径格式无效');
  }
  const candidate = path.resolve(requestedPath);
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new Error('目录必须是存在的目录');
  }
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error('目录必须是存在的目录');
  }
  if (!stats.isDirectory()) throw new Error('目录必须是目录');
  return resolved;
}

export function listAnyDirectories(requestedPath) {
  const current = resolveAnyDirectory(requestedPath);
  const directories = [];

  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      const child = resolveAnyDirectory(path.join(current, entry.name));
      directories.push({ name: entry.name, path: child });
    } catch {
      // Broken links are intentionally omitted.
    }
  }

  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  directories.sort((left, right) => collator.compare(left.name, right.name));
  const root = path.parse(current).root;
  return {
    path: current,
    parent: current === root ? null : path.dirname(current),
    directories: directories.slice(0, MAX_DIRECTORY_ENTRIES),
  };
}

function relativePath(root, directory) {
  return path.relative(root, directory) || '.';
}

export function listDirectories(allowedRoot, requestedPath = '.') {
  const root = resolveWorkingDirectory(allowedRoot, '.');
  const current = resolveWorkingDirectory(root, requestedPath);
  const directories = [];

  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    try {
      const child = resolveWorkingDirectory(root, path.join(current, entry.name));
      directories.push({ name: entry.name, path: relativePath(root, child) });
    } catch {
      // Broken and root-escaping links are intentionally omitted.
    }
  }

  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  directories.sort((left, right) => collator.compare(left.name, right.name));
  return {
    path: relativePath(root, current),
    parent: current === root ? null : relativePath(root, path.dirname(current)),
    directories: directories.slice(0, MAX_DIRECTORY_ENTRIES),
  };
}
