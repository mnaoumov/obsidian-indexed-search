import { noopAsync } from '@mnaoumov/typescript-lib/function';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { TrigramQuery } from '../trigram-index/trigram-query.ts';
import type { CandidateSource } from './candidate-evaluator.ts';
import type { CandidateExpression } from './candidate-expression.ts';

import {
  formatQuery,
  literalQuery
} from '../trigram-index/trigram-query.ts';
import { evaluateCandidates } from './candidate-evaluator.ts';

interface FakeNote {
  readonly content: string;
  readonly path: string;
  readonly tags: null | readonly string[];
}

const NOTES: readonly FakeNote[] = [
  { content: 'a quillwort patch', path: 'plants/one.md', tags: ['#plant'] },
  { content: 'the silver lantern', path: 'lights/two.md', tags: ['#plant/fern', '#light'] },
  { content: 'nothing here', path: 'quillwort/three.md', tags: [] },
  { content: 'quillwort by the lantern', path: 'four.md', tags: null }
];

function createSource(lookups: string[] = []): CandidateSource<FakeNote> {
  return {
    async getContentCandidates(query: TrigramQuery): Promise<null | ReadonlySet<string>> {
      lookups.push(formatQuery(query));
      await noopAsync();
      return query.kind === 'all' ? null : new Set(NOTES.filter((note) => isContentMatch(note, query)).map((note) => note.path));
    },
    getPath: (note) => note.path,
    getTags: (note) => note.tags
  };
}

async function evaluate(expression: CandidateExpression, source = createSource()): Promise<null | string[]> {
  const result = await evaluateCandidates(expression, NOTES, source);
  return result ? Array.from(result, (note) => note.path).sort() : null;
}

function isContentMatch(note: FakeNote, query: TrigramQuery): boolean {
  return ['quillwort', 'lantern', 'silver'].some((word) => note.content.includes(word) && formatQuery(literalQuery(word)) === formatQuery(query));
}

function term(word: string, scope: 'content' | 'contentOrPath' | 'path' = 'contentOrPath'): CandidateExpression {
  return { kind: 'term', query: literalQuery(word), scope };
}

describe('evaluateCandidates', () => {
  it('returns null for every file', async () => {
    expect(await evaluate({ kind: 'all' })).toBeNull();
  });

  it('matches a term in the content or the path', async () => {
    expect(await evaluate(term('quillwort'))).toEqual(['four.md', 'plants/one.md', 'quillwort/three.md']);
  });

  it('matches a content term only in the content, and a path term only in the path', async () => {
    expect(await evaluate(term('quillwort', 'content'))).toEqual(['four.md', 'plants/one.md']);
    const lookups: string[] = [];
    expect(await evaluate(term('quillwort', 'path'), createSource(lookups))).toEqual(['quillwort/three.md']);
    expect(lookups).toEqual([]);
  });

  it('returns null when the index cannot answer a term', async () => {
    const expression: CandidateExpression = { kind: 'term', query: { kind: 'all' }, scope: 'content' };
    expect(await evaluate(expression)).toBeNull();
  });

  it('intersects AND, ignoring children that narrow nothing', async () => {
    const unanswerable: CandidateExpression = { kind: 'term', query: { kind: 'all' }, scope: 'content' };
    expect(await evaluate({ children: [term('quillwort', 'content'), unanswerable, term('lantern', 'content')], kind: 'and' })).toEqual(['four.md']);
    expect(await evaluate({ children: [unanswerable], kind: 'and' })).toBeNull();
  });

  it('unites OR, and returns null once a child does', async () => {
    expect(await evaluate({ children: [term('silver', 'content'), term('quillwort', 'path')], kind: 'or' })).toEqual([
      'lights/two.md',
      'quillwort/three.md'
    ]);
    const unanswerable: CandidateExpression = { kind: 'term', query: { kind: 'all' }, scope: 'content' };
    expect(await evaluate({ children: [term('silver'), unanswerable], kind: 'or' })).toBeNull();
  });

  it('matches cached tags with the tag regex, and keeps notes with no cache', async () => {
    expect(await evaluate({ kind: 'tag', regex: /^#plant(?:$|\/)/i })).toEqual(['four.md', 'lights/two.md', 'plants/one.md']);
    expect(await evaluate({ kind: 'tag', regex: /^#light(?:$|\/)/i })).toEqual(['four.md', 'lights/two.md']);
  });

  it('rejects an unknown expression', async () => {
    await expect(evaluate(castTo<CandidateExpression>({ kind: 'unknown' }))).rejects.toThrow('Unexpected candidate expression');
  });
});
