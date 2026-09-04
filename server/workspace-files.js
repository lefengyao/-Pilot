import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import express from 'express';
import Busboy from 'busboy';

export const MAX_DIRECTORY_ENTRIES = 500;

export class WorkspaceFileError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'WorkspaceFileError';
    this.status = status;
  }
}

function canonicalRoot(root) {
  try {
    const resolved = fs.realpathSync(root);
    if (!fs.statSync(resolved).isDirectory()) throw new Error('not a directory');
    return resolved;
  } catch {
    throw new WorkspaceFileError('工作区目录不可用。', 500);
  }
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function protectedName(name) {
  const normalized = name.toLowerCase();
  return normalized === '.git' || normalized === '.env' || normalized.startsWith('.env.') || normalized.startsWith('.lan-upload-');
}

function assertRequestedPath(requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0 || requestedPath.length > 1024) {
    throw new WorkspaceFileError('工作区路径格式无效。');
  }
  if (path.isAbsolute(requestedPath) || path.win32.isAbsolute(requestedPath) || /^[A-Za-z]:/.test(requestedPath)) {
    throw new WorkspaceFileError('工作区路径必须是相对路径。');
  }
  const segments = requestedPath.split(/[\\/]+/);
  if (segments.some((segment) => segment === '..' || protectedName(segment))) {
    throw new WorkspaceFileError('工作区路径无效。');
  }
}

export function relativeWorkspacePath(root, absolutePath) {
  const resolvedRoot = canonicalRoot(root);
  let resolved;
  try {
    resolved = fs.realpathSync(absolutePath);
  } catch {
    throw new WorkspaceFileError('工作区目标不存在。', 404);
  }
  if (!isWithinRoot(resolvedRoot, resolved)) throw new WorkspaceFileError('工作区路径无效。');
  return path.relative(resolvedRoot, resolved) || '.';
}

export function resolveWorkspaceEntry(root, requestedPath, { allowRoot = true } = {}) {
  assertRequestedPath(requestedPath);
  const resolvedRoot = canonicalRoot(root);
  const candidate = path.resolve(resolvedRoot, requestedPath);
  let linkStats;
  try {
    linkStats = fs.lstatSync(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new WorkspaceFileError('工作区目标不存在。', 404);
    throw new WorkspaceFileError('无法读取工作区目标。', 500);
  }
  if (linkStats.isSymbolicLink()) throw new WorkspaceFileError('工作区路径无效。');

  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new WorkspaceFileError('无法读取工作区目标。', 500);
  }
  if (!isWithinRoot(resolvedRoot, resolved) || (!allowRoot && resolved === resolvedRoot)) {
    throw new WorkspaceFileError('工作区路径无效。');
  }
  return resolved;
}

export function resolveWorkspaceDirectory(root, requestedPath = '.') {
  const resolved = resolveWorkspaceEntry(root, requestedPath);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new WorkspaceFileError('无法读取工作区目录。', 500);
  }
  if (!stats.isDirectory()) throw new WorkspaceFileError('目标必须是文件夹。');
  return resolved;
}

export function validateEntryName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255 || name.trim().length === 0) {
    throw new WorkspaceFileError('名称无效。');
  }
  if (name === '.' || name === '..' || protectedName(name) || /[<>:"/\\|?*\u0000-\u001F]/.test(name) || /[. ]$/.test(name)) {
    throw new WorkspaceFileError('名称无效。');
  }
  const basename = path.basename(name);
  if (basename !== name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) {
    throw new WorkspaceFileError('名称无效。');
  }
  return name;
}

function entryMetadata(root, parent, entry) {
  if (protectedName(entry.name) || entry.isSymbolicLink()) return null;
  if (!entry.isDirectory() && !entry.isFile()) return null;
  try {
    const relative = path.relative(root, path.join(parent, entry.name)) || '.';
    const absolute = resolveWorkspaceEntry(root, relative, { allowRoot: false });
    const stats = fs.statSync(absolute);
    return {
      name: entry.name,
      path: relativeWorkspacePath(root, absolute),
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      mtime: Math.floor(stats.mtimeMs),
    };
  } catch {
    return null;
  }
}

export function listWorkspaceEntries(root, requestedPath = '.') {
  const resolvedRoot = canonicalRoot(root);
  const current = resolveWorkspaceDirectory(resolvedRoot, requestedPath);
  const directories = [];
  const files = [];

  let entries;
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'EACCES') throw new WorkspaceFileError('没有权限读取此目录。', 403);
    throw new WorkspaceFileError('无法读取工作区目录。', 500);
  }
  for (const entry of entries) {
    const metadata = entryMetadata(resolvedRoot, current, entry);
    if (!metadata) continue;
    if (metadata.type === 'directory') directories.push(metadata);
    else files.push(metadata);
  }

  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  directories.sort((left, right) => collator.compare(left.name, right.name));
  files.sort((left, right) => collator.compare(left.name, right.name));
  const relative = relativeWorkspacePath(resolvedRoot, current);
  return {
    path: relative,
    parent: relative === '.' ? null : path.dirname(relative),
    entries: [...directories, ...files].slice(0, MAX_DIRECTORY_ENTRIES),
  };
}

