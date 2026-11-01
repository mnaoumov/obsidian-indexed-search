/**
 * @file
 *
 * Narrows core Search's scan to the files its query can match.
 *
 * Core's `startSearch` compiles the query, then its queue component lists and sorts every file into a new result
 * queue, which core starts consuming. The patch starts the index reads as soon as the query is compiled, and hands
 * the queue component an empty list, so core sorts nothing and its consumer waits on an empty queue without
 * starting its loader. Once the index has answered, the files go back, minus the notes the index rules out, sorted
 * with the comparator core asked the empty list for. Core's own matcher still checks every file left, and every file
 * a vault or cache event queues meanwhile, so the results are core's own.
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
import type { CandidateSource } from './candidate-evaluator.ts';
import type { CandidateExpression } from './candidate-expression.ts';

import {
  evaluateCandidates,
  prefetchContentCandidates
} from './candidate-evaluator.ts';
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
 * Orders two files the way core's queue component sorts its first batch.
 */
type FileComparator = (left: TFile, right: TFile) => number;

/**
 * The empty file list core's queue component is handed in place of every file, recording the sort it asks for.
 */
interface FileSeed {
  // eslint-disable-next-line typescript-dev-toolkit/readonly-interface-members -- the seed's `sort` records it.
  compare: FileComparator | null;
  readonly files: TFile[];
}

/**
 * A search's first batch, kept out of its queue until the index answers.
 */
interface HeldBatch {
  /**
   * Core's own sort for the batch, recorded from the seed it sorted; `null` when {@link files} is already in core's
   * order, or core does not sort.
   */
  readonly compare: FileComparator | null;
  readonly files: readonly TFile[];
  readonly prepared: PreparedSearch;
  readonly queue: ItemQueue<TFile>;
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
 * A search whose index reads started before core listed its files.
 */
interface PreparedSearch {
  readonly expression: CandidateExpression;
  readonly searchQuery: ObsidianSearchQuery;
  readonly source: CandidateSource<TFile>;
  readonly startTime: number;
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
   * Translates a compiled query and starts its index reads, when the index can narrow it.
   *
   * Core's `startSearch` compiles the query before it starts its queue, so reads started here are under way while the
   * queue is set up and core's own work in `startSearch` finishes.
   *
   * @param searchQuery - The query the search compiled.
   * @returns The prepared search, or `null` when the index cannot narrow the query.
   */
  public prepare(searchQuery: ObsidianSearchQuery): null | PreparedSearch {
    if (!searchQuery.matcher) {
      return null;
    }
    const startTime = performance.now();
    this.guards ??= getSearchMatcherGuards(this.app);
    const expression = translateMatcher(searchQuery.matcher, this.guards);
    if (expression.kind === 'all') {
      this.log(`Query "${searchQuery.query}" needs no trigram the index can check; core scans every file`);
      return null;
    }
    const source = prefetchContentCandidates<TFile>(expression, {
      getContentCandidates: async (query) => this.trigramIndexComponent.getContentCandidates(query),
      getPath: (file) => file.path,
      getTags: (file) => {
        const cache = this.app.metadataCache.getFileCache(file);
        return cache ? getAllTags(cache) ?? [] : null;
      }
    });
    return { expression, searchQuery, source, startTime };
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
    let excluded: null | Set<TFile> = null;
    try {
      excluded = await withTimeout(this.findExcluded(batch.prepared, batch.universe), HOLD_TIMEOUT_IN_MILLISECONDS);
    } finally {
      this.giveBack(view, batch, excluded, performance.now() - batch.prepared.startTime);
    }
  }

  /**
   * Returns the files a compiled query may match: every given file but the notes the index rules out. A note whose
   * stats change while the index answers stays in, since the index answered for its earlier content.
   *
   * @param searchQuery - The compiled query.
   * @param files - The files to choose from.
   * @returns The candidates, in the order given.
   */
  public async selectCandidateFiles(searchQuery: ObsidianSearchQuery, files: readonly TFile[]): Promise<TFile[]> {
    const prepared = this.prepare(searchQuery);
    const universe = prepared ? files.filter((file) => this.trigramIndexComponent.isVouched(file)) : [];
    const excluded = prepared && universe.length > 0 ? await this.findExcluded(prepared, universe) : null;
    return excluded ? files.filter((file) => !excluded.has(file) || !this.trigramIndexComponent.isVouched(file)) : [...files];
  }

