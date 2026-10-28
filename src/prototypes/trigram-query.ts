/**
 * @file
 *
 * Trigram queries: the AND/OR expression of trigrams every match of a search term must contain.
 *
 * A trigram is three folded UTF-16 code units packed into one number, `(a * 2^16 + b) * 2^16 + c`, which stays
 * below 2^48 and so is exact in a double. Every derivation here may lose precision only towards MORE files:
 * `all` is always a correct answer, and a trigram is required only when no match can lack it.
 */

import type {
  AstNode,
  CharacterClass,
  Quantifier,
  RootNode
} from 'regjsparser';

import { parse } from 'regjsparser';

import {
  foldText,
  getFoldTable
} from './case-folding.ts';

/**
 * Matches every file: the term gives the index nothing to narrow by.
 */
export interface AllQuery {
  readonly kind: 'all';
}

/**
 * Matches the files every child matches.
 */
export interface AndQuery {
  readonly children: readonly TrigramQuery[];
  readonly kind: 'and';
}

/**
 * Matches no file.
 */
export interface NoneQuery {
  readonly kind: 'none';
}

/**
 * Matches the files any child matches.
 */
export interface OrQuery {
  readonly children: readonly TrigramQuery[];
  readonly kind: 'or';
}

/**
 * Matches the files containing one trigram.
 */
export interface SingleTrigramQuery {
  readonly kind: 'trigram';
  readonly trigram: number;
}

/* eslint-disable unicorn/prefer-code-point -- Core's regexes have no `u` flag, so trigrams are UTF-16 code units. */

/**
 * A query over the trigram index.
 */
export type TrigramQuery =
  | AllQuery
  | AndQuery
  | NoneQuery
  | OrQuery
  | SingleTrigramQuery;

/**
 * The regex syntax core Search accepts beyond ES5: lookbehind and named groups.
 */
interface RegexFeatures {
  readonly lookbehind: true;
  readonly namedGroups: true;
}

const TRIGRAM_LENGTH = 3;
const CODE_UNIT_RADIX = 0x1_00_00;

const ALL_QUERY: AllQuery = { kind: 'all' };
const NONE_QUERY: NoneQuery = { kind: 'none' };

/**
 * What is known about the strings one regex node matches.
 */
interface RegexInfo {
  /**
   * Whether the node can match the empty string.
   */
  readonly canBeEmpty: boolean;
  /**
   * Every string the node can match, when the set is small; otherwise `null`.
   */
  readonly exact: null | ReadonlySet<string>;
  /**
   * A query every match satisfies, beyond what `exact`, `prefix` and `suffix` say.
   */
  readonly match: TrigramQuery;
  /**
   * Every match starts with one of these.
   */
  readonly prefix: ReadonlySet<string>;
  /**
   * Every match ends with one of these.
   */
  readonly suffix: ReadonlySet<string>;
}

/**
 * Combines queries with AND, flattening nested ANDs and dropping `all`.
 *
 * @param queries - The queries to combine.
 * @returns The combined query.
 */
export function andQuery(queries: readonly TrigramQuery[]): TrigramQuery {
  const children: TrigramQuery[] = [];
  const seenTrigrams = new Set<number>();
  for (const query of queries) {
    const parts = query.kind === 'and' ? query.children : [query];
    for (const part of parts) {
      if (part.kind === 'none') {
        return NONE_QUERY;
      }
      if (part.kind === 'all') {
        continue;
      }
      if (part.kind === 'trigram') {
        if (seenTrigrams.has(part.trigram)) {
          continue;
        }
        seenTrigrams.add(part.trigram);
      }
      children.push(part);
    }
  }
  return wrap('and', children, ALL_QUERY);
}

/**
 * Collects every trigram a query refers to.
 *
 * @param query - The query.
 * @param trigrams - The set to add to.
 * @returns The same set.
 */
export function collectTrigrams(query: TrigramQuery, trigrams = new Set<number>()): Set<number> {
  switch (query.kind) {
    case 'and':
    case 'or': {
      for (const child of query.children) {
        collectTrigrams(child, trigrams);
      }
      break;
    }
    case 'trigram': {
      trigrams.add(query.trigram);
      break;
    }
    default: {
      break;
    }
  }
  return trigrams;
}

/**
 * Formats a query for logs and tests, with each trigram shown as its three code units.
 *
 * @param query - The query.
 * @returns A readable form.
 */
