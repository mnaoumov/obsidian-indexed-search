import {
  describe,
  expect,
  it
} from 'vitest';

import { PostingCache } from './posting-cache.ts';

function ids(...values: number[]): Uint32Array {
  return Uint32Array.from(values);
}

describe('PostingCache', () => {
  it('returns what it holds and null for anything else', () => {
    const cache = new PostingCache({ maxIds: 10 });
    const list = ids(1, 2, 3);
    cache.set(7, list);
    expect(cache.get(7)).toBe(list);
    expect(cache.get(8)).toBeNull();
  });

  it('evicts the least recently used lists once over its bound', () => {
    const cache = new PostingCache({ maxIds: 5 });
    cache.set(1, ids(1, 2));
    cache.set(2, ids(3, 4));
    // Reading 1 makes 2 the least recently used.
    cache.get(1);
    cache.set(3, ids(5, 6));
    expect(cache.get(2)).toBeNull();
    expect(cache.get(1)).not.toBeNull();
    expect(cache.get(3)).not.toBeNull();
  });

  it('replaces a trigram\'s list, counting only the new one', () => {
    const cache = new PostingCache({ maxIds: 4 });
    cache.set(1, ids(1, 2, 3));
    cache.set(1, ids(4));
    cache.set(2, ids(5, 6, 7));
    expect(cache.get(1)).toEqual(ids(4));
    expect(cache.get(2)).toEqual(ids(5, 6, 7));
  });

  it('does not keep a list larger than its whole bound', () => {
    const cache = new PostingCache({ maxIds: 2 });
    cache.set(1, ids(1));
    cache.set(2, ids(1, 2, 3));
    expect(cache.get(2)).toBeNull();
    expect(cache.get(1)).toEqual(ids(1));
  });

  it('drops everything on clear', () => {
    const cache = new PostingCache({ maxIds: 10 });
    cache.set(1, ids(1));
    cache.clear();
    expect(cache.get(1)).toBeNull();
    cache.set(2, ids(1, 2, 3, 4, 5, 6, 7, 8, 9, 10));
    expect(cache.get(2)).not.toBeNull();
  });
});
