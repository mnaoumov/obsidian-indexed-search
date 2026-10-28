/**
 * @file
 *
 * Measurement helpers the engine benchmark runs inside Obsidian: core Search timing, memory samples and a
 * forced garbage collection. They run only in the desktop renderer, under the desktop performance suite.
 */

import type { SearchView } from '@obsidian-typings/obsidian-public-latest';
import type { App } from 'obsidian';

import type { BruteScanTerm } from './brute-scan-engine.ts';

import { foldText } from './case-folding.ts';

/**
 * What one core Search run returned.
 */
export interface CoreSearchResult {
  readonly elapsedInMilliseconds: number;
  readonly paths: string[];
}

/**
 * What {@link runCoreSearch} runs.
 */
export interface RunCoreSearchParams {
  readonly app: App;
  /**
   * When set, core Search is handed only these files, the way the plugin's hook would hand it candidates.
   */
  readonly candidatePaths: null | ReadonlySet<string>;
  readonly query: string;
}

interface SearchComponentInternals {
  readonly setValue: (value: string) => void;
}

interface SearchQueueComponent {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- the benchmark wraps `start` for one run and restores it.
  start: (options?: SearchQueueStartOptions) => unknown;
}

interface SearchQueueStartOptions {
  readonly onStop?: () => void;
}

/**
 * The members of the search view and its queue component the benchmark drives.
 *
 * TODO: obsidian-typings does not declare `SearchView.queue` or `SearchView.searchComponent` yet; they are
 * reported in its `AGENTS.md`. This benchmark-only shape goes once they ship.
 */
interface SearchViewInternals {
  readonly queue: SearchQueueComponent;
  readonly searchComponent: SearchComponentInternals;
}

/**
 * Returns the files whose name may match a term, since core matches a bare term against the file name too.
 *
 * @param paths - Every path, in id order.
 * @param term - The term.
 * @returns The ids of the matching paths.
 */
export function fileNameCandidates(paths: readonly string[], term: BruteScanTerm): number[] {
  const ids: number[] = [];
  const foldedTerm = term.kind === 'literal' ? foldText(term.text) : '';
  const regex = term.kind === 'regex' ? new RegExp(term.source, 'mi') : null;
  for (const [id, path] of paths.entries()) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (regex ? regex.test(name) : foldText(name).includes(foldedTerm)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Runs core Search once and waits for its queue to stop.
 *
 * @param params - The query and, optionally, the candidate files.
 * @returns The elapsed time and the matching paths.
 */
export async function runCoreSearch(params: RunCoreSearchParams): Promise<CoreSearchResult> {
  const { app, candidatePaths, query } = params;
  const view = await getSearchView(app);
  const component = view.queue;
  const originalStart = component.start.bind(component);
  const vault = app.vault;
  const originalGetFiles = vault.getFiles.bind(vault);
  function restoreStart(): void {
    component.start = originalStart;
  }
  const stopped = new Promise<void>((resolve) => {
    component.start = (options?: SearchQueueStartOptions): unknown => {
      if (candidatePaths) {
        // The queue component lists the files synchronously inside `start`; swapping the list only there is
        // What the plugin's own hook would do to the queue's first batch.
        vault.getFiles = (): ReturnType<typeof originalGetFiles> => originalGetFiles().filter((file) => candidatePaths.has(file.path));
      }
      try {
        return originalStart({
          ...options,
          onStop(): void {
            options?.onStop?.();
            resolve();
          }
        });
      } finally {
        vault.getFiles = originalGetFiles;
      }
    };
  });
  const startTime = performance.now();
  try {
    view.searchComponent.setValue(query);
    view.startSearch();
    await stopped;
  } finally {
    restoreStart();
  }
  const elapsedInMilliseconds = performance.now() - startTime;
  return {
    elapsedInMilliseconds,
    paths: Array.from(view.dom.resultDomLookup.keys(), (file) => file.path)
  };
}

async function getSearchView(app: App): Promise<SearchView & SearchViewInternals> {
  let leaf = app.workspace.getLeavesOfType('search')[0];
  if (!leaf) {
    app.internalPlugins.getEnabledPluginById('global-search')?.openGlobalSearch('');
    leaf = app.workspace.getLeavesOfType('search')[0];
  }
  if (!leaf) {
    throw new Error('Core Search view is not available');
  }
  await app.workspace.revealLeaf(leaf);
  return leaf.view as SearchView & SearchViewInternals;
}
