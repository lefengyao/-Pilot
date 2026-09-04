import assert from 'node:assert/strict';
import test from 'node:test';
import { TextRingBuffer } from '../server/text-ring-buffer.js';
test('keeps newest UTF-8 text within byte budget', () => { const buffer = new TextRingBuffer(8); buffer.append('ab'); buffer.append('中文'); buffer.append('c'); assert.equal(buffer.toString(), 'b中文c'); assert.ok(Buffer.byteLength(buffer.toString()) <= 8); });
test('clears retained text', () => { const buffer = new TextRingBuffer(16); buffer.append('x'); buffer.clear(); assert.equal(buffer.toString(), ''); });
