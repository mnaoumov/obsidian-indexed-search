import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { parse } from 'regjsparser';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { TrigramQuery } from './trigram-query.ts';

import {
  andQuery,
  canTextSatisfy,
  collectTrigrams,
  formatQuery,
  literalQuery,
  orQuery,
  packTrigram,
  regexQuery,
  unpackTrigram
} from './trigram-query.ts';

vi.mock('regjsparser', async (importOriginal) => {
  const original = await importOriginal<typeof import('regjsparser')>();
  return { ...original, parse: vi.fn(original.parse) };
});

describe('canTextSatisfy', () => {
  it('checks a text for the trigrams a query requires, folded', () => {
    expect(canTextSatisfy(literalQuery('quill'), 'plants/QUILLWORT.md')).toBe(true);
    expect(canTextSatisfy(literalQuery('quill'), 'plants/quilt.md')).toBe(false);
  });

  it('evaluates AND, OR, all and none', () => {
    expect(canTextSatisfy(regexQuery('foo(bar|baz)'), 'a foobaz b')).toBe(true);
    expect(canTextSatisfy(regexQuery('foo(bar|baz)'), 'a foobax b')).toBe(false);
    expect(canTextSatisfy({ kind: 'all' }, '')).toBe(true);
    expect(canTextSatisfy({ kind: 'none' }, 'anything')).toBe(false);
  });
});

describe('literalQuery', () => {
  it('requires every folded trigram of the term', () => {
    expect(formatQuery(literalQuery('Quill'))).toBe('(QUI AND UIL AND ILL)');
  });

  it('narrows nothing for a term shorter than a trigram', () => {
    expect(formatQuery(literalQuery('ab'))).toBe('*');
  });

  it('dedupes repeated trigrams', () => {
    expect(formatQuery(literalQuery('aaaa'))).toBe('AAA');
  });
});

describe('regexQuery', () => {
  it.each([
    ['foo', 'FOO'],
    ['foo(bar|baz)', '((FOO AND OOB AND OBA AND BAR) OR (FOO AND OOB AND OBA AND BAZ))'],
    ['harbou?r', '((HAR AND ARB AND RBO AND BOU AND OUR) OR (HAR AND ARB AND RBO AND BOR))'],
    ['.*', '*'],
    [String.raw`\d+`, '*'],
    ['ab', '*'],
    ['[0-9]{5}', '*'],
    ['(a', '*'],
    ['^foo$', 'FOO']
  ])('derives %s as %s', (source, expected) => {
    expect(formatQuery(regexQuery(source))).toBe(expected);
  });

  it('keeps the literal parts around a wildcard', () => {
    const trigrams = Array.from(collectTrigrams(regexQuery('silver.*lantern')), unpackTrigram);
    expect(trigrams).toEqual(expect.arrayContaining(['SIL', 'VER', 'LAN', 'ERN']));
  });

  it('carries required trigrams through a plus', () => {
    expect(formatQuery(regexQuery('(quill)+wort'))).toContain('QUI');
  });

  it('narrows nothing through a backreference', () => {
    expect(formatQuery(regexQuery(String.raw`(a)\1`))).toBe('*');
  });

  // The sample texts are letter runs built to hit or miss each regex, not words.
  // cspell:disable
  it.each([
    { matching: ['xquill', 'Bquill'], other: ['quil'], source: '[^a]quill' },
    { matching: ['adef', 'CDEF'], other: ['ddef'], source: '[abc]def' },
    { matching: ['bxyz', 'axyz'], other: ['dxyz'], source: '[a-c]xyz' },
    { matching: ['mxyz', 'Zxyz'], other: ['xy z'], source: '[a-z]xyz' },
    { matching: ['1xyz', 'axyz'], other: ['xy'], source: String.raw`[\da]xyz` },
    { matching: ['qxyz', 'axyz'], other: ['xyy'], source: '[abcdefghijklmnopq]xyz' },
    { matching: ['ajquill', 'iiirrquill'], other: ['aj quil'], source: '(a|b|c|d|e|f|g|h|i)+(j|k|l|m|n|o|p|q|r)+quill' },
    { matching: ['quill', 'xxquill', 'xquillwort'], other: ['quil'], source: 'x*quill' },
    { matching: ['abcdef', 'abc'], other: ['abd'], source: '(?=abc)abc' },
    { matching: ['quillwort'], other: ['quill wort'], source: 'quill(abc){0}wort' },
    { matching: ['quillwort'], other: ['quil'], source: '(quill){1}wort' },
    { matching: ['quilllll', 'b', ''], other: [], source: 'quil+|b*' },
    { matching: ['xyaezw', 'xyDIzw'], other: ['xyzw'], source: 'xy[abcd][efghi]zw' },
    { matching: ['xyae', 'XYDI'], other: ['xyzz'], source: 'xy[abcd][efghi]' },
    { matching: ['aeyx', 'DIYX'], other: ['zzyx'], source: '[abcd][efghi]yx' }
    // End of the sample texts.
    // cspell:enable
  ])('never rules out a text that $source matches, and rules out a text lacking its literals', ({ matching, other, source }) => {
    const query = regexQuery(source);
    // Core compiles a query regex with `gm` or `gmi`; `i` is the wider of the two.
    const regex = new RegExp(source, 'mi');
    for (const text of matching) {
      expect(regex.test(text)).toBe(true);
      expect(canTextSatisfy(query, text)).toBe(true);
    }
    for (const text of other) {
      expect(regex.test(text)).toBe(false);
      expect(canTextSatisfy(query, text)).toBe(false);
    }
  });

  it('matches no text for an empty class', () => {
    expect(formatQuery(regexQuery('[]quill'))).toBe('-');
  });

  it('rejects a parse node it does not know', () => {
    vi.mocked(parse).mockReturnValueOnce(castTo<ReturnType<typeof parse>>({ type: 'unknown' }));
    expect(() => regexQuery('quill')).toThrow('Unexpected value');
  });
});

describe('query algebra', () => {
  it('short-circuits none and all', () => {
    expect(formatQuery(andQuery([orQuery([]), literalQuery('abc')]))).toBe('-');
    expect(formatQuery(orQuery([literalQuery('abc'), literalQuery('a')]))).toBe('*');
    expect(formatQuery(orQuery([]))).toBe('-');
  });

  it('flattens a nested OR and drops a none child', () => {
    const nested = orQuery([literalQuery('abc'), literalQuery('def')]);
    expect(formatQuery(orQuery([nested, { kind: 'none' }, literalQuery('ghi')]))).toBe('(ABC OR DEF OR GHI)');
  });

  it('rejects an unknown query kind', () => {
    const unknown = castTo<TrigramQuery>({ kind: 'unknown' });
    expect(() => formatQuery(unknown)).toThrow('Unexpected value');
    expect(() => canTextSatisfy(unknown, 'abc')).toThrow('Unexpected value');
  });

  it('round-trips a packed trigram', () => {
    expect(unpackTrigram(packTrigram(0x4_16, 0x4_1A, 0xFF_FF))).toBe('ЖК￿');
  });
});
