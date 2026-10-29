/**
 * @file
 *
 * Narrows core Search's scan to the files its query can match.
 *
 * Core's `startSearch` compiles the query, then its queue component lists every file into a new result queue,
 * which core starts consuming. The patch catches that queue as the component returns it and takes its first batch
 * out before anything is read, so the consumer waits on an empty queue without starting its loader. Once the index
 * has answered, the batch goes back, minus the notes the index rules out. Core's own matcher still checks every
 * file left, and every file a vault or cache event queues meanwhile, so the results are core's own.
 *
 * Holding the batch matters: the index's reads, run beside core's scan, came back 5 to 30 times slower and only
 * after core had read up to 40% of the vault (2026-10-29, the 37,000-note corpus).
 */

import type {
  ItemQueue,
  ObsidianSearchQuery,
  SearchMatcherGuards,
  SearchView
} from '@obsidian-typings/obsidian-public-latest/implementations';
import type {
  App,
  TFile
} from 'obsidian';

import { LayoutReadyComponent } from '@mnaoumov/obsidian-lib/components/layout-ready-component';
import { MonkeyAroundComponent } from '@mnaoumov/obsidian-lib/components/monkey-around-component';
import { invokeAsyncSafely } from '@mnaoumov/typescript-lib/async';
import { getDebugger } from '@mnaoumov/typescript-lib/debug';
import { getPrototypeOf } from '@mnaoumov/typescript-lib/object-utils';
import {
  getSearchMatcherGuards,
  ViewType
} from '@obsidian-typings/obsidian-public-latest/implementations';
import { getAllTags } from 'obsidian';

import type { TrigramIndexComponent } from '../trigram-index/trigram-index-component.ts';
import type { CandidateExpression } from './candidate-expression.ts';

import { evaluateCandidates } from './candidate-evaluator.ts';
import { translateMatcher } from './candidate-expression.ts';

/**
 * How long a held batch waits for the index before it goes back to core whole.
 */
const HOLD_TIMEOUT_IN_MILLISECONDS = 1000;

/**
 * What the narrowing component needs.
 */
export interface SearchNarrowingComponentConstructorParams {
  /**
   * The application whose Search views are narrowed.
   */
  readonly app: App;
  /**
   * The vault's trigram index.
   */
  readonly trigramIndexComponent: TrigramIndexComponent;
}

/**
 * A search's first batch, taken out of its queue until the index answers.
 */
interface HeldBatch {
  readonly expression: CandidateExpression;
  readonly files: readonly TFile[];
  readonly queue: ItemQueue<TFile>;
  readonly searchQuery: ObsidianSearchQuery;
  readonly universe: readonly TFile[];
}

/**
 * Where the one startSearch call's wrapper leaves the batch it held.
 */
interface HeldBatchSlot {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- the wrapper fills it during the call.
  batch: HeldBatch | null;
}

/**
 * Patches core Search so its matcher reads only the files the index cannot rule out.
 */
export class SearchNarrowingComponent extends LayoutReadyComponent {
  private guards: null | SearchMatcherGuards = null;
  private isPatched = false;
  private readonly log = getDebugger('indexed-search:SearchNarrowing');
  private readonly trigramIndexComponent: TrigramIndexComponent;

  /**
   * Creates the component; the patch goes on once a Search view exists.
   *
   * @param params - The app and the index.
   */
  public constructor(params: SearchNarrowingComponentConstructorParams) {
    super(params.app);
    this.trigramIndexComponent = params.trigramIndexComponent;
  }

  /**
   * Takes the first batch out of a search's fresh queue when the index can narrow its query.
   *
   * @param searchQuery - The query the search compiled.
   * @param queue - The queue the search is about to consume, holding its first batch.
   * @returns The held batch, or `null` when the queue is left alone.
   */
  public hold(searchQuery: ObsidianSearchQuery, queue: ItemQueue<TFile>): HeldBatch | null {
    if (!searchQuery.matcher) {
      return null;
    }
    this.guards ??= getSearchMatcherGuards(this.app);
    const expression = translateMatcher(searchQuery.matcher, this.guards);
    if (expression.kind === 'all') {
      this.log(`Query "${searchQuery.query}" needs no trigram the index can check; core scans every file`);
      return null;
    }
    const files = queue.items.queue.slice(queue.items.offset);
    const universe = files.filter((file) => this.trigramIndexComponent.isVouched(file));
    if (universe.length === 0) {
      return null;
    }
    queue.clear();
    return { expression, files, queue, searchQuery, universe };
  }

