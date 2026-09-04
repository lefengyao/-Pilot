# 局域网网页终端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows-hosted LAN web application that gives each browser a persistent set of isolated PowerShell or CMD PTY sessions.

**Architecture:** An Express HTTP server hosts a dependency-free browser workspace and vendor assets. A `ws` WebSocket layer validates a small message protocol and routes session events to the owning browser identity. `SessionManager` owns `TerminalSession` instances backed by `node-pty`; it enforces working-directory and concurrency policies while retaining detached processes until a user stops them or the server shuts down.

**Tech Stack:** Node.js 24+, Express 5, dotenv, ws, node-pty, @xterm/xterm, @xterm/addon-fit, native `node:test`.

---

## File structure

```text
package.json                         # Scripts, runtime dependencies, Node version
.env.example                         # Safe-to-copy LAN service configuration
server/config.js                     # Environment parsing and allowed-directory resolution
server/protocol.js                   # Validated WebSocket messages and response constructors
server/text-ring-buffer.js           # Bounded UTF-8 terminal-history buffer
server/terminal-session.js           # One node-pty process and its lifecycle
server/session-manager.js            # Ownership, limits, session registry, graceful cleanup
server/websocket-router.js           # WebSocket connection handling and output batching
server/app.js                        # Express/static serving, health route, composable HTTP server
server/index.js                      # Production entry point and shutdown-signal wiring
public/index.html                    # Workspace shell and accessible controls
public/styles.css                    # Responsive dark terminal-workspace styling
public/ws-client.js                  # Reconnecting WebSocket client and browser identity persistence
public/workspace.js                  # xterm instances, session list, controls, and DOM updates
public/app.js                        # Browser bootstrap and event wiring
test/config.test.js                  # Allowed-root and numeric configuration tests
test/protocol.test.js                # Malformed/oversized WebSocket message tests
test/text-ring-buffer.test.js        # UTF-8 bounded-history tests
test/terminal-session.test.js        # PTY lifecycle tests using a fake PTY
test/session-manager.test.js         # Ownership, limits, restart, and cleanup tests
test/websocket-router.test.js        # End-to-end WebSocket message routing with a fake PTY
README.md                            # Install, LAN firewall, configuration, and safety instructions
```

The directory is not a Git repository as of 2026-09-02. Skip the commit steps below until the user initializes a repository; do not create commits outside a repository.

### Task 1: Bootstrap the Node project and configuration boundary

**Files:**
- Create: `package.json`
- Create: `.env.example`
- Create: `server/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: Create the package manifest and install the declared dependencies.**

Create `package.json`:

```json
{
  "name": "lan-terminal-workspace",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "node server/index.js",
    "dev": "node --watch server/index.js",
    "test": "node --test",
    "test:watch": "node --test --watch"
  },
  "dependencies": {
    "@xterm/addon-fit": "^0.10.0",
    "@xterm/xterm": "^5.5.0",
    "dotenv": "^16.4.7",
    "express": "^5.1.0",
    "node-pty": "^1.1.0",
    "ws": "^8.18.0"
  }
}
```

Run: `npm install`

Expected: `package-lock.json` exists and `npm` reports installed packages without an audit error that blocks installation.

- [ ] **Step 2: Write the failing configuration tests.**

Create `test/config.test.js`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, resolveWorkingDirectory } from '../server/config.js';

test('loadConfig uses bounded defaults and the supplied allowed root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-root-'));
  const config = loadConfig({ ALLOWED_ROOT: root }, root);

  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 3000);
  assert.equal(config.maxSessionsPerClient, 8);
  assert.equal(config.allowedRoot, fs.realpathSync(root));
});

test('resolveWorkingDirectory permits a child and rejects traversal outside the root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-root-'));
  const child = path.join(root, 'child');
  fs.mkdirSync(child);

  assert.equal(resolveWorkingDirectory(root, 'child'), fs.realpathSync(child));
  assert.throws(() => resolveWorkingDirectory(root, '..'), /允许目录/);
});

test('loadConfig rejects a non-directory allowed root and invalid numeric values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-root-'));
  const file = path.join(root, 'not-a-directory.txt');
  fs.writeFileSync(file, 'x');

  assert.throws(() => loadConfig({ ALLOWED_ROOT: file }, root), /目录/);
  assert.throws(() => loadConfig({ ALLOWED_ROOT: root, PORT: '70000' }, root), /PORT/);
  assert.throws(() => loadConfig({ ALLOWED_ROOT: root, MAX_SESSIONS_PER_CLIENT: '0' }, root), /MAX_SESSIONS_PER_CLIENT/);
});
```

- [ ] **Step 3: Run the configuration test to verify it fails.**

Run: `node --test test/config.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/config.js`.

- [ ] **Step 4: Implement environment parsing and the allowed-directory resolver.**

Create `server/config.js`:

```js
import fs from 'node:fs';
import path from 'node:path';

const LIMITS = {
  port: [1, 65535],
  maxSessionsPerClient: [1, 64],
  maxSessionsTotal: [1, 512],
  maxMessageBytes: [1024, 1024 * 1024],
  maxHistoryBytes: [1024, 16 * 1024 * 1024],
  outputBatchMs: [0, 1000]
};

function readInteger(env, name, fallback, [minimum, maximum]) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return value;
}

function realDirectory(candidate, label) {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error(`${label} 必须是存在的目录。`);
  }
  return fs.realpathSync(candidate);
}

export function resolveWorkingDirectory(allowedRoot, requestedCwd = '.') {
  if (typeof requestedCwd !== 'string' || requestedCwd.length > 1024) {
    throw new Error('工作目录格式无效。');
  }
  const root = realDirectory(allowedRoot, '允许目录');
  const candidate = path.isAbsolute(requestedCwd)
    ? requestedCwd
    : path.join(root, requestedCwd.trim() || '.');
  const resolved = realDirectory(candidate, '工作目录');
  const relative = path.relative(root, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('工作目录必须位于允许目录之内。');
  }
  return resolved;
}

export function loadConfig(env = process.env, workingDirectory = process.cwd()) {
  const allowedRoot = realDirectory(env.ALLOWED_ROOT || workingDirectory, 'ALLOWED_ROOT');
  const host = env.HOST || '0.0.0.0';
  if (host.length > 255) throw new Error('HOST 长度无效。');

  return Object.freeze({
    host,
    port: readInteger(env, 'PORT', 3000, LIMITS.port),
    allowedRoot,
    maxSessionsPerClient: readInteger(env, 'MAX_SESSIONS_PER_CLIENT', 8, LIMITS.maxSessionsPerClient),
    maxSessionsTotal: readInteger(env, 'MAX_SESSIONS_TOTAL', 64, LIMITS.maxSessionsTotal),
    maxMessageBytes: readInteger(env, 'MAX_MESSAGE_BYTES', 65536, LIMITS.maxMessageBytes),
    maxHistoryBytes: readInteger(env, 'MAX_HISTORY_BYTES', 524288, LIMITS.maxHistoryBytes),
    outputBatchMs: readInteger(env, 'OUTPUT_BATCH_MS', 16, LIMITS.outputBatchMs)
  });
}
```

