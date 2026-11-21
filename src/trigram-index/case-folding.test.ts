import {
  describe,
  expect,
  it
} from 'vitest';

import {
  foldText,
  getFoldTable
} from './case-folding.ts';

const CODE_UNIT_COUNT = 0x1_00_00;
const REGEX_CHUNK_SIZE = 256;
const SURROGATE_START = 0xD8_00;
const SURROGATE_END = 0xDF_FF;

function doesIFlagMatchFold(codeUnits: readonly number[], table: Uint16Array): boolean {
  const source = codeUnits.map((codeUnit) => String.raw`\u${codeUnit.toString(16).padStart(4, '0')}`).join('');
  // eslint-disable-next-line unicorn/prefer-code-point -- the fold maps UTF-16 code units, which is what i compares.
  const folded = String.fromCharCode(...codeUnits.map((codeUnit) => table[codeUnit] ?? 0));
  return new RegExp(`^${source}$`, 'i').test(folded);
}

describe('foldText', () => {
  it('folds every pair of code units the i flag equates to one form', () => {
    expect(foldText('σςΣ')).toBe('ΣΣΣ');
    expect(foldText('quillwort')).toBe(foldText('QUILLWORT'));
    expect(foldText('журавлина')).toBe(foldText('ЖУРАВЛИНА'));
  });

  it('keeps apart what the i flag keeps apart', () => {
    expect(/k/i.test('K')).toBe(false);
    expect(foldText('K')).not.toBe(foldText('k'));
    expect(foldText('ſ')).not.toBe(foldText('s'));
  });

  it('agrees with the i flag on every code unit', () => {
    const table = getFoldTable();
    const mismatches: number[] = [];
    for (let codeUnit = 0; codeUnit < CODE_UNIT_COUNT; codeUnit++) {
      const folded = table[codeUnit] ?? 0;
      if (table[folded] !== folded) {
        mismatches.push(codeUnit);
      }
    }
    // One regex per chunk of code units, not one per code unit: 63,488 regexes took 1.8 s idle, 7.5 s loaded.
    // A chunk that fails is checked unit by unit, so the mismatches are still named.
    for (let chunkStart = 0; chunkStart < CODE_UNIT_COUNT; chunkStart += REGEX_CHUNK_SIZE) {
      const codeUnits: number[] = [];
      for (let codeUnit = chunkStart; codeUnit < chunkStart + REGEX_CHUNK_SIZE; codeUnit++) {
        if (codeUnit < SURROGATE_START || codeUnit > SURROGATE_END) {
          codeUnits.push(codeUnit);
        }
      }
      if (codeUnits.length > 0 && !doesIFlagMatchFold(codeUnits, table)) {
        mismatches.push(...codeUnits.filter((codeUnit) => !doesIFlagMatchFold([codeUnit], table)));
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('keeps the length of long text', () => {
    const text = 'Aб'.repeat(10_000);
    expect(foldText(text)).toHaveLength(text.length);
  });
});