export function formatQuery(query: TrigramQuery): string {
  switch (query.kind) {
    case 'all': {
      return '*';
    }
    case 'and': {
      return `(${query.children.map((child) => formatQuery(child)).join(' AND ')})`;
    }
    case 'none': {
      return '-';
    }
    case 'or': {
      return `(${query.children.map((child) => formatQuery(child)).join(' OR ')})`;
    }
    case 'trigram': {
      return unpackTrigram(query.trigram);
    }
    default: {
      return assertNever(query);
    }
  }
}

/**
 * The trigram query a literal substring needs: every trigram of its folded text.
 *
 * @param text - The literal, unfolded.
 * @returns The query.
 */
export function literalQuery(text: string): TrigramQuery {
  return foldedLiteralQuery(foldText(text));
}

/**
 * Combines queries with OR, flattening nested ORs and dropping `none`.
 *
 * @param queries - The queries to combine.
 * @returns The combined query.
 */
export function orQuery(queries: readonly TrigramQuery[]): TrigramQuery {
  const children: TrigramQuery[] = [];
  for (const query of queries) {
    const parts = query.kind === 'or' ? query.children : [query];
    for (const part of parts) {
      if (part.kind === 'all') {
        return ALL_QUERY;
      }
      if (part.kind === 'none') {
        continue;
      }
      children.push(part);
    }
  }
  return wrap('or', children, NONE_QUERY);
}

/**
 * Packs three folded code units into a trigram key.
 *
 * @param first - The first code unit.
 * @param second - The second code unit.
 * @param third - The third code unit.
 * @returns The trigram key.
 */
export function packTrigram(first: number, second: number, third: number): number {
  return (first * CODE_UNIT_RADIX + second) * CODE_UNIT_RADIX + third;
}

/**
 * The trigram query a regex source needs, derived the way Russ Cox's Code Search does.
 *
 * The source is parsed as core Search compiles it: without `u`, so lookbehind and named groups are the only
 * extensions. A source the parser rejects narrows nothing.
 *
 * @param source - The regex source, without delimiters or flags.
 * @returns The query.
 */
export function regexQuery(source: string): TrigramQuery {
  let root: RootNode<RegexFeatures>;
  try {
    root = parse(source, '', { lookbehind: true, namedGroups: true });
  } catch {
    return ALL_QUERY;
  }
  return new RegexAnalyzer().analyze(root);
}

/**
 * Unpacks a trigram key into its three code units.
 *
 * @param trigram - The trigram key.
 * @returns A three-character string.
 */