Create `.env.example`:

```dotenv
# 0.0.0.0 makes the service reachable from the LAN. Use a specific LAN address to bind one adapter only.
HOST=0.0.0.0
PORT=3000
# Sessions may start only in this directory or its real subdirectories.
ALLOWED_ROOT=C:\\Users\\Public
MAX_SESSIONS_PER_CLIENT=8
MAX_SESSIONS_TOTAL=64
MAX_MESSAGE_BYTES=65536
MAX_HISTORY_BYTES=524288
OUTPUT_BATCH_MS=16
```

- [ ] **Step 5: Run the configuration tests and package test command.**

Run: `npm test -- --test-name-pattern="loadConfig|resolveWorkingDirectory"`

Expected: all three `test/config.test.js` tests PASS.

- [ ] **Step 6: Commit the bootstrap task when a Git repository exists.**

Run: `git add package.json package-lock.json .env.example server/config.js test/config.test.js && git commit -m "chore: bootstrap LAN terminal service"`

Expected: commit succeeds only after the workspace is initialized as a Git repository; otherwise record the task as complete without a commit.

### Task 2: Define the WebSocket protocol and bounded terminal-history buffer

**Files:**
- Create: `server/protocol.js`
- Create: `server/text-ring-buffer.js`
- Test: `test/protocol.test.js`
- Test: `test/text-ring-buffer.test.js`

- [ ] **Step 1: Write failing protocol and history-buffer tests.**

Create `test/protocol.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProtocolError, parseClientMessage } from '../server/protocol.js';

const limits = { maxMessageBytes: 256 };

test('parses a valid create request with normalized terminal dimensions', () => {
  const message = parseClientMessage(JSON.stringify({
    type: 'create',
    payload: { shell: 'powershell', label: 'Build', cwd: '.', cols: 120, rows: 32 }
  }), limits);

  assert.deepEqual(message, {
    type: 'create',
    sessionId: undefined,
    payload: { shell: 'powershell', label: 'Build', cwd: '.', cols: 120, rows: 32 }
  });
});

test('rejects unknown messages, missing session IDs, and oversized input', () => {
  assert.throws(() => parseClientMessage('{"type":"erase"}', limits), ProtocolError);
  assert.throws(() => parseClientMessage('{"type":"input","payload":{"data":"x"}}', limits), /sessionId/);
  assert.throws(() => parseClientMessage(JSON.stringify({ type: 'input', sessionId: 's', payload: { data: 'x'.repeat(300) } }), limits), /消息过大/);
});

test('parses reconnect ownership claims and deduplicates session IDs', () => {
  const message = parseClientMessage(JSON.stringify({
    type: 'hello',
    payload: { clientId: 'browser-1', sessionIds: ['a', 'a', 'b'] }
  }), limits);

  assert.deepEqual(message.payload, { clientId: 'browser-1', sessionIds: ['a', 'b'] });
});
```

Create `test/text-ring-buffer.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { TextRingBuffer } from '../server/text-ring-buffer.js';

test('keeps the newest complete UTF-8 text within its byte budget', () => {
  const history = new TextRingBuffer(8);
  history.append('ab');
  history.append('中文');
  history.append('c');

  assert.equal(history.toString(), 'b中文c');
  assert.ok(Buffer.byteLength(history.toString(), 'utf8') <= 8);
});

test('clears its retained text', () => {
  const history = new TextRingBuffer(16);
  history.append('output');
  history.clear();
  assert.equal(history.toString(), '');
});
```

- [ ] **Step 2: Run the new tests to verify they fail.**

Run: `node --test test/protocol.test.js test/text-ring-buffer.test.js`

Expected: FAIL with missing-module errors for `server/protocol.js` and `server/text-ring-buffer.js`.

- [ ] **Step 3: Implement exact message validation and output trimming.**

Create `server/protocol.js`:

```js
const TYPES = new Set(['hello', 'create', 'input', 'resize', 'stop', 'restart']);
const SHELLS = new Set(['powershell', 'cmd']);

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function textOf(raw) {
  return Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
}

function requireString(value, label, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new ProtocolError(`${label} 格式无效。`);
  }
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ProtocolError(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数。`);
  }
  return value;
}

function sessionIdOf(value) {
  return requireString(value, 'sessionId', 128);
}

export function parseClientMessage(raw, { maxMessageBytes }) {
  const text = textOf(raw);
  if (Buffer.byteLength(text, 'utf8') > maxMessageBytes) throw new ProtocolError('消息过大。');

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw new ProtocolError('消息必须是 JSON。');
  }
  if (!message || typeof message !== 'object' || !TYPES.has(message.type)) {
    throw new ProtocolError('消息类型无效。');
  }

  const payload = message.payload ?? {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('payload 格式无效。');
  }

  if (message.type === 'hello') {
    const ids = Array.isArray(payload.sessionIds) ? payload.sessionIds : [];
    return {
      type: 'hello',
      sessionId: undefined,
      payload: {
        clientId: requireString(payload.clientId, 'clientId', 128),
        sessionIds: [...new Set(ids.map(sessionIdOf))].slice(0, 64)
      }
    };
  }

  if (message.type === 'create') {
    if (!SHELLS.has(payload.shell)) throw new ProtocolError('shell 必须是 powershell 或 cmd。');
    return {
      type: 'create',
      sessionId: undefined,
      payload: {
        shell: payload.shell,
        label: typeof payload.label === 'string' ? payload.label.trim().slice(0, 64) : '',
        cwd: typeof payload.cwd === 'string' ? payload.cwd.trim().slice(0, 1024) || '.' : '.',
        cols: integer(payload.cols ?? 100, 'cols', 2, 500),
        rows: integer(payload.rows ?? 30, 'rows', 2, 300)
      }
    };
  }

  const sessionId = sessionIdOf(message.sessionId);
  if (message.type === 'input') {
    return { type: 'input', sessionId, payload: { data: requireString(payload.data, '输入', maxMessageBytes) } };
  }
  if (message.type === 'resize') {
    return {
      type: 'resize',
      sessionId,
      payload: { cols: integer(payload.cols, 'cols', 2, 500), rows: integer(payload.rows, 'rows', 2, 300) }
    };
  }
  return { type: message.type, sessionId, payload: {} };
}

export function serverMessage(type, sessionId, payload) {
  return JSON.stringify({ type, ...(sessionId ? { sessionId } : {}), payload });
}
```

Create `server/text-ring-buffer.js`:

```js
function trimToByteLength(text, maximumBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maximumBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(text.slice(middle), 'utf8') <= maximumBytes) high = middle;
    else low = middle + 1;
  }
  while (low < text.length && low > 0 && /[\uDC00-\uDFFF]/.test(text[low])) low += 1;
  return text.slice(low);
}

export class TextRingBuffer {
  constructor(maximumBytes) {
    this.maximumBytes = maximumBytes;
    this.value = '';
  }

