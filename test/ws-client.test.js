import assert from 'node:assert/strict';
import test from 'node:test';
import { getClientId } from '../public/ws-client.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function restoreGlobal(name, descriptor) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
}

test('getClientId creates and stores an ID when randomUUID is unavailable', () => {
  const localStorageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const storage = memoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues(bytes) {
        bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
        return bytes;
      },
    },
  });

  try {
    const id = getClientId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(storage.getItem('lan-terminal-client-id'), id);
  } finally {
    restoreGlobal('localStorage', localStorageDescriptor);
    restoreGlobal('crypto', cryptoDescriptor);
  }
});
