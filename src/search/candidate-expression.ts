/**
 * @file
 *
 * Translates core Search's compiled matcher tree into a candidate expression: what a file must contain, in its
 * text, its path or its tags, for core's own matcher to possibly match it.
 *
 * Every node is identified by the exact-prototype guards `obsidian-typings` publishes, never by its shape or its
 * `getInfo()` text. A node the translation does not know, and every node it knows but cannot narrow by, becomes
 * `all`, so the expression only ever describes a SUPERSET of core's matches. The rules follow core's own `match`:
 *
 * - AND is `null` as soon as one child is, so its candidates are the intersection of its children's.
 * - OR is `null` only when every child is `null` or `undefined`, so its candidates are the union.
 * - Negation turns `null` into a match, so it narrows nothing.
 * - Text, quoted text and regex search the file name and the content of a Markdown note; `file:` and `path:`
 *   restrict them to the name or the path, `content:` to the content.
 * - `tag:` tests core's own `^<tag>($|/)` regex, with `i`, against the note's cached tags. The tag is escaped from the text
 *   node's `text`, as core 1.15.1 does: its text node no longer carries a `regex`, which 1.14.5 built the same way.
 */

import type {
  SearchMatcher,
  SearchMatcherGuards
} from '@obsidian-typings/obsidian-public-latest/implementations';

import { escapeRegExp } from '@mnaoumov/typescript-lib/reg-exp';

import type { TrigramQuery } from '../trigram-index/trigram-query.ts';

import {
  literalQuery,
  regexQuery
} from '../trigram-index/trigram-query.ts';

/**
 * Matches every file.
 */
export interface AllCandidateExpression {
  readonly kind: 'all';
}

/**
 * Matches the files every child matches.
 */
export interface AndCandidateExpression {
  readonly children: readonly CandidateExpression[];
  readonly kind: 'and';
}

/**
 * A candidate expression over the files of a vault.
 */
export type CandidateExpression =
  | AllCandidateExpression
  | AndCandidateExpression
  | OrCandidateExpression
  | TagCandidateExpression
  | TermCandidateExpression;

/**
 * Matches the files any child matches.
 */
export interface OrCandidateExpression {
  readonly children: readonly CandidateExpression[];
  readonly kind: 'or';
}

/**
 * Matches the notes one of whose cached tags the regex accepts.
 */
export interface TagCandidateExpression {
  readonly kind: 'tag';
  readonly regex: RegExp;
}

/**
 * Matches the files whose text in the given scope holds the trigrams the query requires.
 */
export interface TermCandidateExpression {
  readonly kind: 'term';
  readonly query: TrigramQuery;
  readonly scope: TermScope;
}

/**
 * Where a term is searched: the note's content and its path, only its content, or only its path.
 *
 * A path holds the file name, so a path scope is a superset of a name scope.
 */
export type TermScope = 'content' | 'contentOrPath' | 'path';

const ALL_EXPRESSION: AllCandidateExpression = { kind: 'all' };

/**
 * Translates a compiled matcher tree.
 *
 * @param matcher - The root matcher of a compiled search query.
 * @param guards - The current app's matcher guards.
 * @returns The candidate expression; `all` when the query narrows nothing.
 */
export function translateMatcher(matcher: SearchMatcher, guards: SearchMatcherGuards): CandidateExpression {
  return translate(matcher, guards, 'contentOrPath');
}

function combine(kind: 'and' | 'or', children: readonly CandidateExpression[]): CandidateExpression {
  const flat: CandidateExpression[] = [];
  for (const child of children) {
    if (child.kind === 'all') {
      if (kind === 'or') {
        return ALL_EXPRESSION;
      }
      continue;
    }
    flat.push(...(child.kind === kind ? child.children : [child]));
  }
  if (flat.length === 0) {
    return ALL_EXPRESSION;
  }
  return flat.length === 1 ? flat[0] ?? ALL_EXPRESSION : { children: flat, kind };
}

function term(query: TrigramQuery, scope: TermScope): CandidateExpression {
  return query.kind === 'all' ? ALL_EXPRESSION : { kind: 'term', query, scope };
}

function translate(node: SearchMatcher, guards: SearchMatcherGuards, nodeScope: TermScope): CandidateExpression {
  let matcher = node;
  let scope = nodeScope;
  for (;;) {
    if (guards.case(matcher)) {
      // The trigram fold equates every pair of code units either case setting does.
      matcher = matcher.matcher;
    } else if (scope === 'contentOrPath' && guards.content(matcher)) {
      matcher = matcher.matcher;
      scope = 'content';
    } else if (scope === 'contentOrPath' && (guards.file(matcher) || guards.path(matcher))) {
      matcher = matcher.matcher;
      scope = 'path';
    } else {
      break;
    }
  }

  if (guards.and(matcher)) {
    return combine('and', matcher.matchers.map((child) => translate(child, guards, scope)));
  }
  if (guards.or(matcher)) {
    return combine('or', matcher.matchers.map((child) => translate(child, guards, scope)));
  }
  if (guards.text(matcher)) {
    return term(literalQuery(matcher.text), scope);
  }
  if (guards.quotedText(matcher)) {
    // Content uses core's word-boundary regex around the literal, names a plain substring: both contain the text.
    return term(literalQuery(matcher.text), scope);
  }
  if (guards.regex(matcher)) {
    return term(regexQuery(matcher.regex), scope);
  }
  // Core rejects a scope operator nested in another, so `tag:` is translated only outside one.
  return scope === 'contentOrPath' && guards.tag(matcher)
    ? { kind: 'tag', regex: new RegExp(String.raw`^${escapeRegExp(matcher.matcher.text)}($|\/)`, 'i') }
    : ALL_EXPRESSION;
}
