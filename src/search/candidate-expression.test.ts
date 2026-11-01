import type {
  SearchCaseMatcher,
  SearchComparisonMatcher,
  SearchCompositeMatcher,
  SearchMatcher,
  SearchMatcherGuards,
  SearchPropertyMatcher,
  SearchQuotedTextMatcher,
  SearchRegexMatcher,
  SearchTagMatcher,
  SearchTextMatcher,
  SearchUnaryMatcher
} from '@obsidian-typings/obsidian-public-latest/implementations';

import { strictProxy } from '@mnaoumov/typescript-test-toolkit/strict-proxy';
import {
  describe,
  expect,
  it
} from 'vitest';

import type { CandidateExpression } from './candidate-expression.ts';

import { formatQuery } from '../trigram-index/trigram-query.ts';
import { translateMatcher } from './candidate-expression.ts';

type MatcherKind = keyof SearchMatcherGuards;

const kinds = new WeakMap<SearchMatcher, MatcherKind>();

const GUARDS: SearchMatcherGuards = {
  and: (matcher): matcher is SearchCompositeMatcher => kinds.get(matcher) === 'and',
  case: (matcher): matcher is SearchCaseMatcher => kinds.get(matcher) === 'case',
  comparison: (matcher): matcher is SearchComparisonMatcher => kinds.get(matcher) === 'comparison',
  content: (matcher): matcher is SearchUnaryMatcher => kinds.get(matcher) === 'content',
  file: (matcher): matcher is SearchUnaryMatcher => kinds.get(matcher) === 'file',
  negation: (matcher): matcher is SearchUnaryMatcher => kinds.get(matcher) === 'negation',
  or: (matcher): matcher is SearchCompositeMatcher => kinds.get(matcher) === 'or',
  path: (matcher): matcher is SearchUnaryMatcher => kinds.get(matcher) === 'path',
  property: (matcher): matcher is SearchPropertyMatcher => kinds.get(matcher) === 'property',
  quotedText: (matcher): matcher is SearchQuotedTextMatcher => kinds.get(matcher) === 'quotedText',
  regex: (matcher): matcher is SearchRegexMatcher => kinds.get(matcher) === 'regex',
  tag: (matcher): matcher is SearchTagMatcher => kinds.get(matcher) === 'tag',
  text: (matcher): matcher is SearchTextMatcher => kinds.get(matcher) === 'text'
};

const FOO = text('foo');
const BAR = text('bar');
const BAZ = text('baz');
const SHORT = text('ab');
const PLANT_TAG = node('tag', strictProxy<SearchTagMatcher>({ matcher: text('#plant') }));

function and(...matchers: SearchMatcher[]): SearchMatcher {
  return node('and', strictProxy<SearchCompositeMatcher>({ matchers }));
}

function format(expression: CandidateExpression): string {
  switch (expression.kind) {
    case 'all': {
      return '*';
    }
    case 'and':
    case 'or': {
      return `(${expression.children.map((child) => format(child)).join(` ${expression.kind.toUpperCase()} `)})`;
    }
    case 'tag': {
      return `tag${String(expression.regex)}`;
    }
    case 'term': {
      return `${expression.scope}${formatQuery(expression.query)}`;
    }
    default: {
      throw new Error('Unexpected expression');
    }
  }
}

function node<T extends SearchMatcher>(kind: MatcherKind, matcher: T): T {
  kinds.set(matcher, kind);
  return matcher;
}

function or(...matchers: SearchMatcher[]): SearchMatcher {
  return node('or', strictProxy<SearchCompositeMatcher>({ matchers }));
}

function text(value: string): SearchTextMatcher {
  return node('text', strictProxy<SearchTextMatcher>({ regex: value.replaceAll(/[.*+?^${}()|[\]\\/]/gu, String.raw`\$&`), text: value }));
}

function translate(matcher: SearchMatcher): string {
  return format(translateMatcher(matcher, GUARDS));
}

function unary(kind: MatcherKind, matcher: SearchMatcher): SearchMatcher {
  return node(kind, strictProxy<SearchUnaryMatcher>({ matcher }));
}

describe('translateMatcher', () => {
  it('searches a bare term in content and path', () => {
    expect(translate(text('Quill'))).toBe('contentOrPath(QUI AND UIL AND ILL)');
  });

  it('searches the literal of quoted text', () => {
    const quoted = node('quotedText', strictProxy<SearchQuotedTextMatcher>({ text: 'harbour lantern' }));
    expect(translate(quoted)).toContain('contentOrPath(HAR AND');
  });

  it('derives a regex term from its source', () => {
    const regex = node('regex', strictProxy<SearchRegexMatcher>({ regex: 'foo(bar|baz)' }));
    expect(translate(regex)).toBe('contentOrPath((FOO AND OOB AND OBA AND BAR) OR (FOO AND OOB AND OBA AND BAZ))');
  });

  it('narrows nothing for a term shorter than a trigram', () => {
    expect(translate(SHORT)).toBe('*');
  });

  it('intersects AND and drops its unknown children', () => {
    const property = node('property', strictProxy<SearchMatcher>({}));
    expect(translate(and(FOO, property, BAR))).toBe('(contentOrPathFOO AND contentOrPathBAR)');
  });

  it('flattens nested AND and OR', () => {
    const nestedAnd = and(BAR, BAZ);
    const nestedOr = or(BAR, BAZ);
    expect(translate(and(FOO, nestedAnd))).toBe('(contentOrPathFOO AND contentOrPathBAR AND contentOrPathBAZ)');
    expect(translate(or(FOO, nestedOr))).toBe('(contentOrPathFOO OR contentOrPathBAR OR contentOrPathBAZ)');
  });

  it('unites OR, and narrows nothing when one branch narrows nothing', () => {
    expect(translate(or(FOO, BAR))).toBe('(contentOrPathFOO OR contentOrPathBAR)');
    expect(translate(or(FOO, SHORT))).toBe('*');
  });

  it('collapses a composite down to its only narrowing child', () => {
    expect(translate(and(FOO, SHORT))).toBe('contentOrPathFOO');
    expect(translate(and(SHORT, SHORT))).toBe('*');
  });

  it('narrows nothing for a negation', () => {
    const negation = unary('negation', BAR);
    expect(translate(unary('negation', FOO))).toBe('*');
    expect(translate(and(FOO, negation))).toBe('contentOrPathFOO');
  });

  it('passes case overrides through', () => {
    const caseMatcher = node('case', strictProxy<SearchCaseMatcher>({ caseSensitive: true, matcher: FOO }));
    expect(translate(caseMatcher)).toBe('contentOrPathFOO');
  });

  it('scopes content: to the content and file: and path: to the path', () => {
    const either = or(FOO, BAR);
    expect(translate(unary('content', FOO))).toBe('contentFOO');
    expect(translate(unary('file', FOO))).toBe('pathFOO');
    expect(translate(unary('path', either))).toBe('(pathFOO OR pathBAR)');
  });

  it('narrows nothing for a scope or tag inside a scope', () => {
    const content = unary('content', FOO);
    expect(translate(unary('file', content))).toBe('*');
    expect(translate(unary('path', PLANT_TAG))).toBe('*');
  });

  it('builds core\'s own tag regex', () => {
    expect(translate(PLANT_TAG)).toBe(String.raw`tag/^#plant($|\/)/i`);
  });

  it('narrows nothing for an unknown node', () => {
    expect(translate(strictProxy<SearchMatcher>({}))).toBe('*');
  });
});