  /**
   * Starts a search's queue with its first batch held back, when the index vouches for any of its notes.
   *
   * Listing and sorting every file is the whole of core's synchronous `startSearch`: 56 to 70 ms on 37,000 files,
   * and 0 ms with no file (2026-11-01). So core's queue component is handed an empty list, which records the sort
   * core asks for, and only the files kept are sorted, on release. Should core ever fill the queue some other way,
   * that batch is taken back out of the queue instead, already in core's order.
   *
   * @param prepared - The search, with its index reads under way.
   * @param start - Core's own `start`, which creates the queue.
   * @returns The queue core consumes, and the held batch, or `null` when the queue got every file.
   */
  public startHeld(prepared: PreparedSearch, start: () => ItemQueue<TFile>): [ItemQueue<TFile>, HeldBatch | null] {
    const vault = this.app.vault;
    const files = vault.getFiles();
    const universe = files.filter((file) => this.trigramIndexComponent.isVouched(file));
    if (universe.length === 0) {
      return [start(), null];
    }
    const seed = createFileSeed();
    const queue = withTemporaryProperty(vault, 'getFiles', () => seed.files, start);
    const seeded = queue.items.queue.slice(queue.items.offset);
    if (seeded.length > 0) {
      queue.clear();
      return [queue, { compare: null, files: seeded, prepared, queue, universe }];
    }
    return [queue, { compare: seed.compare, files, prepared, queue, universe }];
  }

  /**
   * Patches the Search view as soon as one exists.
   */
  protected override onLayoutReady(): void {
    this.registerEvent(this.app.workspace.on('layout-change', this.patchSearchView.bind(this)));
    this.patchSearchView();
  }

  private async findExcluded(prepared: PreparedSearch, universe: readonly TFile[]): Promise<null | Set<TFile>> {
    const candidates = await evaluateCandidates(prepared.expression, universe, prepared.source);
    return candidates ? new Set(universe.filter((file) => !candidates.has(file))) : null;
  }

  private giveBack(view: SearchView, batch: HeldBatch, excluded: null | Set<TFile>, elapsedInMilliseconds: number): void {
    if (view.queue.queue !== batch.queue || view.searchQuery !== batch.prepared.searchQuery || batch.queue.runnable.isCancelled()) {
      return;
    }
    // A note edited, renamed or created during the hold is queued again by core's own events, so only a deleted
    // note needs checking here.
    const kept = batch.files.filter((file) => !excluded?.has(file) && this.app.vault.getAbstractFileByPath(file.path) === file);
    if (batch.compare) {
      kept.sort(batch.compare);
    }
    const elapsed = elapsedInMilliseconds.toFixed(0);
    if (excluded) {
      this.log(`Query "${batch.prepared.searchQuery.query}": ${String(kept.length)} of ${String(batch.files.length)} files queued after ${elapsed} ms`);
    } else {
      this.log(`Query "${batch.prepared.searchQuery.query}" got no narrowing from the index in ${elapsed} ms; core scans every file`);
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
        const previousStart = component.start.bind(component);
        // The queue component lists the files synchronously inside `start`, and core starts consuming them right
        // after it returns, so the batch is held back there. The wrapper lives only for this one call.
        withTemporaryProperty(component, 'start', (options): ItemQueue<TFile> => {
          // Core stores the compiled query before it starts the queue, so the index reads can begin first.
          const searchQuery = originalThis.searchQuery;
          const prepared = !this.isUnloaded() && searchQuery ? this.prepare(searchQuery) : null;
          if (!prepared) {
            return previousStart(options);
          }
          const [queue, batch] = this.startHeld(prepared, () => previousStart(options));
          held.batch = batch;
          return queue;
        }, fallback);
        const heldBatch = held.batch;
        if (heldBatch) {
          invokeAsyncSafely(async () => this.release(originalThis, heldBatch));
        }
      }
    });
  }
}

function createFileSeed(): FileSeed {
  const seed: FileSeed = { compare: null, files: [] };
  Object.defineProperty(seed.files, 'sort', {
    value: (compare?: FileComparator): TFile[] => {
      seed.compare = compare ?? null;
      return seed.files;
    }
  });
  return seed;
}

function withTemporaryProperty<Target extends object, Key extends keyof Target, Result>(
  target: Target,
  key: Key,
  value: Target[Key],
  callback: () => Result
): Result {
  const own = Object.getOwnPropertyDescriptor(target, key);
  target[key] = value;
  try {
    return callback();
  } finally {
    if (own) {
      Object.defineProperty(target, key, own);
    } else {
      Reflect.deleteProperty(target, key);
    }
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
