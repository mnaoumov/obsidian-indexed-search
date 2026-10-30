import {
  describe,
  expect,
  it
} from 'vitest';

import { SegmentPostings } from './segment-postings.ts';
import { literalQuery } from './trigram-query.ts';

function runsByTrigram(postings: SegmentPostings): Map<number, number[]> {
  return new Map([...postings.runs()].map((run) => [run.trigram, [...run.ids]]));
}

function trigramOf(text: string): number {
  const query = literalQuery(text);
  if (query.kind !== 'trigram') {
    throw new Error('Expected a single trigram');
  }
  return query.trigram;
}

describe('SegmentPostings', () => {
  it('groups file ids by folded trigram, each file once per trigram', () => {
    const postings = new SegmentPostings({ segmentBase: 8, segmentSize: 8 });
    postings.addText('abc abc', 8);
    postings.addText('ABC', 10);
    postings.addText('xy', 11);
    const runs = runsByTrigram(postings);
    expect(runs.get(trigramOf('abc'))).toEqual([8, 10]);
    expect(runs.get(trigramOf('c a'))).toEqual([8]);
    expect(postings.getDocumentFrequencies().get(trigramOf('abc'))).toBe(2);
    expect([...postings.getTrigrams()]).toEqual([...runs.keys()].sort((left, right) => left - right));
  });

  it('starts the next segment empty after a reset', () => {
    const postings = new SegmentPostings({ segmentBase: 0, segmentSize: 8 });
    postings.addText('abc', 0);
    postings.addText('abd', 1);
    expect(runsByTrigram(postings).get(trigramOf('abc'))).toEqual([0]);
    postings.reset(8);
    postings.addText('xbd', 9);
    postings.addText('abd', 8);
    const runs = runsByTrigram(postings);
    expect([...runs.keys()].sort((left, right) => left - right)).toEqual([trigramOf('abd'), trigramOf('xbd')].sort((left, right) => left - right));
    expect(runs.get(trigramOf('abd'))).toEqual([8]);
    expect(runs.get(trigramOf('xbd'))).toEqual([9]);
    expect(postings.getDocumentFrequencies().get(trigramOf('abc'))).toBeUndefined();
    expect(postings.getDocumentFrequencies().get(trigramOf('abd'))).toBe(1);
  });

  it('refuses an id outside its segment', () => {
    const postings = new SegmentPostings({ segmentBase: 8, segmentSize: 8 });
    expect(() => {
      postings.addText('abc', 16);
    }).toThrow(RangeError);
  });

  it('keeps every pair exact once there are too many trigrams for 32-bit packing', () => {
    const postings = new SegmentPostings({ segmentBase: 0, segmentSize: 0x40_00_00_00 });
    postings.addText('abcdefgh', 0);
    postings.addText('fgh', 0x3F_FF_FF_FF);
    const runs = runsByTrigram(postings);
    expect(runs.get(trigramOf('fgh'))).toEqual([0, 0x3F_FF_FF_FF]);
    expect(runs.get(trigramOf('abc'))).toEqual([0]);
  });

  it('grows past its initial capacity', () => {
    const postings = new SegmentPostings({ segmentBase: 0, segmentSize: 8192 });
    const text = Array.from({ length: 5000 }, (_, index) => String.fromCodePoint(0x4E_00 + index)).join('');
    for (let id = 0; id < 20; id++) {
      postings.addText(text, id);
    }
    const runs = [...postings.runs()];
    expect(runs).toHaveLength(4998);
    expect(runs.every((run) => run.ids.length === 20)).toBe(true);
  });
});
