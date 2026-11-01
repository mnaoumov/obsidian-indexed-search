/**
 * @file
 *
 * The implementation behind this plugin's public API.
 *
 * `search` runs core Search's own scan, as `SearchView.startSearch` runs it in Obsidian 1.14.5, without the view:
 * every file of the vault that core does not ignore and supports, read only when the compiled query needs the
 * text, and checked by the compiled query's own `match`. So its results are core's by construction; the plugin
 * owns only the loop around core's matcher.
 */

import type {
  ObsidianSearchQuery,
  SearchMatchResult
} from '@obsidian-typings/obsidian-public-latest';
import type {
  App,
  TFile
} from 'obsidian';

import { normalizeOptionalProperties } from '@mnaoumov/typescript-lib/object-utils';

import type {
  IndexedSearchApi,
  IndexedSearchHit,
  IndexedSearchMatch,
  IndexedSearchOptions,
  IndexedSearchPropertyMatch,
  IndexedSearchRange
} from './indexed-search-api.ts';

/**
 * Parameters for the {@link IndexedSearchApiImpl} constructor.
 */
export interface IndexedSearchApiImplConstructorParams {
  /**
   * The application owning the vault.
   */
  readonly app: App;

  /**
   * Compiles a raw query with core Search's own query class.
   */
  readonly createQuery: SearchQueryFactory;
}

/**
 * Compiles a raw query the way core Search does.
 *
 * @param query - The raw query.
 * @param isCaseSensitive - Whether the query matches case-sensitively.
 * @returns The compiled query.
 */
export type SearchQueryFactory = (query: string, isCaseSensitive: boolean) => ObsidianSearchQuery;

const CANVAS_NODE_KEY_PREFIX = 'canvas-';

/**
 * How long the scan runs before it lets the UI breathe, as core's own scan does.
 */
const MAX_BUSY_IN_MILLISECONDS = 100;

/**
 * This plugin's API, as it is actually implemented.
 */
export class IndexedSearchApiImpl implements IndexedSearchApi {
  private readonly app: App;
  private readonly createQuery: SearchQueryFactory;

  /**
   * Creates the API.
   *
   * @param params - The parameters.
   */
  public constructor(params: IndexedSearchApiImplConstructorParams) {
    this.app = params.app;
    this.createQuery = params.createQuery;
  }

  /**
   * Runs a query written in core Search's own syntax and answers the files core Search would list for it.
   *
   * @param query - The query, as typed into core Search.
   * @param options - How to run it.
   * @returns The matching files, ordered by path.
   */
  // eslint-disable-next-line typescript-dev-toolkit/params-options-name-match -- It implements the published interface, whose options type consumers name.
  public async search(query: string, options?: IndexedSearchOptions): Promise<IndexedSearchHit[]> {
    const abortSignal = options?.abortSignal;
    abortSignal?.throwIfAborted();
    const searchQuery = this.createQuery(query, options?.isCaseSensitive ?? false);
    if (!searchQuery.matcher) {
      return [];
    }

    const shouldReadContent = searchQuery.requiredInputs?.content ?? false;
    const hits: IndexedSearchHit[] = [];
    let busySince = performance.now();

    for (const file of this.app.vault.getFiles()) {
      if (performance.now() - busySince > MAX_BUSY_IN_MILLISECONDS) {
        await sleep(0);
        busySince = performance.now();
      }
      abortSignal?.throwIfAborted();
      if (this.app.metadataCache.isUserIgnored(file.path) || !this.app.metadataCache.isSupportedFile(file)) {
        continue;
      }

      const content = shouldReadContent && (file.extension === 'md' || file.extension === 'canvas')
        ? await this.readContent(file)
        : '';
      abortSignal?.throwIfAborted();
      const result = searchQuery.match(file, content);
      if (result) {
        hits.push({ file, match: toMatch(result) });
      }
    }

    return hits.sort((left, right) => left.file.path.localeCompare(right.file.path));
  }

  private async readContent(file: TFile): Promise<string> {
    try {
      return await this.app.vault.cachedRead(file);
    } catch (error) {
      // Core Search logs an unreadable file and matches it as empty text; so does this scan.
      console.error(error);
      return '';
    }
  }
}

function copyRanges(ranges: readonly (readonly [number, number])[]): IndexedSearchRange[] {
  return ranges.map(([start, end]) => [start, end]);
}

/**
 * Copies core's match result into the published shape, so a consumer never holds core's own arrays.
 *
 * @param result - Core's match result.
 * @returns The published match.
 */
function toMatch(result: SearchMatchResult): IndexedSearchMatch {
  let canvasNodes: Record<string, IndexedSearchRange[]> | undefined;
  for (const [key, value] of Object.entries(result)) {
    if (!key.startsWith(CANVAS_NODE_KEY_PREFIX) || !Array.isArray(value)) {
      continue;
    }
    canvasNodes ??= {};
    canvasNodes[key.slice(CANVAS_NODE_KEY_PREFIX.length)] = copyRanges(value as [number, number][]);
  }

  return normalizeOptionalProperties<IndexedSearchMatch>({
    canvasNodes,
    content: result.content && copyRanges(result.content),
    filename: result.filename && copyRanges(result.filename),
    filepath: result.filepath && copyRanges(result.filepath),
    properties: result.properties?.map((property) =>
      normalizeOptionalProperties<IndexedSearchPropertyMatch>({
        key: property.key,
        range: property.pos && [property.pos[0], property.pos[1]]
      })
    )
  });
}