  append(text) {
    this.value = trimToByteLength(this.value + String(text), this.maximumBytes);
  }

  clear() {
    this.value = '';
  }

  toString() {
    return this.value;
  }
}
```

- [ ] **Step 4: Run all protocol and buffer tests.**

Run: `node --test test/protocol.test.js test/text-ring-buffer.test.js`

Expected: all five tests PASS.

- [ ] **Step 5: Commit the protocol task when a Git repository exists.**

Run: `git add server/protocol.js server/text-ring-buffer.js test/protocol.test.js test/text-ring-buffer.test.js && git commit -m "feat: validate terminal websocket protocol"`

Expected: a focused protocol commit in a Git-initialized workspace.

### Task 3: Implement a disposable, testable PTY session

**Files:**
- Create: `server/terminal-session.js`
- Test: `test/terminal-session.test.js`

- [ ] **Step 1: Write a fake PTY and failing lifecycle tests.**

Create `test/terminal-session.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { TerminalSession } from '../server/terminal-session.js';

class FakePty {
  constructor() {
    this.pid = 4242;
    this.writes = [];
    this.resizes = [];
    this.dataHandlers = [];
    this.exitHandlers = [];
  }
  onData(handler) { this.dataHandlers.push(handler); }
  onExit(handler) { this.exitHandlers.push(handler); }
  write(data) { this.writes.push(data); }
  resize(cols, rows) { this.resizes.push([cols, rows]); }
  kill() { this.exitHandlers.forEach((handler) => handler({ exitCode: 0 })); }
  emitData(data) { this.dataHandlers.forEach((handler) => handler(data)); }
}

test('starts a PowerShell PTY, relays output, and records bounded history', () => {
  const pty = new FakePty();
  const session = new TerminalSession({
    id: 'session-1', ownerClientId: 'browser-1', shell: 'powershell', cwd: 'C:\\Work', cols: 100, rows: 30,
    maxHistoryBytes: 16,
    ptyFactory: (command, args, options) => {
      assert.equal(command, 'powershell.exe');
      assert.deepEqual(args, ['-NoLogo']);
      assert.equal(options.cwd, 'C:\\Work');
      return pty;
    }
  });
  const output = [];
  session.on('output', (data) => output.push(data));

  session.start();
  pty.emitData('hello');
  session.write('dir\r');
  session.resize(120, 40);

  assert.equal(session.snapshot().state, 'running');
  assert.equal(session.snapshot().pid, 4242);
  assert.deepEqual(output, ['hello']);
  assert.equal(session.history(), 'hello');
  assert.deepEqual(pty.writes, ['dir\r']);
  assert.deepEqual(pty.resizes, [[120, 40]]);
});

test('stops and restarts a session without accepting input while stopped', async () => {
  const ptys = [new FakePty(), new FakePty()];
  const session = new TerminalSession({
    id: 'session-2', ownerClientId: 'browser-1', shell: 'cmd', cwd: 'C:\\Work', cols: 80, rows: 24,
    maxHistoryBytes: 1024, ptyFactory: () => ptys.shift()
  });

  session.start();
  await session.stop();
  assert.equal(session.snapshot().state, 'exited');
  assert.throws(() => session.write('echo no'), /未运行/);
  await session.restart();
  assert.equal(session.snapshot().state, 'running');
});
```

- [ ] **Step 2: Run the session tests to verify they fail.**

Run: `node --test test/terminal-session.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/terminal-session.js`.

- [ ] **Step 3: Implement `TerminalSession` with no command rewriting.**

Create `server/terminal-session.js`:

```js
import { EventEmitter } from 'node:events';
import { TextRingBuffer } from './text-ring-buffer.js';

const SHELL_COMMANDS = {
  powershell: { command: 'powershell.exe', args: ['-NoLogo'] },
  cmd: { command: 'cmd.exe', args: [] }
};

export class TerminalSession extends EventEmitter {
  constructor({ id, ownerClientId, shell, label, cwd, cols, rows, maxHistoryBytes, ptyFactory }) {
    super();
    this.id = id;
    this.ownerClientId = ownerClientId;
    this.shell = shell;
    this.label = label;
    this.cwd = cwd;
    this.cols = cols;
    this.rows = rows;
    this.ptyFactory = ptyFactory;
    this.outputHistory = new TextRingBuffer(maxHistoryBytes);
    this.createdAt = new Date().toISOString();
    this.state = 'created';
    this.pid = null;
    this.exitCode = null;
    this.pty = null;
    this.stopPromise = null;
    this.resolveStop = null;
  }

  start() {
    if (this.state === 'running' || this.state === 'stopping') throw new Error('终端已在运行。');
    const definition = SHELL_COMMANDS[this.shell];
    if (!definition) throw new Error('不支持的终端类型。');
    try {
      const pty = this.ptyFactory(definition.command, definition.args, {
        name: 'xterm-256color', cwd: this.cwd, cols: this.cols, rows: this.rows, env: process.env
      });
      this.pty = pty;
      this.pid = pty.pid;
      this.exitCode = null;
      pty.onData((data) => {
        this.outputHistory.append(data);
        this.emit('output', data);
      });
      pty.onExit(({ exitCode }) => this.#didExit(exitCode));
      this.state = 'running';
      this.emit('status', this.snapshot());
      return this.snapshot();
    } catch (error) {
      this.state = 'error';
      this.emit('status', this.snapshot());
      throw error;
    }
  }

  write(data) {
    if (this.state !== 'running' || !this.pty) throw new Error('终端未运行，不能写入输入。');
    this.pty.write(data);
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.state === 'running' && this.pty) this.pty.resize(cols, rows);
  }

  stop() {
    if (this.state !== 'running' || !this.pty) return Promise.resolve(this.snapshot());
    this.state = 'stopping';
    this.emit('status', this.snapshot());
    const stopPromise = new Promise((resolve) => { this.resolveStop = resolve; });
    this.stopPromise = stopPromise;
    try {
      this.pty.kill();
    } catch (error) {
      this.state = 'error';
      this.emit('status', this.snapshot());
      this.resolveStop(this.snapshot());
    }
    return stopPromise;
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  history() {
    return this.outputHistory.toString();
  }

  snapshot() {
    return { id: this.id, shell: this.shell, label: this.label, cwd: this.cwd, state: this.state, pid: this.pid, exitCode: this.exitCode, createdAt: this.createdAt };
  }

  #didExit(exitCode) {
    this.pty = null;
    this.pid = null;
    this.exitCode = exitCode;
    this.state = 'exited';
    this.emit('status', this.snapshot());
    if (this.resolveStop) {
      this.resolveStop(this.snapshot());
      this.resolveStop = null;
      this.stopPromise = null;
    }
  }
}
```

- [ ] **Step 4: Run the PTY-session tests.**

Run: `node --test test/terminal-session.test.js`

Expected: both lifecycle tests PASS using only `FakePty`; no real shell is spawned during this test.

- [ ] **Step 5: Commit the PTY session task when a Git repository exists.**

Run: `git add server/terminal-session.js test/terminal-session.test.js && git commit -m "feat: manage individual terminal PTY sessions"`

Expected: a focused PTY lifecycle commit in a Git-initialized workspace.

### Task 4: Add session ownership, limits, and server-shutdown cleanup

**Files:**
- Create: `server/session-manager.js`
- Test: `test/session-manager.test.js`

- [ ] **Step 1: Write failing manager tests with an injectable PTY factory.**

Create `test/session-manager.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionManager } from '../server/session-manager.js';

