import {
  describe,
  expect,
  it
} from 'vitest';

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
});

describe('query algebra', () => {
  it('short-circuits none and all', () => {
    expect(formatQuery(andQuery([orQuery([]), literalQuery('abc')]))).toBe('-');
    expect(formatQuery(orQuery([literalQuery('abc'), literalQuery('a')]))).toBe('*');
    expect(formatQuery(orQuery([]))).toBe('-');
  });

  it('round-trips a packed trigram', () => {
    expect(unpackTrigram(packTrigram(0x4_16, 0x4_1A, 0xFF_FF))).toBe('ЖК￿');
  });
});
