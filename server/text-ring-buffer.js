function trimToBytes(text, maximumBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maximumBytes) return text;
  let start = 0;
  while (start < text.length && Buffer.byteLength(text.slice(start), 'utf8') > maximumBytes) start += 1;
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start += 1;
  return text.slice(start);
}

export class TextRingBuffer {
  constructor(maximumBytes) { this.maximumBytes = maximumBytes; this.value = ''; }
  append(text) { this.value = trimToBytes(this.value + String(text), this.maximumBytes); }
  clear() { this.value = ''; }
  toString() { return this.value; }
}