function makePty() {
  const dataHandlers = [];
  const exitHandlers = [];
  return {
    pid: Math.floor(Math.random() * 10000),
    onData(handler) { dataHandlers.push(handler); },
    onExit(handler) { exitHandlers.push(handler); },
    write() {}, resize() {},
    kill() { exitHandlers.forEach((handler) => handler({ exitCode: 0 })); }
  };
}

function makeManager(overrides = {}) {
  return new SessionManager({
    allowedRoot: process.cwd(), maxSessionsPerClient: 2, maxSessionsTotal: 3, maxHistoryBytes: 1024,
    ptyFactory: () => makePty(),
    resolveCwd: () => process.cwd(),
    ...overrides
  });
}

test('creates sessions only within the owner quota and restores the owner list', () => {
  const manager = makeManager();
  const first = manager.create('browser-a', { shell: 'cmd', label: '', cwd: '.', cols: 80, rows: 24 });
  const second = manager.create('browser-a', { shell: 'powershell', label: '', cwd: '.', cols: 80, rows: 24 });

  assert.equal(manager.restore('browser-a', [first.id, second.id]).length, 2);
  assert.throws(() => manager.create('browser-a', { shell: 'cmd', label: '', cwd: '.', cols: 80, rows: 24 }), /上限/);
});

test('does not disclose another browser owner’s session and cleans up every process', async () => {
  const manager = makeManager();
  const session = manager.create('browser-a', { shell: 'cmd', label: '', cwd: '.', cols: 80, rows: 24 });

  assert.equal(manager.getOwned('browser-b', session.id), null);
  await manager.shutdown();
  assert.equal(session.state, 'exited');
  assert.throws(() => manager.create('browser-a', { shell: 'cmd', label: '', cwd: '.', cols: 80, rows: 24 }), /正在关闭/);
});
```

- [ ] **Step 2: Run the manager tests to verify they fail.**

Run: `node --test test/session-manager.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/session-manager.js`.

- [ ] **Step 3: Implement the manager and its ownership checks.**

Create `server/session-manager.js`:

```js
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolveWorkingDirectory } from './config.js';
import { TerminalSession } from './terminal-session.js';

export class SessionManager extends EventEmitter {
  constructor({ allowedRoot, maxSessionsPerClient, maxSessionsTotal, maxHistoryBytes, ptyFactory, resolveCwd = resolveWorkingDirectory }) {
    super();
    this.allowedRoot = allowedRoot;
    this.maxSessionsPerClient = maxSessionsPerClient;
    this.maxSessionsTotal = maxSessionsTotal;
    this.maxHistoryBytes = maxHistoryBytes;
    this.ptyFactory = ptyFactory;
    this.resolveCwd = resolveCwd;
    this.sessions = new Map();
    this.accepting = true;
  }

  create(ownerClientId, request) {
    if (!this.accepting) throw new Error('服务正在关闭，不能创建会话。');
    if (this.sessions.size >= this.maxSessionsTotal) throw new Error('服务器会话数量已到上限。');
    if ([...this.sessions.values()].filter((session) => session.ownerClientId === ownerClientId).length >= this.maxSessionsPerClient) {
      throw new Error('此浏览器的会话数量已到上限。');
    }

    const session = new TerminalSession({
      id: randomUUID(), ownerClientId, shell: request.shell, label: request.label, cwd: this.resolveCwd(this.allowedRoot, request.cwd),
      cols: request.cols, rows: request.rows, maxHistoryBytes: this.maxHistoryBytes, ptyFactory: this.ptyFactory
    });
    this.sessions.set(session.id, session);
    session.on('output', (data) => this.emit('output', session, data));
    session.on('status', () => this.emit('status', session));
    try {
      session.start();
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }
    return session;
  }

  getOwned(ownerClientId, sessionId) {
    const session = this.sessions.get(sessionId);
    return session?.ownerClientId === ownerClientId ? session : null;
  }

  requireOwned(ownerClientId, sessionId) {
    const session = this.getOwned(ownerClientId, sessionId);
    if (!session) throw new Error('会话不存在或不属于当前浏览器。');
    return session;
  }

  restore(ownerClientId, sessionIds) {
    return sessionIds.map((id) => this.getOwned(ownerClientId, id)).filter(Boolean);
  }

  async shutdown() {
    this.accepting = false;
    await Promise.allSettled([...this.sessions.values()].map((session) => session.stop()));
  }
}
```

- [ ] **Step 4: Run manager and all previous unit tests.**

Run: `npm test`

Expected: all tests in `test/config.test.js`, `test/protocol.test.js`, `test/text-ring-buffer.test.js`, `test/terminal-session.test.js`, and `test/session-manager.test.js` PASS.

- [ ] **Step 5: Commit the session-manager task when a Git repository exists.**

Run: `git add server/session-manager.js test/session-manager.test.js && git commit -m "feat: enforce terminal session ownership and limits"`

Expected: a focused ownership-and-limits commit in a Git-initialized workspace.

### Task 5: Compose HTTP serving and WebSocket routing with output batching

**Files:**
- Create: `server/websocket-router.js`
- Create: `server/app.js`
- Create: `server/index.js`
- Test: `test/websocket-router.test.js`

- [ ] **Step 1: Write a failing WebSocket integration test.**

Create `test/websocket-router.test.js`:

```js
import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createLanTerminalServer } from '../server/app.js';

function fakePtyFactory() {
  const dataHandlers = [];
  const exitHandlers = [];
  return {
    pid: 9001,
    onData(handler) { dataHandlers.push(handler); },
    onExit(handler) { exitHandlers.push(handler); },
    write(data) { dataHandlers.forEach((handler) => handler(`echo:${data}`)); },
    resize() {},
    kill() { exitHandlers.forEach((handler) => handler({ exitCode: 0 })); }
  };
}

function nextMessage(socket) {
  return once(socket, 'message').then(([data]) => JSON.parse(data.toString()));
}

