import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig, resolveWorkingDirectory } from '../server/config.js';

function withTemporaryRoot(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-config-'));

  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('loadConfig applies defaults and resolves ALLOWED_ROOT', () => {
  withTemporaryRoot((root) => {
    const config = loadConfig({ ALLOWED_ROOT: root }, root);

    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.port, 3000);
    assert.equal(config.maxSessionsPerClient, 8);
    assert.equal(config.allowedRoot, fs.realpathSync(root));
  });
});

test('loadConfig defaults absent and empty ALLOWED_ROOT to terminal-workspace', () => {
  withTemporaryRoot((root) => {
    const expectedRoot = path.join(root, 'terminal-workspace');
    fs.mkdirSync(expectedRoot);

    assert.equal(loadConfig({}, root).allowedRoot, fs.realpathSync(expectedRoot));
    assert.equal(loadConfig({ ALLOWED_ROOT: '' }, root).allowedRoot, fs.realpathSync(expectedRoot));
  });
});

test('loadConfig accepts a strong administrator key and disables blank keys', () => {
  withTemporaryRoot((root) => {
    assert.equal(loadConfig({ ALLOWED_ROOT: root, ADMIN_KEY: '' }, root).adminKey, null);
    assert.equal(loadConfig({ ALLOWED_ROOT: root, ADMIN_KEY: 'a'.repeat(32) }, root).adminKey, 'a'.repeat(32));
    assert.throws(() => loadConfig({ ALLOWED_ROOT: root, ADMIN_KEY: 'short' }, root), /ADMIN_KEY/);
  });
});

test('loadConfig defaults MAX_UPLOAD_BYTES to 2 GiB and accepts a bounded override', () => {
  withTemporaryRoot((root) => {
    const config = loadConfig({ ALLOWED_ROOT: root }, root);
    assert.equal(config.maxUploadBytes, 2 * 1024 * 1024 * 1024);
    assert.equal(loadConfig({ ALLOWED_ROOT: root, MAX_UPLOAD_BYTES: '1048576' }, root).maxUploadBytes, 1048576);
  });
});

test('loadConfig rejects an upload limit below 1 MiB or above 8 GiB', () => {
  withTemporaryRoot((root) => {
    assert.throws(() => loadConfig({ ALLOWED_ROOT: root, MAX_UPLOAD_BYTES: '1048575' }, root), /MAX_UPLOAD_BYTES/);
    assert.throws(() => loadConfig({ ALLOWED_ROOT: root, MAX_UPLOAD_BYTES: String(8 * 1024 * 1024 * 1024 + 1) }, root), /MAX_UPLOAD_BYTES/);
  });
});

test('resolveWorkingDirectory accepts a child and rejects paths outside the allowed root', () => {
  withTemporaryRoot((root) => {
    const child = path.join(root, 'child');
    fs.mkdirSync(child);

    assert.equal(resolveWorkingDirectory(root, 'child'), fs.realpathSync(child));
    assert.throws(
      () => resolveWorkingDirectory(root, '..'),
      /允许目录/,
    );
  });
});

test('loadConfig rejects invalid root, port, and per-client session limit', () => {
  withTemporaryRoot((root) => {
    const file = path.join(root, 'not-a-directory');
    fs.writeFileSync(file, 'not a directory');

    assert.throws(
      () => loadConfig({ ALLOWED_ROOT: file }, root),
      /目录/,
    );
    assert.throws(
      () => loadConfig({ ALLOWED_ROOT: root, PORT: '70000' }, root),
      /PORT/,
    );
    assert.throws(
      () => loadConfig({ ALLOWED_ROOT: root, MAX_SESSIONS_PER_CLIENT: '0' }, root),
      /MAX_SESSIONS_PER_CLIENT/,
    );
  });
});