export function unpackTrigram(trigram: number): string {
  const third = trigram % CODE_UNIT_RADIX;
  const rest = (trigram - third) / CODE_UNIT_RADIX;
  const second = rest % CODE_UNIT_RADIX;
  const first = (rest - second) / CODE_UNIT_RADIX;
  return String.fromCharCode(first, second, third);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

function foldedLiteralQuery(folded: string): TrigramQuery {
  if (folded.length < TRIGRAM_LENGTH) {
    return ALL_QUERY;
  }
  const trigrams: TrigramQuery[] = [];
  for (let index = 0; index + TRIGRAM_LENGTH <= folded.length; index++) {
    trigrams.push({
      kind: 'trigram',
      trigram: packTrigram(folded.charCodeAt(index), folded.charCodeAt(index + 1), folded.charCodeAt(index + TRIGRAM_LENGTH - 1))
    });
  }
  return andQuery(trigrams);
}

function wrap(kind: 'and' | 'or', children: TrigramQuery[], empty: TrigramQuery): TrigramQuery {
  if (children.length === 0) {
    return empty;
  }
  return children.length === 1 ? children[0] ?? empty : { children, kind };
}

const MAX_EXACT_SET_SIZE = 16;
const MAX_AFFIX_SET_SIZE = 16;
const MAX_BOUNDARY_PRODUCT = 64;
const MAX_CLASS_CODE_UNITS = 16;
const AFFIX_LENGTH = TRIGRAM_LENGTH - 1;

const EMPTY_STRING_SET: ReadonlySet<string> = new Set(['']);

const ANY_CHAR_INFO: RegexInfo = {
  canBeEmpty: false,
  exact: null,
  match: ALL_QUERY,
  prefix: EMPTY_STRING_SET,
  suffix: EMPTY_STRING_SET
};

const ANY_STRING_INFO: RegexInfo = {
  canBeEmpty: true,
  exact: null,
  match: ALL_QUERY,
  prefix: EMPTY_STRING_SET,
  suffix: EMPTY_STRING_SET
};

const EMPTY_INFO: RegexInfo = {
  canBeEmpty: true,
  exact: EMPTY_STRING_SET,
  match: ALL_QUERY,
  prefix: EMPTY_STRING_SET,
  suffix: EMPTY_STRING_SET
};

class RegexAnalyzer {
  private readonly foldTable = getFoldTable();

  public analyze(root: AstNode<RegexFeatures>): TrigramQuery {
    const info = this.info(root);
    return andQuery(info.exact ? [info.match, setQuery(info.exact)] : [info.match, setQuery(info.prefix), setQuery(info.suffix)]);
  }

  private alternate(left: RegexInfo, right: RegexInfo): RegexInfo {
    if (left.exact && right.exact) {
      return normalize({
        canBeEmpty: left.canBeEmpty || right.canBeEmpty,
        exact: union(left.exact, right.exact),
        match: orQuery([left.match, right.match]),
        prefix: EMPTY_STRING_SET,
        suffix: EMPTY_STRING_SET
      });
    }
    const leftLoose = withoutExact(left);
    const rightLoose = withoutExact(right);
    return normalize({
      canBeEmpty: left.canBeEmpty || right.canBeEmpty,
      exact: null,
      match: orQuery([leftLoose.match, rightLoose.match]),
      prefix: union(leftLoose.prefix, rightLoose.prefix),
      suffix: union(leftLoose.suffix, rightLoose.suffix)
    });
  }

  private alternateAll(nodes: readonly AstNode<RegexFeatures>[]): RegexInfo {
    let info: null | RegexInfo = null;
    for (const node of nodes) {
      const nodeInfo = this.info(node);
      info = info ? this.alternate(info, nodeInfo) : nodeInfo;
    }
    return info ?? EMPTY_INFO;
  }

  private characterClass(node: CharacterClass): RegexInfo {
    if (node.negative) {
      return ANY_CHAR_INFO;
    }
    const codeUnits = new Set<number>();
    for (const item of node.body) {
      if (item.type === 'value') {
        codeUnits.add(this.fold(item.codePoint));
      } else if (item.type === 'characterClassRange') {
        if (item.max.codePoint - item.min.codePoint >= MAX_CLASS_CODE_UNITS) {
          return ANY_CHAR_INFO;
        }
        for (let codePoint = item.min.codePoint; codePoint <= item.max.codePoint; codePoint++) {
          codeUnits.add(this.fold(codePoint));
        }
      } else {
        return ANY_CHAR_INFO;
      }
      if (codeUnits.size > MAX_CLASS_CODE_UNITS) {
        return ANY_CHAR_INFO;
      }
    }
    return codeUnits.size === 0 ? { ...ANY_CHAR_INFO, match: NONE_QUERY } : exactInfo(new Set(Array.from(codeUnits, (codeUnit) => String.fromCharCode(codeUnit))));
  }

  private concat(left: RegexInfo, right: RegexInfo): RegexInfo {
    const match = andQuery([left.match, right.match]);
    const canBeEmpty = left.canBeEmpty && right.canBeEmpty;
    if (left.exact && right.exact && left.exact.size * right.exact.size <= MAX_EXACT_SET_SIZE) {
      return normalize({
        canBeEmpty,
        exact: cross(left.exact, right.exact),
        match,
        prefix: EMPTY_STRING_SET,
        suffix: EMPTY_STRING_SET
      });
    }
    const leftLoose = withoutExact(left);
    const rightLoose = withoutExact(right);
    const boundary = leftLoose.suffix.size * rightLoose.prefix.size <= MAX_BOUNDARY_PRODUCT
      ? setQuery(cross(leftLoose.suffix, rightLoose.prefix))
      : ALL_QUERY;
    return normalize({
      canBeEmpty,
      exact: null,
      match: andQuery([leftLoose.match, rightLoose.match, boundary]),
      prefix: left.exact
        ? cross(left.exact, rightLoose.prefix)
        : (left.canBeEmpty
          ? union(leftLoose.prefix, rightLoose.prefix)
          : leftLoose.prefix),
      suffix: right.exact
        ? cross(leftLoose.suffix, right.exact)
        : (right.canBeEmpty
          ? union(rightLoose.suffix, leftLoose.suffix)
          : rightLoose.suffix)
    });
  }

  private concatAll(nodes: readonly AstNode<RegexFeatures>[]): RegexInfo {
    let info = EMPTY_INFO;
    for (const node of nodes) {
      info = this.concat(info, this.info(node));
    }
    return info;
  }

  private fold(codePoint: number): number {
    return this.foldTable[codePoint] ?? codePoint;
  }

  private info(node: AstNode<RegexFeatures>): RegexInfo {
    switch (node.type) {
      case 'alternative': {
        return this.concatAll(node.body);
      }
      case 'anchor': {
        return EMPTY_INFO;
      }
      case 'characterClass': {
        return this.characterClass(node);
      }
      case 'characterClassEscape':
      case 'characterClassRange':
      case 'dot': {
        return ANY_CHAR_INFO;
      }
      case 'disjunction': {
        return this.alternateAll(node.body);
      }
      case 'group': {
        return node.behavior === 'normal' || node.behavior === 'ignore' ? this.concatAll(node.body) : EMPTY_INFO;
      }
      case 'quantifier': {
        return this.quantifier(node);
      }
      case 'reference': {
        return ANY_STRING_INFO;
      }
      case 'value': {
        // Core never adds `u`, but an escape can still name a code point above the BMP: fold its code units.
        return exactInfo(new Set([foldText(String.fromCodePoint(node.codePoint))]));
      }
      default: {
        return assertNever(node);
      }
    }
  }

  private quantifier(node: Quantifier<RegexFeatures>): RegexInfo {
    const inner = this.info(node.body[0]);
    if (node.max === 0) {
      return EMPTY_INFO;
    }
    if (node.min === 0) {
      return node.max === 1 ? this.alternate(inner, EMPTY_INFO) : ANY_STRING_INFO;
    }
    if (node.max === 1) {
      return inner;
    }
    const loose = withoutExact(inner);
    return normalize({ ...loose, canBeEmpty: inner.canBeEmpty });
  }
}

function cross(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  const result = new Set<string>();
  for (const leftString of left) {
    for (const rightString of right) {
      result.add(leftString + rightString);
    }
  }
  return result;
}

function exactInfo(strings: ReadonlySet<string>): RegexInfo {
  return {
    canBeEmpty: strings.has(''),
    exact: strings,
    match: ALL_QUERY,
    prefix: EMPTY_STRING_SET,
    suffix: EMPTY_STRING_SET
  };
}

function hasLongString(strings: ReadonlySet<string>): boolean {
  for (const text of strings) {
    if (text.length > AFFIX_LENGTH) {
      return true;
    }
  }
  return false;
}

/**
 * Moves an oversized exact set into `match`, and trims the affixes to the two code units a boundary trigram can
 * use, after adding the trigrams of the longer affixes to `match`.
 *
 * @param info - The info to normalize.
 * @returns The normalized info.
 */
function normalize(info: RegexInfo): RegexInfo {
  if (info.exact && info.exact.size <= MAX_EXACT_SET_SIZE) {
    return info;
  }
  const loose = withoutExact(info);
  let match = loose.match;
  let prefix = loose.prefix;
  let suffix = loose.suffix;
  if (hasLongString(prefix)) {
    match = andQuery([match, setQuery(prefix)]);
    prefix = trimSet(prefix, AFFIX_LENGTH, true);
  }
  if (hasLongString(suffix)) {
    match = andQuery([match, setQuery(suffix)]);
    suffix = trimSet(suffix, AFFIX_LENGTH, false);
  }
  for (let length = AFFIX_LENGTH - 1; prefix.size > MAX_AFFIX_SET_SIZE && length >= 0; length--) {
    prefix = trimSet(prefix, length, true);
  }
  for (let length = AFFIX_LENGTH - 1; suffix.size > MAX_AFFIX_SET_SIZE && length >= 0; length--) {
    suffix = trimSet(suffix, length, false);
  }
  return { canBeEmpty: info.canBeEmpty, exact: null, match, prefix, suffix };
}

/**
 * The query satisfied by a file containing at least one string of the set: OR over the strings of the AND of
 * each string's trigrams. The strings are already folded.
 *
 * @param strings - The strings.
 * @returns The query.
 */
function setQuery(strings: ReadonlySet<string>): TrigramQuery {
  return orQuery(Array.from(strings, foldedLiteralQuery));
}

function trimSet(strings: ReadonlySet<string>, length: number, shouldKeepStart: boolean): Set<string> {
  const result = new Set<string>();
  for (const text of strings) {
    result.add(shouldKeepStart ? text.slice(0, length) : text.slice(Math.max(0, text.length - length)));
  }
  return result;
}

function union(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left, ...right]);
}

function withoutExact(info: RegexInfo): RegexInfo {
  if (!info.exact) {
    return info;
  }
  return {
    canBeEmpty: info.canBeEmpty,
    exact: null,
    match: andQuery([info.match, setQuery(info.exact)]),
    prefix: info.exact,
    suffix: info.exact
  };
}

/* eslint-enable unicorn/prefer-code-point -- End of the file-wide UTF-16 code unit section. */
