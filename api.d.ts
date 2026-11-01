/**
 * @file
 *
 * `Indexed Search`'s public surface, as a consumer sees it.
 *
 * Hand-written and self-contained on purpose: it imports from the `obsidian` package and nothing else, so a plugin
 * that has never heard of `@mnaoumov/obsidian-lib` can copy this file, or reference it, and depend on
 * `Indexed Search` with no build-time dependency on this repo at all.
 *
 * The API is reached through the `@mnaoumov/obsidian-lib` plugin registry, under the plugin id `indexed-search`.
 */

import type { TFile } from 'obsidian';

/**
 * The API `Indexed Search` publishes.
 */
export interface IndexedSearchApi {
  /**
   * Runs a query written in core Search's own syntax and answers the files core Search would list for it.
   *
   * The query is compiled by core Search's own parser and every file is checked by core Search's own matcher, so
   * the files are core's by construction: `file:`, `path:`, `tag:`, `line:`, `section:`, properties, regular
   * expressions, `match-case:` and every other operator mean exactly what they mean in the Search pane.
   *
   * @param query - The query, as typed into core Search.
   * @param options - How to run it.
   * @returns The matching files, ordered by path. An empty query matches nothing.
   * @throws The error core Search shows for a query it rejects, such as an unknown operator. A cancelled search
   * rejects with the signal's reason.
   */
  readonly search: (query: string, options?: IndexedSearchOptions) => Promise<IndexedSearchHit[]>;
}

/**
 * One file core Search matched, and where.
 */
export interface IndexedSearchHit {
  /**
   * The matching file.
   */
  readonly file: TFile;

  /**
   * Where the query matched in the file.
   */
  readonly match: IndexedSearchMatch;
}

/**
 * Where a query matched in one file, by the part of the file each match was found in.
 *
 * A part with no match is absent. A file can match with every part absent, for example on a negated or a
 * property-only query.
 */
export interface IndexedSearchMatch {
  /**
   * The matches in a canvas file's text cards, by card id. Each range is an offset into the card's text.
   */
  readonly canvasNodes?: Readonly<Record<string, readonly IndexedSearchRange[]>>;

  /**
   * The matches in the file's text, as offsets into it.
   */
  readonly content?: readonly IndexedSearchRange[];

  /**
   * The matches in the file name, extension included.
   */
  readonly filename?: readonly IndexedSearchRange[];

  /**
   * The matches in the vault-relative file path.
   */
  readonly filepath?: readonly IndexedSearchRange[];

  /**
   * The matched properties.
   */
  readonly properties?: readonly IndexedSearchPropertyMatch[];
}

/**
 * How {@link IndexedSearchApi.search} runs a query.
 */
export interface IndexedSearchOptions {
  /**
   * Stops the search. The returned promise then rejects with the signal's reason.
   */
  readonly abortSignal?: AbortSignal;

  /**
   * Whether the query matches case-sensitively, like core Search's **Match case** toggle. `match-case:` and
   * `ignore-case:` in the query override it, as in core Search.
   *
   * @defaultValue `false`
   */
  readonly isCaseSensitive?: boolean;
}

/**
 * One matched property.
 */
export interface IndexedSearchPropertyMatch {
  /**
   * The property name.
   */
  readonly key: string;

  /**
   * Where the match is in the property value, or absent when the query matched the property itself, as `[key]` does.
   */
  readonly range?: IndexedSearchRange;
}

/**
 * A matched range: the offset of its first character and the offset just past its last.
 */
export type IndexedSearchRange = readonly [start: number, end: number];
