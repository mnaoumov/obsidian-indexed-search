/**
 * @file
 *
 * Measurement helpers the engine benchmark runs inside Obsidian: core Search timing, memory samples and a
 * forced garbage collection. They run only in the desktop renderer, under the desktop performance suite.
 */

import type {
  SearchQueueStartOptions,
  SearchView
} from '@obsidian-typings/obsidian-public-latest';
import type { App } from 'obsidian';

import type { BruteScanTerm } from './brute-scan-engine.ts';

import { foldText } from '../trigram-index/case-folding.ts';

/**
 * What one core Search run returned.
 */
export interface CoreSearchResult {
  readonly elapsedInMilliseconds: number;
  readonly paths: string[];
  /**
   * When something first added files to the search's queue after `startSearch` returned: the plugin's hook giving
   * its held batch back. `null` when nothing did.
   */
  readonly releaseInMilliseconds: null | number;
  /**
   * How long core's synchronous `startSearch` took: compiling, listing and sorting every file.
   */
  readonly syncInMilliseconds: number;
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

/**
 * When the search's queue was first given files after `startSearch` returned.
 */
interface ReleaseMark {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- the queue's wrapper sets it.
  time: null | number;
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
  // Set by the queue's wrapper below, which runs later than this function's own flow analysis can see.
  const release: ReleaseMark = { time: null };
  const stopped = new Promise<void>((resolve) => {
    component.start = (options?: SearchQueueStartOptions): ReturnType<typeof originalStart> => {
      if (candidatePaths) {
        // The queue component lists the files synchronously inside `start`; swapping the list only there is
        // What the plugin's own hook would do to the queue's first batch.
        vault.getFiles = (): ReturnType<typeof originalGetFiles> => originalGetFiles().filter((file) => candidatePaths.has(file.path));
      }
      try {
        const queue = originalStart({
          ...options,
          onStop(): void {
            options?.onStop?.();
            resolve();
          }
        });
        const originalAddList = queue.addList.bind(queue);
        queue.addList = (items): void => {
          release.time ??= performance.now();
          originalAddList(items);
        };
        return queue;
      } finally {
        vault.getFiles = originalGetFiles;
      }
    };
  });
  const startTime = performance.now();
  let syncEndTime: number;
  try {
    view.searchComponent.setValue(query);
    view.startSearch();
    syncEndTime = performance.now();
    await stopped;
  } finally {
    restoreStart();
  }
  const elapsedInMilliseconds = performance.now() - startTime;
  return {
    elapsedInMilliseconds,
    paths: Array.from(view.dom.resultDomLookup.keys(), (file) => file.path),
    releaseInMilliseconds: release.time === null ? null : release.time - startTime,
    syncInMilliseconds: syncEndTime - startTime
  };
}

async function getSearchView(app: App): Promise<SearchView> {
  let leaf = app.workspace.getLeavesOfType('search')[0];
  if (!leaf) {
    app.internalPlugins.getEnabledPluginById('global-search')?.openGlobalSearch('');
    leaf = app.workspace.getLeavesOfType('search')[0];
  }
  if (!leaf) {
    throw new Error('Core Search view is not available');
  }
  await app.workspace.revealLeaf(leaf);
  return leaf.view as SearchView;
}