  /**
   * Works out which held notes the query cannot match, and gives the rest back to the queue, if it is still the
   * one the search consumes.
   *
   * @param view - The Search view.
   * @param batch - The held batch.
   * @returns A promise that settles once the batch is back.
   */
  public async release(view: SearchView, batch: HeldBatch): Promise<void> {
    const startTime = performance.now();
    let excluded: null | Set<TFile> = null;
    try {
      excluded = await withTimeout(this.findExcluded(batch), HOLD_TIMEOUT_IN_MILLISECONDS);
    } finally {
      this.giveBack(view, batch, excluded, performance.now() - startTime);
    }
  }

  /**
   * Patches the Search view as soon as one exists.
   */
  protected override onLayoutReady(): void {
    this.registerEvent(this.app.workspace.on('layout-change', this.patchSearchView.bind(this)));
    this.patchSearchView();
  }

  private async findExcluded(batch: HeldBatch): Promise<null | Set<TFile>> {
    const candidates = await evaluateCandidates(batch.expression, batch.universe, {
      getContentCandidates: async (query) => this.trigramIndexComponent.getContentCandidates(query),
      getPath: (file) => file.path,
      getTags: (file) => {
        const cache = this.app.metadataCache.getFileCache(file);
        return cache ? getAllTags(cache) ?? [] : null;
      }
    });
    return candidates ? new Set(batch.universe.filter((file) => !candidates.has(file))) : null;
  }

  private giveBack(view: SearchView, batch: HeldBatch, excluded: null | Set<TFile>, elapsedInMilliseconds: number): void {
    if (view.queue.queue !== batch.queue || view.searchQuery !== batch.searchQuery || batch.queue.runnable.isCancelled()) {
      return;
    }
    // A note edited, renamed or created during the hold is queued again by core's own events, so only a deleted
    // note needs checking here.
    const kept = batch.files.filter((file) => !excluded?.has(file) && this.app.vault.getAbstractFileByPath(file.path) === file);
    const elapsed = elapsedInMilliseconds.toFixed(0);
    if (excluded) {
      this.log(`Query "${batch.searchQuery.query}": ${String(kept.length)} of ${String(batch.files.length)} files queued after ${elapsed} ms`);
    } else {
      this.log(`Query "${batch.searchQuery.query}" got no narrowing from the index in ${elapsed} ms; core scans every file`);
    }
    batch.queue.addList(kept);
  }

  private patchSearchView(): void {
    if (this.isPatched) {
      return;
    }
    const view = this.app.workspace.getLeavesOfType(ViewType.Search)[0]?.view as SearchView | undefined;
    if (!view) {
      return;
    }
    this.isPatched = true;
    const monkeyAroundComponent = this.addChild(new MonkeyAroundComponent());
    monkeyAroundComponent.registerMethodPatch({
      $object: getPrototypeOf(view),
      methodName: 'startSearch',
      patchHandler: ({ fallback, originalThis }) => {
        const held: HeldBatchSlot = { batch: null };
        const component = originalThis.queue;
        const ownStart = Object.getOwnPropertyDescriptor(component, 'start');
        const previousStart = component.start.bind(component);
        // The queue component lists the files synchronously inside `start`, and core starts consuming them right
        // after it returns, so the batch is taken out in between. The wrapper lives only for this one call.
        component.start = (options): ItemQueue<TFile> => {
          const queue = previousStart(options);
          const searchQuery = originalThis.searchQuery;
          if (!this.isUnloaded() && searchQuery) {
            held.batch = this.hold(searchQuery, queue);
          }
          return queue;
        };
        try {
          fallback();
        } finally {
          if (ownStart) {
            Object.defineProperty(component, 'start', ownStart);
          } else {
            delete (component as Partial<typeof component>).start;
          }
        }
        const heldBatch = held.batch;
        if (heldBatch) {
          invokeAsyncSafely(async () => this.release(originalThis, heldBatch));
        }
      }
    });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutInMilliseconds: number): Promise<null | T> {
  const timer = { id: 0 };
  const timeout = new Promise<null>((resolve) => {
    timer.id = window.setTimeout(() => {
      resolve(null);
    }, timeoutInMilliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    window.clearTimeout(timer.id);
  }
}