test('creates an owned session and routes terminal input to its output stream', async (t) => {
  const service = createLanTerminalServer({
    config: { host: '127.0.0.1', port: 0, allowedRoot: process.cwd(), maxSessionsPerClient: 8, maxSessionsTotal: 8, maxMessageBytes: 65536, maxHistoryBytes: 1024, outputBatchMs: 0 },
    ptyFactory: fakePtyFactory,
    resolveCwd: () => process.cwd()
  });
  await service.listen();
  t.after(() => service.close());

  const port = service.server.address().port;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', payload: { clientId: 'browser-a', sessionIds: [] } }));
  socket.send(JSON.stringify({ type: 'create', payload: { shell: 'cmd', label: '', cwd: '.', cols: 80, rows: 24 } }));
  const status = await nextMessage(socket);
  assert.equal(status.type, 'status');
  assert.equal(status.payload.state, 'running');

  socket.send(JSON.stringify({ type: 'input', sessionId: status.sessionId, payload: { data: 'dir\\r' } }));
  const output = await nextMessage(socket);
  assert.deepEqual(output, { type: 'output', sessionId: status.sessionId, payload: { data: 'echo:dir\\r' } });

  socket.close();
  await once(socket, 'close');
  const restoredSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await once(restoredSocket, 'open');
  restoredSocket.send(JSON.stringify({ type: 'hello', payload: { clientId: 'browser-a', sessionIds: [status.sessionId] } }));
  const restoredStatus = await nextMessage(restoredSocket);
  const replay = await nextMessage(restoredSocket);
  assert.equal(restoredStatus.sessionId, status.sessionId);
  assert.deepEqual(replay, { type: 'output', sessionId: status.sessionId, payload: { data: 'echo:dir\\r', replay: true } });
});
```

- [ ] **Step 2: Run the integration test to verify it fails.**

Run: `node --test test/websocket-router.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server/app.js`.

- [ ] **Step 3: Implement the WebSocket router.**

Create `server/websocket-router.js`:

```js
import { WebSocketServer, WebSocket } from 'ws';
import { ProtocolError, parseClientMessage, serverMessage } from './protocol.js';

function statusPayload(session) {
  return { ...session.snapshot(), historyBytes: Buffer.byteLength(session.history(), 'utf8') };
}

function tailToByteLength(text, maximumBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maximumBytes) return text;
  let start = text.length;
  while (start > 0 && Buffer.byteLength(text.slice(start), 'utf8') <= maximumBytes) start -= 1;
  start += 1;
  while (start < text.length && start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start += 1;
  return text.slice(start);
}

export function installWebSocketRouter(server, manager, config, logger = console) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: config.maxMessageBytes });
  const clients = new Map();
  const pendingOutput = new Map();
  let flushTimer = null;

  const safeSend = (socket, type, sessionId, payload) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(serverMessage(type, sessionId, payload));
  };
  const subscribers = (sessionId) => [...clients.entries()]
    .filter(([, client]) => client.sessionIds.has(sessionId))
    .map(([socket]) => socket);
  const flushOutput = () => {
    flushTimer = null;
    for (const [socket, chunks] of pendingOutput) {
      for (const [sessionId, data] of chunks) safeSend(socket, 'output', sessionId, { data });
    }
    pendingOutput.clear();
  };
  const queueOutput = (session, data) => {
    for (const socket of subscribers(session.id)) {
      const chunks = pendingOutput.get(socket) || new Map();
      chunks.set(session.id, tailToByteLength((chunks.get(session.id) || '') + data, config.maxHistoryBytes));
      pendingOutput.set(socket, chunks);
    }
    if (flushTimer === null) flushTimer = setTimeout(flushOutput, config.outputBatchMs);
  };

  manager.on('output', queueOutput);
  manager.on('status', (session) => {
    for (const socket of subscribers(session.id)) safeSend(socket, 'status', session.id, statusPayload(session));
  });

  wss.on('connection', (socket) => {
    clients.set(socket, { clientId: null, sessionIds: new Set() });
    socket.on('close', () => { clients.delete(socket); pendingOutput.delete(socket); });
    socket.on('error', (error) => logger.warn?.('WebSocket error', error.message));
    socket.on('message', async (raw) => {
      try {
        const message = parseClientMessage(raw, config);
        const client = clients.get(socket);
        if (message.type === 'hello') {
          client.clientId = message.payload.clientId;
          for (const session of manager.restore(client.clientId, message.payload.sessionIds)) {
            client.sessionIds.add(session.id);
            safeSend(socket, 'status', session.id, statusPayload(session));
            const history = session.history();
            if (history) safeSend(socket, 'output', session.id, { data: history, replay: true });
          }
          return;
        }
        if (!client.clientId) throw new ProtocolError('请先发送 hello 消息。');
        if (message.type === 'create') {
          const session = manager.create(client.clientId, message.payload);
          client.sessionIds.add(session.id);
          safeSend(socket, 'status', session.id, statusPayload(session));
          return;
        }
        const session = manager.requireOwned(client.clientId, message.sessionId);
        client.sessionIds.add(session.id);
        if (message.type === 'input') session.write(message.payload.data);
        if (message.type === 'resize') session.resize(message.payload.cols, message.payload.rows);
        if (message.type === 'stop') await session.stop();
        if (message.type === 'restart') await session.restart();
      } catch (error) {
        const message = error instanceof ProtocolError ? error.message : (error.message || '终端操作失败。');
        safeSend(socket, 'error', undefined, { message });
      }
    });
  });

  return {
    async close() {
      if (flushTimer !== null) clearTimeout(flushTimer);
      for (const socket of clients.keys()) socket.close(1001, '服务器正在关闭');
      await new Promise((resolve) => wss.close(resolve));
    }
  };
}
```

- [ ] **Step 4: Implement composable Express hosting and the production entry point.**

Create `server/app.js`:

```js
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pty from 'node-pty';
import { loadConfig } from './config.js';
import { SessionManager } from './session-manager.js';
import { installWebSocketRouter } from './websocket-router.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createLanTerminalServer({ config = loadConfig(), ptyFactory = pty.spawn, resolveCwd, logger = console } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => response.json({ ok: true }));
  app.use('/vendor/xterm', express.static(path.join(projectRoot, 'node_modules', '@xterm', 'xterm')));
  app.use('/vendor/xterm-fit', express.static(path.join(projectRoot, 'node_modules', '@xterm', 'addon-fit')));
  app.use(express.static(path.join(projectRoot, 'public'), { extensions: ['html'] }));

  const manager = new SessionManager({ ...config, ptyFactory, ...(resolveCwd ? { resolveCwd } : {}) });
  const server = http.createServer(app);
  const router = installWebSocketRouter(server, manager, config, logger);
  return {
    app,
    server,
    manager,
    listen: () => new Promise((resolve, reject) => {
      const fail = (error) => { server.off('error', fail); reject(error); };
      server.once('error', fail);
      server.listen(config.port, config.host, () => { server.off('error', fail); resolve(); });
    }),
    async close() {
      await manager.shutdown();
      await router.close();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
  };
}
```

Create `server/index.js`:

```js
import 'dotenv/config';
import { createLanTerminalServer } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const service = createLanTerminalServer({ config });
let closing = false;

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.info(`收到 ${signal}，正在结束终端会话…`);
  await service.close();
  process.exitCode = 0;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
