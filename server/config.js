import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = Object.freeze({
  port: 3000,
  maxSessionsPerClient: 8,
  maxSessionsTotal: 64,
  maxMessageBytes: 65536,
  maxHistoryBytes: 524288,
  maxUploadBytes: 2 * 1024 * 1024 * 1024,
  outputBatchMs: 16,
});

function directoryRealpath(directory, label) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error(`${label}必须是目录路径`);
  }

  let realPath;
  try {
    realPath = fs.realpathSync(directory);
  } catch {
    throw new Error(`${label}必须是存在的目录`);
  }

  let stats;
  try {
    stats = fs.statSync(realPath);
  } catch {
    throw new Error(`${label}必须是存在的目录`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label}必须是目录`);
  }
  return realPath;
}

function parseBoundedInteger(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined) return fallback;

  let value;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && /^\s*\d+\s*$/.test(raw)) {
    value = Number(raw.trim());
  } else {
    throw new Error(`${name}必须是${min}到${max}之间的整数`);
  }

  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name}必须是${min}到${max}之间的整数`);
  }
  return value;
}

function ensureWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Resolve a requested initial working directory beneath an allowed root.
 * Both paths are canonicalized with realpathSync to prevent symlink escapes.
 */
export function resolveWorkingDirectory(allowedRoot, requestedCwd = '.') {
  const root = directoryRealpath(allowedRoot, '允许目录');
  if (typeof requestedCwd !== 'string' || requestedCwd.length > 1024) {
    throw new Error('工作目录格式无效');
  }

  const candidate = path.isAbsolute(requestedCwd)
    ? path.resolve(requestedCwd)
    : path.resolve(root, requestedCwd);

  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new Error('工作目录必须是存在的目录');
  }

  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error('工作目录必须是存在的目录');
  }
  if (!stats.isDirectory()) {
    throw new Error('工作目录必须是目录');
  }
  if (!ensureWithinRoot(root, resolved)) {
    throw new Error('工作目录必须位于允许目录之内');
  }
  return resolved;
}

/**
 * Load and validate server configuration from an environment-like object.
 */
export function loadConfig(env = process.env, workingDirectory = process.cwd()) {
  const baseDirectory = directoryRealpath(workingDirectory, '工作目录');
  const allowedRootInput = env.ALLOWED_ROOT === undefined || env.ALLOWED_ROOT === ''
    ? path.join(baseDirectory, 'terminal-workspace')
    : env.ALLOWED_ROOT;
  if (typeof allowedRootInput !== 'string' || allowedRootInput.trim().length === 0) {
    throw new Error('ALLOWED_ROOT必须是存在的目录');
  }

  const allowedRootPath = path.isAbsolute(allowedRootInput)
    ? allowedRootInput
    : path.resolve(baseDirectory, allowedRootInput);
  const allowedRoot = directoryRealpath(allowedRootPath, 'ALLOWED_ROOT目录');

  const adminKeyInput = env.ADMIN_KEY === undefined || env.ADMIN_KEY === '' ? null : env.ADMIN_KEY;
  if (adminKeyInput !== null && (typeof adminKeyInput !== 'string' || adminKeyInput.length < 32)) {
    throw new Error('ADMIN_KEY必须至少包含32个字符');
  }

  const host = env.HOST === undefined ? '0.0.0.0' : env.HOST;
  if (typeof host !== 'string' || host.length > 255) {
    throw new Error('HOST长度不能超过255');
  }

  const config = {
    host,
    port: parseBoundedInteger(env, 'PORT', DEFAULTS.port, 1, 65535),
    allowedRoot,
    adminKey: adminKeyInput,
    maxSessionsPerClient: parseBoundedInteger(
      env,
      'MAX_SESSIONS_PER_CLIENT',
      DEFAULTS.maxSessionsPerClient,
      1,
      64,
    ),
    maxSessionsTotal: parseBoundedInteger(
      env,
      'MAX_SESSIONS_TOTAL',
      DEFAULTS.maxSessionsTotal,
      1,
      512,
    ),
    maxMessageBytes: parseBoundedInteger(
      env,
      'MAX_MESSAGE_BYTES',
      DEFAULTS.maxMessageBytes,
      1024,
      1048576,
    ),
    maxHistoryBytes: parseBoundedInteger(
      env,
      'MAX_HISTORY_BYTES',
      DEFAULTS.maxHistoryBytes,
      1024,
      16777216,
    ),
    maxUploadBytes: parseBoundedInteger(
      env,
      'MAX_UPLOAD_BYTES',
      DEFAULTS.maxUploadBytes,
      1024 * 1024,
      8 * 1024 * 1024 * 1024,
    ),
    outputBatchMs: parseBoundedInteger(
      env,
      'OUTPUT_BATCH_MS',
      DEFAULTS.outputBatchMs,
      0,
      1000,
    ),
  };

  return Object.freeze(config);
}
