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
      if (codeUnit >= 0xD8_00 && codeUnit <= 0xDF_FF) {
        continue;
      }
      const pattern = new RegExp(String.raw`^\u${codeUnit.toString(16).padStart(4, '0')}$`, 'i');
      // eslint-disable-next-line unicorn/prefer-code-point -- the fold maps UTF-16 code units, which is what i compares.
      if (!pattern.test(String.fromCharCode(folded))) {
        mismatches.push(codeUnit);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('keeps the length of long text', () => {
    const text = 'Aб'.repeat(10_000);
    expect(foldText(text)).toHaveLength(text.length);
  });
});
