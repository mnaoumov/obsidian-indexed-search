/**
 * @file
 *
 * Evaluates a candidate expression over the notes the trigram index vouches for.
 */

import { noop } from '@mnaoumov/typescript-lib/function';

import type { TrigramQuery } from '../trigram-index/trigram-query.ts';
import type { CandidateExpression } from './candidate-expression.ts';

import { createTextChecker } from '../trigram-index/trigram-query.ts';

/**
 * What the evaluator reads about the files.
 *
 * @typeParam File - The file type.
 */
export interface CandidateSource<File> {
  /**
   * Returns the paths of the indexed notes whose content may satisfy a query.
   *
   * @param query - The trigram query.
   * @returns The paths, or `null` when every note may.
   */
  readonly getContentCandidates: (query: TrigramQuery) => Promise<null | ReadonlySet<string>>;

  /**
   * Returns a file's path.
   *
   * @param file - The file.
   * @returns Its vault-relative path.
   */
  readonly getPath: (file: File) => string;

  /**
   * Returns a note's cached tags, each with its leading `#`.
   *
   * @param file - The note.
   * @returns The tags, or `null` when the note has no cache yet.
   */
  readonly getTags: (file: File) => null | readonly string[];
}

/**
 * Returns the files of a universe that may match an expression.
 *
 * @typeParam File - The file type.
 * @param expression - The expression.
 * @param files - The universe: the notes whose indexed content is current.
 * @param source - Reads the files' content candidates, paths and tags.
 * @returns The candidates, or `null` when every file is one.
 */
export async function evaluateCandidates<File>(
  expression: CandidateExpression,
  files: readonly File[],
  source: CandidateSource<File>
): Promise<null | Set<File>> {
  switch (expression.kind) {
    case 'all': {
      return null;
    }
    case 'and': {
      let result: null | Set<File> = null;
      for (const child of expression.children) {
        // Each child narrows what the previous ones left, so a later term filters fewer paths.
        const childResult: null | Set<File> = await evaluateCandidates(child, result ? [...result] : files, source);
        if (childResult) {
          result = childResult;
        }
      }
      return result;
    }
    case 'or': {
      const result = new Set<File>();
      for (const child of expression.children) {
        const childResult: null | Set<File> = await evaluateCandidates(child, files, source);
        if (!childResult) {
          return null;
        }
        for (const file of childResult) {
          result.add(file);
        }
      }
      return result;
    }
    case 'tag': {
      return new Set(files.filter((file) => {
        const tags = source.getTags(file);
        return tags === null || tags.some((tag) => expression.regex.test(tag));
      }));
    }
    case 'term': {
      const contentPaths = expression.scope === 'path' ? new Set<string>() : await source.getContentCandidates(expression.query);
      if (!contentPaths) {
        return null;
      }
      const canPathSatisfy = expression.scope === 'content' ? null : createTextChecker(expression.query);
      return new Set(files.filter((file) => {
        const path = source.getPath(file);
        return contentPaths.has(path) || (canPathSatisfy?.(path) ?? false);
      }));
    }
    default: {
      throw new Error(`Unexpected candidate expression: ${JSON.stringify(expression)}`);
    }
  }
}

/**
 * Starts reading the content candidates of every term of an expression at once.
 *
 * {@link evaluateCandidates} awaits its terms one after another, and each read is an IndexedDB round trip of
 * 40 ms or more, whatever its size (2026-11-01, the 37,000-note corpus). Started together, the reads overlap.
 *
 * @typeParam File - The file type.
 * @param expression - The expression.
 * @param source - The source to read from.
 * @returns A source whose content reads for the expression's terms are already under way.
 */
export function prefetchContentCandidates<File>(expression: CandidateExpression, source: CandidateSource<File>): CandidateSource<File> {
  const pending = new Map<TrigramQuery, Promise<null | ReadonlySet<string>>>();
  function visit(node: CandidateExpression): void {
    switch (node.kind) {
      case 'all':
      case 'tag': {
        break;
      }
      case 'and':
      case 'or': {
        for (const child of node.children) {
          visit(child);
        }
        break;
      }
      case 'term': {
        if (node.scope !== 'path' && !pending.has(node.query)) {
          const promise = source.getContentCandidates(node.query);
          // An OR that meets an unanswerable child stops before awaiting the rest; that must not be an unhandled rejection.
          promise.catch(noop);
          pending.set(node.query, promise);
        }
        break;
      }
      default: {
        throw new Error(`Unexpected candidate expression: ${JSON.stringify(node)}`);
      }
    }
  }
  visit(expression);
  return {
    ...source,
    getContentCandidates: async (query) => pending.get(query) ?? source.getContentCandidates(query)
  };
}