service.listen().then(() => console.info(`LAN Terminal 已监听 http://${config.host}:${config.port}`));
```

- [ ] **Step 5: Run the integration test, then the entire test suite.**

Run: `node --test test/websocket-router.test.js && npm test`

Expected: the integration test receives `status` followed by `output`; all project tests PASS.

- [ ] **Step 6: Commit the server transport task when a Git repository exists.**

Run: `git add server/websocket-router.js server/app.js server/index.js test/websocket-router.test.js && git commit -m "feat: serve and route LAN terminal websocket sessions"`

Expected: a focused HTTP/WebSocket transport commit in a Git-initialized workspace.

### Task 6: Build the browser terminal workspace

**Files:**
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/ws-client.js`
- Create: `public/workspace.js`
- Create: `public/app.js`

- [ ] **Step 1: Create the semantic page shell and load locally hosted terminal assets.**

Create `public/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>LAN Terminal</title>
    <link rel="stylesheet" href="/vendor/xterm/css/xterm.css" />
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="workspace" aria-label="局域网终端工作台">
      <aside class="sidebar" id="sidebar">
        <div class="brand"><span class="brand-mark">&gt;_</span><div><strong>LAN Terminal</strong><small>Windows Host</small></div></div>
        <button class="primary-button" id="show-create" type="button">＋ 新建终端</button>
        <nav class="session-list" id="session-list" aria-label="终端会话"></nav>
        <p class="warning">无认证模式：任何能访问此地址的人，都将以服务器 Windows 账号执行命令。</p>
      </aside>
      <section class="terminal-area">
        <header class="toolbar">
          <button class="mobile-menu" id="toggle-sidebar" type="button" aria-label="显示会话列表">☰</button>
          <div class="session-detail"><strong id="session-title">选择或新建终端</strong><span id="session-meta">未连接</span></div>
          <div class="toolbar-actions">
            <button id="reconnect" type="button">重新连接</button>
            <button id="clear" type="button">清空显示</button>
            <button id="restart" type="button" class="warning-button">重启</button>
            <button id="stop" type="button" class="danger-button">停止</button>
          </div>
        </header>
        <div class="connection-banner" id="connection-banner" role="status">正在连接服务…</div>
        <div class="terminal-host" id="terminal-host" aria-live="polite"><div class="empty-state">从左侧新建一个 PowerShell 或 CMD 会话。</div></div>
      </section>
    </main>
    <dialog id="create-dialog">
      <form method="dialog" id="create-form">
        <header><h1>新建终端</h1><button type="button" id="close-create" aria-label="关闭">×</button></header>
        <label>终端类型<select name="shell"><option value="powershell">PowerShell</option><option value="cmd">CMD</option></select></label>
        <label>会话名称（可选）<input name="label" maxlength="64" placeholder="例如：部署检查" /></label>
        <label>初始工作目录<input name="cwd" value="." maxlength="1024" /><small>相对允许目录的路径；例如 <code>projects\\demo</code>。</small></label>
        <footer><button type="button" id="cancel-create">取消</button><button class="primary-button" value="create">创建并连接</button></footer>
      </form>
    </dialog>
    <script src="/vendor/xterm/lib/xterm.js"></script>
    <script src="/vendor/xterm-fit/lib/xterm-addon-fit.js"></script>
    <script type="module" src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Implement the reconnecting browser WebSocket client.**

Create `public/ws-client.js`:

```js
const CLIENT_ID_KEY = 'lan-terminal-client-id';
const SESSION_IDS_KEY = 'lan-terminal-session-ids';

export function getClientId() {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function loadSessionIds() {
  try { return JSON.parse(localStorage.getItem(SESSION_IDS_KEY) || '[]'); } catch { return []; }
}

export function saveSessionIds(ids) {
  localStorage.setItem(SESSION_IDS_KEY, JSON.stringify([...new Set(ids)].slice(0, 64)));
}

export class TerminalSocket extends EventTarget {
  constructor({ clientId = getClientId(), sessionIds = loadSessionIds }) {
    super();
    this.clientId = clientId;
    this.sessionIds = sessionIds;
    this.socket = null;
    this.delay = 500;
    this.retryTimer = null;
  }

  connect() {
    clearTimeout(this.retryTimer);
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    this.socket = new WebSocket(`${scheme}://${location.host}/ws`);
    this.socket.addEventListener('open', () => {
      this.delay = 500;
      this.send('hello', { clientId: this.clientId, sessionIds: this.sessionIds() });
      this.dispatchEvent(new Event('connected'));
    });
    this.socket.addEventListener('message', (event) => this.dispatchEvent(new CustomEvent('message', { detail: JSON.parse(event.data) })));
    this.socket.addEventListener('close', () => {
      this.dispatchEvent(new Event('disconnected'));
      this.retryTimer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 5000);
    });
    this.socket.addEventListener('error', () => this.dispatchEvent(new Event('disconnected')));
  }

  reconnect() {
    if (this.socket) this.socket.close(1000, '用户请求重新连接');
    else this.connect();
  }

  send(type, payload = {}, sessionId) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('服务未连接。');
    this.socket.send(JSON.stringify({ type, ...(sessionId ? { sessionId } : {}), payload }));
  }
}
```

- [ ] **Step 3: Implement terminal ownership in the browser and UI event handling.**

Create `public/workspace.js`:

```js
const { Terminal } = window;
const { FitAddon } = window.FitAddon;

function stateLabel(state) {
  return ({ running: '运行中', stopping: '正在停止', exited: '已退出', error: '错误', created: '创建中' })[state] || state;
}

export class Workspace {
  constructor({ socket, elements, saveSessionIds }) {
    this.socket = socket;
    this.elements = elements;
    this.saveSessionIds = saveSessionIds;
    this.sessions = new Map();
    this.activeId = null;
    this.socket.addEventListener('message', ({ detail }) => this.handleMessage(detail));
    this.socket.addEventListener('connected', () => this.setConnection(true));
    this.socket.addEventListener('disconnected', () => this.setConnection(false));
  }

  setConnection(connected) {
    this.elements.banner.textContent = connected ? '已连接到 LAN Terminal 服务' : '与服务断开，正在自动重连…';
    this.elements.banner.classList.toggle('offline', !connected);
  }

  create(request) {
    const { cols, rows } = this.measure();
    this.socket.send('create', { ...request, cols, rows });
  }

  handleMessage(message) {
    if (message.type === 'error') return window.alert(message.payload.message);
    if (message.type === 'status') this.upsertSession(message.sessionId, message.payload);
    if (message.type === 'output') {
      const session = this.ensureTerminal(message.sessionId);
      if (message.payload.replay) session.terminal.reset();
      session.terminal.write(message.payload.data);
    }
  }

  upsertSession(id, details) {
    const session = this.ensureTerminal(id, details);
    Object.assign(session, details);
    this.persist();
    this.renderList();
    if (!this.activeId) this.select(id);
    if (this.activeId === id) this.renderActive();
  }

