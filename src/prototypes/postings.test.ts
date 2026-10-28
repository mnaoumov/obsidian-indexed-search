import {
  describe,
  expect,
  it
} from 'vitest';

import {
  decodePostings,
  encodePostings,
  evaluateQuery,
  intersect,
  unite
} from './postings.ts';
import { literalQuery } from './trigram-query.ts';

describe('posting codec', () => {
  it('round-trips ascending ids, large gaps included', () => {
    const ids = [0, 1, 2, 130, 20_000, 2_000_000_000];
    const bytes = encodePostings(ids, 0);
    const target = new Uint32Array(ids.length);
    expect(decodePostings({ base: 0, bytes, offset: 0, target })).toBe(ids.length);
    expect([...target]).toEqual(ids);
  });

  it('spends one byte per small gap', () => {
    expect(encodePostings([5, 6, 7], 5)).toHaveLength(3);
  });
});

describe('id list combination', () => {
  it('intersects and unites ascending lists', () => {
    const left = Uint32Array.from([1, 3, 5, 7]);
    const right = Uint32Array.from([3, 4, 7, 9]);
    expect([...intersect(left, right)]).toEqual([3, 7]);
    expect([...unite(left, right)]).toEqual([1, 3, 4, 5, 7, 9]);
  });
});

describe('evaluateQuery', () => {
  it('treats a common trigram as every file and a missing one as none', () => {
    const query = literalQuery('abcd');
    const [first, second] = [...collect(query)];
    const postings = new Map<number, null | Uint32Array>([[first ?? 0, null], [second ?? 0, Uint32Array.from([2, 4])]]);
    expect([...evaluateQuery(query, postings) ?? []]).toEqual([2, 4]);
    expect([...evaluateQuery(query, new Map()) ?? [-1]]).toEqual([]);
  });

  it('returns every file for an all query', () => {
    expect(evaluateQuery(literalQuery('ab'), new Map())).toBeNull();
  });
});

function collect(query: ReturnType<typeof literalQuery>): Set<number> {
  const trigrams = new Set<number>();
  if (query.kind === 'and') {
    for (const child of query.children) {
      if (child.kind === 'trigram') {
        trigrams.add(child.trigram);
      }
    }
  }
  return trigrams;
}
