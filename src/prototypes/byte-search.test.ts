import {
  describe,
  expect,
  it
} from 'vitest';

import { findFilesContaining } from './byte-search.ts';

const encoder = new TextEncoder();

describe('findFilesContaining', () => {
  it('reports each containing file once and never a match across a boundary', () => {
    const texts = ['xxabcxxabc', 'ab', 'cab', '', 'zzABCabc'];
    const parts = texts.map((text) => encoder.encode(text));
    const offsets = new Uint32Array(texts.length + 1);
    let position = 0;
    for (const [index, part] of parts.entries()) {
      offsets[index] = position;
      position += part.length;
    }
    offsets[texts.length] = position;
    const bytes = new Uint8Array(position);
    for (const [index, part] of parts.entries()) {
      bytes.set(part, offsets[index]);
    }
    expect([...findFilesContaining({ bytes, offsets, pattern: encoder.encode('abc') })]).toEqual([0, 4]);
  });

  it('finds a multi-byte pattern', () => {
    const bytes = encoder.encode('ЖУРАВЛИНА');
    const offsets = Uint32Array.from([0, bytes.length]);
    expect([...findFilesContaining({ bytes, offsets, pattern: encoder.encode('ВЛИ') })]).toEqual([0]);
  });
});
