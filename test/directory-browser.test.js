import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { listAnyDirectories, listDirectories } from '../server/directory-browser.js';

function withTemporaryTree(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-directories-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lan-terminal-outside-'));

  try {
    fs.mkdirSync(path.join(root, 'alpha', 'child'), { recursive: true });
    fs.mkdirSync(path.join(root, 'beta'));
    fs.writeFileSync(path.join(root, 'ignore.txt'), 'not a directory');
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
    return callback(root, outside);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

test('lists direct allowed child directories with relative paths', () => {
  withTemporaryTree((root) => {
    assert.deepEqual(listDirectories(root, '.'), {
      path: '.',
      parent: null,
      directories: [
        { name: 'alpha', path: 'alpha' },
        { name: 'beta', path: 'beta' },
      ],
    });
    assert.deepEqual(listDirectories(root, 'alpha'), {
      path: 'alpha',
      parent: '.',
      directories: [{ name: 'child', path: path.join('alpha', 'child') }],
    });
  });
});

test('rejects traversal and hides a linked directory outside the allowed root', () => {
  withTemporaryTree((root) => {
    assert.throws(() => listDirectories(root, '..'), /允许目录/);
    assert.deepEqual(
      listDirectories(root, '.').directories.map((item) => item.name),
      ['alpha', 'beta'],
    );
  });
});

test('caps a directory response at 500 sorted entries', () => {
  withTemporaryTree((root) => {
    for (let index = 0; index < 501; index += 1) {
      fs.mkdirSync(path.join(root, `item-${index}`));
    }

    const result = listDirectories(root, '.');
    assert.equal(result.directories.length, 500);
    assert.equal(result.directories[0].name, 'alpha');
    assert.ok(!result.directories.some((item) => item.name === 'escape'));
  });
});

test('lists an administrator directory with absolute paths', () => {
  withTemporaryTree((root, outside) => {
    const result = listAnyDirectories(root);
    assert.equal(result.path, fs.realpathSync(root));
    assert.equal(result.parent, path.dirname(fs.realpathSync(root)));
    assert.deepEqual(result.directories.map((item) => item.path), [
      path.join(fs.realpathSync(root), 'alpha'),
      path.join(fs.realpathSync(root), 'beta'),
      fs.realpathSync(outside),
    ]);
  });
});