  ensureTerminal(id, details = {}) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    const pane = document.createElement('div');
    pane.className = 'terminal-pane';
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 14, theme: { background: '#0b1115', foreground: '#d8e4e8', cursor: '#7ee2c5', selectionBackground: '#26424a' } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(pane);
    terminal.onData((data) => {
      const session = this.sessions.get(id);
      if (session?.state === 'running') this.socket.send('input', { data }, id);
    });
    this.elements.host.append(pane);
    const session = { id, terminal, fit, pane, shell: 'cmd', cwd: '', state: 'created', ...details };
    this.sessions.set(id, session);
    return session;
  }

  select(id) {
    this.activeId = id;
    for (const session of this.sessions.values()) session.pane.classList.toggle('active', session.id === id);
    this.renderList();
    this.renderActive();
    requestAnimationFrame(() => this.resizeActive());
  }

  renderList() {
    this.elements.list.replaceChildren(...[...this.sessions.values()].map((session) => {
      const button = document.createElement('button');
      button.className = `session-item ${session.id === this.activeId ? 'selected' : ''}`;
      const name = session.label || (session.shell === 'powershell' ? 'PowerShell' : 'CMD');
      const created = session.createdAt ? new Date(session.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '--:--';
      button.innerHTML = `<span class="status-dot ${session.state}"></span><span><strong>${name}</strong><small>${stateLabel(session.state)} · ${created} · ${session.id.slice(0, 8)}</small></span>`;
      button.addEventListener('click', () => this.select(session.id));
      return button;
    }));
  }

  renderActive() {
    const session = this.sessions.get(this.activeId);
    this.elements.title.textContent = session ? `${session.label || (session.shell === 'powershell' ? 'PowerShell' : 'CMD')} ${session.pid ? `· PID ${session.pid}` : ''}` : '选择或新建终端';
    this.elements.meta.textContent = session ? `${stateLabel(session.state)} · ${session.cwd}` : '未连接';
  }

  measure() {
    const session = this.sessions.get(this.activeId);
    if (session) { session.fit.fit(); return { cols: session.terminal.cols, rows: session.terminal.rows }; }
    return { cols: 100, rows: 30 };
  }

  resizeActive() {
    const session = this.sessions.get(this.activeId);
    if (!session) return;
    session.fit.fit();
    if (session.state === 'running') this.socket.send('resize', { cols: session.terminal.cols, rows: session.terminal.rows }, session.id);
  }

  clearActive() { this.sessions.get(this.activeId)?.terminal.clear(); }
  stopActive() { if (this.activeId) this.socket.send('stop', {}, this.activeId); }
  restartActive() { if (this.activeId) this.socket.send('restart', {}, this.activeId); }
  reconnect() { this.socket.reconnect(); }
  persist() { this.saveSessionIds([...this.sessions.keys()]); }
}
```

Create `public/app.js`:

```js
import { saveSessionIds, TerminalSocket } from './ws-client.js';
import { Workspace } from './workspace.js';

const $ = (id) => document.getElementById(id);
const socket = new TerminalSocket();
const workspace = new Workspace({
  socket,
  saveSessionIds,
  elements: { list: $('session-list'), host: $('terminal-host'), title: $('session-title'), meta: $('session-meta'), banner: $('connection-banner') }
});
const dialog = $('create-dialog');