const MIME_TYPES = Object.freeze({
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.gif': 'image/gif',
  '.htm': 'text/html; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.text': 'text/plain; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
});

function contentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function fileError(error, logger, fallback = '文件操作失败。') {
  if (error instanceof WorkspaceFileError) return { status: error.status, message: error.message };
  logger.error?.('Workspace file operation failed', error);
  return { status: 500, message: fallback };
}

function sendError(res, error, logger, fallback) {
  const result = fileError(error, logger, fallback);
  return res.status(result.status).json({ error: result.message });
}

function existingEntry(root, requestedPath, { allowRoot = false } = {}) {
  const target = resolveWorkspaceEntry(root, requestedPath, { allowRoot });
  let stats;
  try {
    stats = fs.statSync(target);
  } catch {
    throw new WorkspaceFileError('无法读取工作区目标。', 500);
  }
  return { target, stats };
}

function conflictError() {
  return new WorkspaceFileError('同名文件或文件夹已存在。', 409);
}

function moveTarget(directory, name) {
  const parsed = path.parse(name);
  let candidate = path.join(directory, name);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${parsed.name}_${suffix}${parsed.ext}`);
    suffix += 1;
  }
  return candidate;
}

export async function createFolder(root, parentPath, name) {
  const parent = resolveWorkspaceDirectory(root, parentPath);
  const validatedName = validateEntryName(name);
  const target = path.join(parent, validatedName);
  if (fs.existsSync(target)) throw conflictError();
  try {
    await fs.promises.mkdir(target);
  } catch (error) {
    if (error?.code === 'EEXIST') throw conflictError();
    throw error;
  }
  return { path: relativeWorkspacePath(root, target), name: validatedName, type: 'directory' };
}

export async function renameEntry(root, requestedPath, name) {
  const { target } = existingEntry(root, requestedPath);
  const validatedName = validateEntryName(name);
  const renamedTarget = path.join(path.dirname(target), validatedName);
  if (fs.existsSync(renamedTarget) && path.resolve(renamedTarget) !== path.resolve(target)) throw conflictError();
  try {
    await fs.promises.rename(target, renamedTarget);
  } catch (error) {
    if (error?.code === 'EEXIST') throw conflictError();
    throw error;
  }
  const stats = fs.statSync(renamedTarget);
  return {
    path: relativeWorkspacePath(root, renamedTarget),
    name: validatedName,
    type: stats.isDirectory() ? 'directory' : 'file',
  };
}

export async function deleteEntry(root, requestedPath) {
  const { target, stats } = existingEntry(root, requestedPath);
  if (stats.isDirectory()) {
    let entries;
    try {
      entries = await fs.promises.readdir(target);
    } catch (error) {
      if (error?.code === 'EACCES') throw new WorkspaceFileError('没有权限删除此文件夹。', 403);
      throw error;
    }
    if (entries.length > 0) throw new WorkspaceFileError('文件夹不为空，无法删除。', 409);
    await fs.promises.rmdir(target);
  } else if (stats.isFile()) {
    await fs.promises.unlink(target);
  } else {
    throw new WorkspaceFileError('只能删除普通文件或空文件夹。');
  }
  return { path: requestedPath };
}

async function cleanupTemporaryDirectory(directory) {
  if (directory) await fs.promises.rm(directory, { recursive: true, force: true });
}

function multipartError(message, status = 400) {
  return new WorkspaceFileError(message, status);
}

async function parseUpload(req, root, maxUploadBytes, state = {}) {
  let busboy;
  try {
    busboy = Busboy({ headers: req.headers, limits: { fileSize: maxUploadBytes, files: 64 } });
  } catch {
    throw multipartError('上传请求格式无效。');
  }

  let targetDirectory = null;
  let temporaryDirectory = null;
  let parseError = null;
  let tooLarge = false;
  let filesLimitReached = false;
  const files = [];
  const pendingWrites = [];

  const rememberError = (error) => {
    if (!parseError) parseError = error;
  };

  busboy.on('field', (name, value) => {
    if (name !== 'path' || targetDirectory || parseError) return;
    try {
      targetDirectory = resolveWorkspaceDirectory(root, value);
      temporaryDirectory = fs.mkdtempSync(path.join(targetDirectory, '.lan-upload-'));
      state.temporaryDirectory = temporaryDirectory;
    } catch (error) {
      rememberError(error);
    }
  });

  busboy.on('file', (_field, stream, info) => {
    if (!targetDirectory || !temporaryDirectory) {
      rememberError(multipartError('上传请求必须先指定目标目录。'));
      stream.resume();
      return;
    }
    let name;
    try {
      name = validateEntryName(path.basename(info.filename || ''));
    } catch (error) {
      rememberError(error);
      stream.resume();
      return;
    }
    const temporaryPath = path.join(temporaryDirectory, crypto.randomUUID());
    const output = fs.createWriteStream(temporaryPath, { flags: 'wx' });
    stream.on('limit', () => { tooLarge = true; });
    files.push({ originalName: name, name, temporaryPath });
    pendingWrites.push(pipeline(stream, output));
  });
  busboy.on('filesLimit', () => { filesLimitReached = true; });

  await new Promise((resolve, reject) => {
    const abort = () => reject(multipartError('上传已取消。'));
    req.once('aborted', abort);
    busboy.once('error', reject);
    busboy.once('finish', () => {
      req.off('aborted', abort);
      resolve();
    });
    req.pipe(busboy);
  });
  const writes = await Promise.allSettled(pendingWrites);
  const failedWrite = writes.find((result) => result.status === 'rejected');
  if (failedWrite) throw failedWrite.reason;
  if (parseError) throw parseError;
  if (filesLimitReached) throw multipartError('一次最多上传 64 个文件。');
  if (tooLarge) throw multipartError('文件大小超过上传上限。', 413);
  if (files.length === 0) throw multipartError('未选择文件。');
  return { targetDirectory, temporaryDirectory, files };
}

async function uploadFiles(req, root, maxUploadBytes) {
  let upload;
  const state = {};
  try {
    upload = await parseUpload(req, root, maxUploadBytes, state);
    const results = [];
    for (const file of upload.files) {
      const target = moveTarget(upload.targetDirectory, file.name);
      await fs.promises.rename(file.temporaryPath, target);
      results.push({
        originalName: file.originalName,
        name: path.basename(target),
        status: path.basename(target) === file.name ? 'uploaded' : 'renamed',
      });
    }
    return results;
  } finally {
    await cleanupTemporaryDirectory(upload?.temporaryDirectory || state.temporaryDirectory);
  }
}

export function createWorkspaceRouter({ root, maxUploadBytes = 2 * 1024 * 1024 * 1024, logger = console }) {
  const router = express.Router();
  const limit = Number.isSafeInteger(maxUploadBytes) && maxUploadBytes > 0 ? maxUploadBytes : 2 * 1024 * 1024 * 1024;

  router.get('/tree', (req, res) => {
    try {
      res.json(listWorkspaceEntries(root, typeof req.query.path === 'string' ? req.query.path : '.'));
    } catch (error) {
      sendError(res, error, logger, '无法读取工作区目录。');
    }
  });

  router.get('/content', (req, res) => {
    try {
      const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
      const { target, stats } = existingEntry(root, requestedPath);
      if (!stats.isFile()) throw new WorkspaceFileError('目标必须是文件。');
      const download = req.query.download === '1';
      res.set('Content-Type', download ? 'application/octet-stream' : contentType(target));
      res.set('Content-Length', String(stats.size));
      res.set('X-Content-Type-Options', 'nosniff');
      if (['.html', '.htm', '.svg'].includes(path.extname(target).toLowerCase())) res.set('Content-Security-Policy', 'sandbox');
      if (['.html', '.htm', '.svg'].includes(path.extname(target).toLowerCase())) res.set('Content-Security-Policy', 'sandbox');
      if (download) {
        res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`);
      }
      const stream = fs.createReadStream(target);
      stream.on('error', (error) => {
        logger.error?.('Workspace file stream failed', error);
        if (!res.headersSent) sendError(res, error, logger, '无法读取文件。');
        else res.destroy(error);
      });
      stream.pipe(res);
    } catch (error) {
      sendError(res, error, logger, '无法读取文件。');
    }
  });

  router.post('/folders', async (req, res) => {
    try {
      const result = await createFolder(root, req.body?.path, req.body?.name);
      res.status(201).json(result);
    } catch (error) {
      sendError(res, error, logger, '无法新建文件夹。');
    }
  });

  router.patch('/entries', async (req, res) => {
    try {
      res.json(await renameEntry(root, req.body?.path, req.body?.name));
    } catch (error) {
      sendError(res, error, logger, '无法重命名文件。');
    }
  });

  router.delete('/entries', async (req, res) => {
    try {
      res.json(await deleteEntry(root, typeof req.query.path === 'string' ? req.query.path : ''));
    } catch (error) {
      sendError(res, error, logger, '无法删除文件。');
    }
  });

  router.post('/upload', async (req, res) => {
    try {
      const files = await uploadFiles(req, root, limit);
      res.status(201).json({ files });
    } catch (error) {
      sendError(res, error, logger, '上传失败。');
    }
  });

  return router;
}