$('show-create').addEventListener('click', () => dialog.showModal());
$('close-create').addEventListener('click', () => dialog.close());
$('cancel-create').addEventListener('click', () => dialog.close());
$('create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    workspace.create({ shell: form.get('shell'), label: form.get('label'), cwd: form.get('cwd') });
    dialog.close();
  } catch (error) { window.alert(error.message); }
});
$('clear').addEventListener('click', () => workspace.clearActive());
$('reconnect').addEventListener('click', () => workspace.reconnect());
$('restart').addEventListener('click', () => workspace.restartActive());
$('stop').addEventListener('click', () => {
  if (window.confirm('停止会结束该终端进程。确定继续吗？')) workspace.stopActive();
});
$('toggle-sidebar').addEventListener('click', () => $('sidebar').classList.toggle('open'));
window.addEventListener('resize', () => workspace.resizeActive());
socket.connect();
```

- [ ] **Step 4: Add the responsive terminal-workspace styling.**

Create `public/styles.css`:

```css
:root { color-scheme: dark; font-family: Inter, "Microsoft YaHei", sans-serif; background: #070b0e; color: #d8e4e8; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; }
button, input, select { font: inherit; }
button { cursor: pointer; }
.workspace { min-height: 100vh; display: grid; grid-template-columns: 280px minmax(0, 1fr); background: #0b1115; }
.sidebar { background: #10191e; border-right: 1px solid #243239; padding: 20px 14px; display: flex; flex-direction: column; gap: 18px; }
.brand { display: flex; align-items: center; gap: 10px; }.brand-mark { color: #7ee2c5; font: 700 24px/1 ui-monospace, monospace; }.brand small, .session-item small { display: block; color: #8da1a9; margin-top: 3px; }
.primary-button { border: 0; border-radius: 8px; background: #50caa8; color: #05221b; font-weight: 700; padding: 10px 12px; }.primary-button:hover { background: #7ee2c5; }
.session-list { display: grid; gap: 6px; overflow-y: auto; }.session-item { border: 1px solid transparent; background: transparent; color: inherit; text-align: left; padding: 10px; border-radius: 8px; display: flex; gap: 9px; }.session-item:hover, .session-item.selected { background: #17252b; border-color: #2b4b52; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; background: #75838a; }.status-dot.running { background: #50caa8; box-shadow: 0 0 8px #50caa8; }.status-dot.error { background: #f49a71; }.status-dot.exited { background: #75838a; }
.warning { margin-top: auto; color: #f3b37d; font-size: 12px; line-height: 1.5; border-top: 1px solid #344249; padding-top: 14px; }
.terminal-area { min-width: 0; display: grid; grid-template-rows: auto auto minmax(0, 1fr); }.toolbar { min-height: 70px; display: flex; align-items: center; gap: 16px; padding: 12px 20px; border-bottom: 1px solid #243239; background: #0e161b; }.session-detail { min-width: 0; flex: 1; }.session-detail strong, .session-detail span { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }.session-detail span { color: #8da1a9; font-size: 12px; margin-top: 4px; }.toolbar-actions { display: flex; gap: 8px; }.toolbar-actions button, dialog button { border: 1px solid #3a4a51; color: #d8e4e8; background: #17252b; border-radius: 7px; padding: 8px 10px; }.toolbar-actions .warning-button { border-color: #9c7442; color: #f3b37d; }.toolbar-actions .danger-button { border-color: #9b5448; color: #f49a71; }
.connection-banner { color: #9bb0b7; background: #102027; padding: 7px 20px; font-size: 12px; }.connection-banner.offline { background: #3b211c; color: #f3b37d; }.terminal-host { min-height: 0; position: relative; padding: 16px; }.terminal-pane { display: none; width: 100%; height: 100%; }.terminal-pane.active { display: block; }.xterm { height: 100%; }.empty-state { display: grid; place-items: center; height: 100%; color: #71858d; }
dialog { width: min(440px, calc(100vw - 32px)); border: 1px solid #365059; border-radius: 12px; background: #10191e; color: #d8e4e8; padding: 0; }dialog::backdrop { background: rgb(0 0 0 / 70%); }dialog form { display: grid; gap: 15px; padding: 20px; }dialog header, dialog footer { display: flex; align-items: center; justify-content: space-between; }dialog h1 { font-size: 18px; margin: 0; }dialog label { display: grid; gap: 7px; font-size: 13px; color: #b8c7cc; }dialog input, dialog select { background: #081015; border: 1px solid #3a4a51; border-radius: 7px; padding: 9px; color: inherit; }dialog small { color: #8da1a9; }dialog footer { justify-content: flex-end; gap: 8px; }.mobile-menu { display: none; }
@media (max-width: 760px) { .workspace { display: block; }.sidebar { position: fixed; inset: 0 auto 0 0; width: min(280px, 85vw); z-index: 10; transform: translateX(-100%); transition: transform 160ms ease; }.sidebar.open { transform: translateX(0); box-shadow: 12px 0 30px #0008; }.mobile-menu { display: block; background: transparent; color: inherit; border: 0; font-size: 20px; }.toolbar { padding: 10px 12px; align-items: flex-start; }.toolbar-actions { flex-wrap: wrap; justify-content: flex-end; }.terminal-host { padding: 8px; height: calc(100vh - 126px); } }
```

- [ ] **Step 5: Start the service and perform the browser smoke checks.**

Run: `npm start`

Expected: server prints `LAN Terminal 已监听 http://0.0.0.0:3000`.

Manually verify at `http://localhost:3000`:

1. Create a PowerShell session and run `Write-Host "hello"`.
2. Create a CMD session, switch between sessions, and run `echo hello`.
3. Refresh; both sessions reappear and the still-running process remains usable.
4. Resize the browser and confirm a command line wraps without clipping.
5. Click Stop, confirm the dialog, then click Restart to get a new process.
6. Use a phone-width viewport and verify the session drawer opens via the menu button.

- [ ] **Step 6: Commit the browser workspace task when a Git repository exists.**

Run: `git add public && git commit -m "feat: add browser terminal workspace"`

Expected: a focused frontend commit in a Git-initialized workspace.

### Task 7: Document trusted-LAN deployment and perform final verification

**Files:**
- Create: `README.md`
- Modify: `.env.example`

- [ ] **Step 1: Write the operational documentation.**

Create `README.md`:

```markdown
# LAN Terminal

在一台 Windows 主机上运行的局域网网页终端。浏览器可以创建独立的 PowerShell 或 CMD 会话；关闭或刷新浏览器不会结束会话，直到手动停止或服务器关闭。

## 安全边界

此程序**没有登录认证**。任何能访问服务 IP 和端口的人，都可以以运行本程序的 Windows 账号执行命令。仅用于可信局域网：不要把端口映射到公网，不要以管理员账号运行，也不要在不可信 Wi-Fi 中开启服务。

会话的浏览器归属依靠该浏览器本地保存的随机 ID，用于日常隔离与刷新恢复；它不是安全认证机制。

## 安装

需要 Windows 10/11、Node.js 20 或更高版本，以及可编译或安装 `node-pty` 原生模块的环境。

```powershell
npm install
Copy-Item .env.example .env
```

启动服务会自动读取 `.env`。最少设置 `ALLOWED_ROOT` 为要允许终端访问的工作目录。默认监听 `0.0.0.0:3000`。

```powershell
$env:ALLOWED_ROOT = 'C:\\Users\\Public'
$env:HOST = '0.0.0.0'
$env:PORT = '3000'
npm start
```

访问 `http://<Windows-主机的局域网-IP>:3000`。在主机上用 `ipconfig` 查看 IPv4 地址。

## Windows 防火墙

只在确认网络可信时，用管理员 PowerShell 添加入站规则：

```powershell
New-NetFirewallRule -DisplayName 'LAN Terminal TCP 3000' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

若不再使用，用以下命令删除该规则：

```powershell
Remove-NetFirewallRule -DisplayName 'LAN Terminal TCP 3000'
```

## 配置

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address; prefer one LAN adapter address when practical. |
| `PORT` | `3000` | HTTP and WebSocket port. |
| `ALLOWED_ROOT` | service working directory | Only this directory and real subdirectories can be terminal start directories. |
| `MAX_SESSIONS_PER_CLIENT` | `8` | Maximum retained sessions per browser identity. |
| `MAX_SESSIONS_TOTAL` | `64` | Maximum retained sessions on the host. |
| `MAX_MESSAGE_BYTES` | `65536` | Maximum inbound WebSocket message size. |
| `MAX_HISTORY_BYTES` | `524288` | Per-session retained terminal output. |
| `OUTPUT_BATCH_MS` | `16` | Output batching interval for busy commands. |

## Verification

```powershell
npm test
Invoke-WebRequest http://localhost:3000/healthz
```

The health check returns `{"ok":true}`. Use the browser smoke checks in the implementation plan before sharing the service on the LAN.
```

- [ ] **Step 2: Verify all automated checks and a production-style start.**

Run: `npm test`

Expected: all unit and WebSocket integration tests PASS.

Run: `$env:ALLOWED_ROOT = (Get-Location).Path; npm start`

Expected: startup succeeds; `Invoke-WebRequest http://localhost:3000/healthz` returns HTTP 200 with `{"ok":true}`. Stop the server with `Ctrl+C` and confirm it reports session shutdown without uncaught errors.

- [ ] **Step 3: Re-run the LAN safety checklist before handoff.**

Verify all of the following:

1. The service runs under a non-administrator Windows account.
2. `ALLOWED_ROOT` is a deliberate, minimal working directory rather than the whole drive.
3. Windows Firewall allows the port only on the `Private` profile.
4. No router, reverse proxy, or port-forwarding rule exposes this port to the internet.
5. The yellow no-authentication warning is visible on the page.

- [ ] **Step 4: Commit documentation when a Git repository exists.**

Run: `git add README.md .env.example && git commit -m "docs: explain trusted LAN terminal deployment"`

Expected: a documentation commit in a Git-initialized workspace.

## Plan self-review

**Spec coverage:** Tasks 1 and 7 cover LAN binding, allowed paths, configuration, firewall and no-auth mode. Tasks 2 and 5 implement typed messages, size validation, errors, reconnection, and batched output. Tasks 3 and 4 provide real PTY lifecycle, isolated browser ownership, per-browser/global quotas, history, restart/stop, and shutdown cleanup. Task 6 implements the PowerShell/CMD UI, session list, controls, terminal rendering, responsive layout, output display, resize, and browser refresh recovery. Tasks 1–5 provide unit and WebSocket integration coverage; Tasks 6–7 provide explicit browser and Windows smoke checks.

**Placeholder scan:** No unfinished markers or generic test/error-handling directions remain; every code-producing task names its file and supplies the intended implementation.

**Consistency check:** The browser sends `hello`, `create`, `input`, `resize`, `stop`, and `restart`, exactly matching `parseClientMessage`. Server responses use `status`, `output`, and `error`. `clientId` and `sessionIds` persist in `localStorage`; `SessionManager` enforces them before `websocket-router` accepts any operation.
