import type {
  ItemQueue,
  ObsidianSearchQuery,
  SearchView
} from '@obsidian-typings/obsidian-public-latest/implementations';
import type {
  CachedMetadata,
  TFile,
  Vault
} from 'obsidian';

import { startAsyncErrorIgnoreContext } from '@mnaoumov/typescript-lib/error';
import { noopAsync } from '@mnaoumov/typescript-lib/function';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { strictProxy } from '@mnaoumov/typescript-test-toolkit/strict-proxy';
import { getAllTags } from 'obsidian';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { TrigramIndexComponent } from '../trigram-index/trigram-index-component.ts';
import type { TrigramQuery } from '../trigram-index/trigram-query.ts';
import type { CandidateExpression } from './candidate-expression.ts';

import { literalQuery } from '../trigram-index/trigram-query.ts';
import { translateMatcher } from './candidate-expression.ts';
import { SearchNarrowingComponent } from './search-narrowing-component.ts';

vi.mock('obsidian', async (importOriginal) => {
  const original = await importOriginal<typeof import('obsidian')>();
  return { ...original, getAllTags: vi.fn(original.getAllTags) };
});

vi.mock('./candidate-expression.ts', () => ({
  translateMatcher: vi.fn()
}));

vi.mock('@obsidian-typings/obsidian-public-latest/implementations', async (importOriginal) => ({
  ...await importOriginal<object>(),
  getSearchMatcherGuards: vi.fn(() => ({}))
}));

type FileComparator = (left: TFile, right: TFile) => number;

// Longer than the component's 1 s hold.
const HOLD_WAIT_IN_MILLISECONDS = 3000;

/**
 * Core's result queue, as far as the component reads it.
 */
class FakeItemQueue {
  public readonly added: TFile[][] = [];
  public readonly items = { offset: 0, queue: [] as TFile[] };
  public readonly runnable = {
    cancelled: false,
    isCancelled(): boolean {
      return this.cancelled;
    }
  };

  public addList(files: TFile[]): void {
    // Records only lists that queue something: core's held seed is empty.
    if (files.length > 0) {
      this.added.push([...files]);
    }
    this.items.queue.push(...files);
  }

  public clear(): void {
    this.items.queue = [];
    this.items.offset = 0;
  }
}

/**
 * Core's queue component: lists every file, sorts it with the result pane's comparator and queues it.
 */
class FakeQueueComponent {
  public comparator: FileComparator | null = byPath;
  public queue: FakeItemQueue | null = null;
  /**
   * When set, the queue is filled with these files rather than with a sorted `vault.getFiles()`.
   */
  public seedFiles: null | TFile[] = null;

  public constructor(private readonly vault: Vault) {}

  public start(_options: unknown): FakeItemQueue {
    const queue = new FakeItemQueue();
    if (this.seedFiles) {
      queue.addList(this.seedFiles);
    } else {
      const files = this.vault.getFiles();
      queue.addList(this.comparator ? files.sort(this.comparator) : files.sort());
    }
    this.queue = queue;
    return queue;
  }
}

/**
 * Core's Search view, as far as the patch reaches it.
 */
class FakeSearchView {
  public beforeStart: (() => void) | null = null;
  public nextQuery: null | ObsidianSearchQuery = null;
  public readonly queue: FakeQueueComponent;
  public searchQuery: null | ObsidianSearchQuery = null;

  public constructor(vault: Vault) {
    this.queue = new FakeQueueComponent(vault);
  }

  public startSearch(): void {
    this.searchQuery = this.nextQuery;
    this.beforeStart?.();
    this.queue.start({});
  }
}

function byPath(left: TFile, right: TFile): number {
  return left.path.localeCompare(right.path);
}

function byPathDescending(left: TFile, right: TFile): number {
  return right.path.localeCompare(left.path);
}

function createQuery(query: string): ObsidianSearchQuery {
  return castTo<ObsidianSearchQuery>({ matcher: {}, query });
}

function paths(files: readonly TFile[]): string[] {
  return files.map((file) => file.path);
}

describe('SearchNarrowingComponent', () => {
  let app: App;
  let component: SearchNarrowingComponent;
  let contentCandidates: (query: TrigramQuery) => Promise<null | Set<string>>;
  let expression: CandidateExpression;
  let isEnabled: boolean;
  let shouldIgnoreExcalidrawDrawings: boolean;
  let notVouched: Set<string>;
  let view: FakeSearchView;

  beforeEach(() => {
    app = App.createConfigured__();
    isEnabled = true;
    shouldIgnoreExcalidrawDrawings = false;
    notVouched = new Set();
    expression = { kind: 'term', query: literalQuery('quillwort'), scope: 'content' };
    vi.mocked(translateMatcher).mockImplementation(() => expression);
    contentCandidates = async (): Promise<Set<string>> => {
      await noopAsync();
      return new Set(['a.md', 'c.md']);
    };
    const trigramIndexComponent = strictProxy<TrigramIndexComponent>({
      getContentCandidates: async (query: TrigramQuery) => contentCandidates(query),
      isVouched: (note: TFile) => note.extension === 'md' && !notVouched.has(note.path)
    });
    component = new SearchNarrowingComponent({
      app: app.asOriginalType__(),
      isEnabled: (): boolean => isEnabled,
      shouldIgnoreExcalidrawDrawings: (): boolean => shouldIgnoreExcalidrawDrawings,
      trigramIndexComponent
    });
    view = new FakeSearchView(app.asOriginalType__().vault);
    app.vault.createSync__('a.md', 'a quillwort patch');
    app.vault.createSync__('b.md', 'the silver lantern');
    app.vault.createSync__('c.md', 'quillwort by the lantern');
    app.vault.createSync__('d.txt', 'not a note');
  });

  afterEach(() => {
    component.unload();
    vi.restoreAllMocks();
  });

  function file(path: string): TFile {
    return castTo<TFile>(app.vault.getFileByPath(path));
  }

  async function loadPatched(): Promise<void> {
    const getLeavesOfType = vi.spyOn(app.workspace, 'getLeavesOfType').mockReturnValue(castTo([{ view }]));
    component.load();
    app.workspace.setLayoutReady__();
    // The layout-ready handler runs on the next tick.
    await vi.waitFor(() => {
      expect(getLeavesOfType).toHaveBeenCalled();
    });
  }

  function search(): FakeItemQueue {
    view.nextQuery = createQuery('quillwort');
    view.startSearch();
    return castTo<FakeItemQueue>(view.queue.queue);
  }

  async function waitForRelease(queue: FakeItemQueue, listCount = 1): Promise<void> {
    await vi.waitFor(() => {
      expect(queue.added.length).toBeGreaterThanOrEqual(listCount);
    }, { timeout: HOLD_WAIT_IN_MILLISECONDS });
  }

  describe('prepare', () => {
    it('prepares nothing for an empty query, with narrowing off, or for a query the index cannot narrow', () => {
      expect(component.prepare(castTo<ObsidianSearchQuery>({ matcher: null, query: '' }))).toBeNull();
      isEnabled = false;
      expect(component.prepare(createQuery('quillwort'))).toBeNull();
      isEnabled = true;
      expression = { kind: 'all' };
      expect(component.prepare(createQuery('-quillwort'))).toBeNull();
    });

    it('reads the tags of a note from its cache, and none for a note with no cache', async () => {
      expression = { kind: 'tag', regex: /^#plant(?:$|\/)/i };
      vi.spyOn(app.metadataCache, 'getFileCache').mockImplementation((f) => {
        switch (f.path) {
          case 'a.md': {
            return castTo<CachedMetadata>({ tags: [{ position: {}, tag: '#plant' }] });
          }
          case 'b.md': {
            return castTo<CachedMetadata>({});
          }
          default: {
            return null;
          }
        }
      });

      // Obsidian types the tag list as nullable even for a cache; such a note has no tags.
      vi.mocked(getAllTags).mockImplementation((cache) => cache.tags ? cache.tags.map((tag) => tag.tag) : null);

      const candidates = await component.selectCandidateFiles(createQuery('tag:plant'), [file('a.md'), file('b.md'), file('c.md')]);

      expect(paths(candidates)).toEqual(['a.md', 'c.md']);
    });
  });

  describe('selectCandidateFiles', () => {
    it('drops the vouched notes the index rules out and the other files a content term cannot match, in order', async () => {
      const files = [file('d.txt'), file('c.md'), file('b.md'), file('a.md')];
      expect(paths(await component.selectCandidateFiles(createQuery('quillwort'), files))).toEqual(['c.md', 'a.md']);
    });

    it('keeps a file core reads no content of when its path may match, and always keeps a canvas', async () => {
      expression = { kind: 'term', query: literalQuery('quillwort'), scope: 'contentOrPath' };
      app.vault.createSync__('quillwort.png', '');
      app.vault.createSync__('e.canvas', '{}');
      const files = [file('d.txt'), file('quillwort.png'), file('e.canvas'), file('b.md'), file('a.md')];
      expect(paths(await component.selectCandidateFiles(createQuery('quillwort'), files))).toEqual(['quillwort.png', 'e.canvas', 'a.md']);
    });

    it('keeps a note whose stats changed while the index answered', async () => {
      contentCandidates = async (): Promise<Set<string>> => {
        await noopAsync();
        notVouched.add('b.md');
        return new Set(['a.md']);
      };
      expect(paths(await component.selectCandidateFiles(createQuery('quillwort'), [file('a.md'), file('b.md'), file('c.md')]))).toEqual([
        'a.md',
        'b.md'
      ]);
    });

    it('returns every file when it cannot narrow, when no file is narrowable, or when the index has no answer', async () => {
      const files = [file('a.md'), file('b.md'), file('d.txt')];
      isEnabled = false;
      expect(paths(await component.selectCandidateFiles(createQuery('quillwort'), files))).toEqual(['a.md', 'b.md', 'd.txt']);
      isEnabled = true;
      notVouched = new Set(['a.md', 'b.md']);
      expect(paths(await component.selectCandidateFiles(createQuery('quillwort'), [file('a.md'), file('b.md')]))).toEqual(['a.md', 'b.md']);
      notVouched = new Set();
      contentCandidates = async (): Promise<null> => {
        await noopAsync();
        return null;
      };
      expect(paths(await component.selectCandidateFiles(createQuery('quillwort'), files))).toEqual(['a.md', 'b.md', 'd.txt']);
    });
  });

  describe('the patched startSearch', () => {
    it('holds the first batch and gives back only the files the index cannot rule out, in core\'s order', async () => {
      await loadPatched();
      view.queue.comparator = byPathDescending;

      const queue = search();
      expect(queue.items.queue).toEqual([]);
      await waitForRelease(queue);

      expect(queue.added.map((files) => paths(files))).toEqual([['c.md', 'a.md']]);
    });

    it('keeps core\'s own unsorted order when core asks for no comparator', async () => {
      await loadPatched();
      view.queue.comparator = null;

      const queue = search();
      await waitForRelease(queue);

      expect(queue.added.map((files) => paths(files))).toEqual([paths(app.asOriginalType__().vault.getFiles().filter((f) => f.path !== 'b.md' && f.path !== 'd.txt'))]);
    });

    it('takes back a batch core queued some other way, keeping its order', async () => {
      await loadPatched();
      view.queue.seedFiles = [file('c.md'), file('b.md'), file('a.md')];

      const queue = search();
      expect(queue.items.queue).toEqual([]);
      await waitForRelease(queue, 2);

      expect(queue.added.map((files) => paths(files))).toEqual([['c.md', 'b.md', 'a.md'], ['c.md', 'a.md']]);
    });

    it('does not queue a note deleted during the hold', async () => {
      await loadPatched();
      contentCandidates = async (): Promise<Set<string>> => {
        await noopAsync();
        app.vault.deleteVaultAbstractFile__('a.md');
        return new Set(['a.md', 'c.md']);
      };

      const queue = search();
      await waitForRelease(queue);

      expect(queue.added.map((files) => paths(files))).toEqual([['c.md']]);
    });

    it('gives the whole batch back when the index has no answer, or has none within the hold', async () => {
      await loadPatched();
      contentCandidates = async (): Promise<null> => {
        await noopAsync();
        return null;
      };
      const unanswered = search();
      await waitForRelease(unanswered);
      expect(unanswered.added.map((files) => paths(files))).toEqual([['a.md', 'b.md', 'c.md', 'd.txt']]);

      contentCandidates = async (): Promise<Set<string>> =>
        new Promise(() => {
          // Never answers.
        });
      const slow = search();
      await waitForRelease(slow);
      expect(slow.added.map((files) => paths(files))).toEqual([['a.md', 'b.md', 'c.md', 'd.txt']]);
    });

    it('gives the whole batch back when the index read fails', async () => {
      // The failed read still surfaces as an async error once the batch is back.
      using _ignoreExpectedError = startAsyncErrorIgnoreContext();
      await loadPatched();
      contentCandidates = async (): Promise<null> => {
        await noopAsync();
        throw new Error('read failed');
      };

      const queue = search();
      await waitForRelease(queue);

      expect(queue.added.map((files) => paths(files))).toEqual([['a.md', 'b.md', 'c.md', 'd.txt']]);
    });

    it('gives nothing back to a queue the search has moved on from, or that was cancelled', async () => {
      await loadPatched();
      // One read per search, answered by hand once the search has moved on.
      const answers: ((candidatePaths: Set<string>) => void)[] = [];
      contentCandidates = async (): Promise<Set<string>> =>
        new Promise((resolve) => {
          answers.push(resolve);
        });

      const replaced = search();
      view.queue.queue = new FakeItemQueue();
      answers.pop()?.(new Set(['a.md']));

      const changedQuery = search();
      view.searchQuery = createQuery('lantern');
      answers.pop()?.(new Set(['a.md']));

      view.searchQuery = null;
      const cancelled = search();
      cancelled.runnable.cancelled = true;
      answers.pop()?.(new Set(['a.md']));

      // A later search's release comes after theirs.
      view.queue.queue = null;
      contentCandidates = async (): Promise<Set<string>> => {
        await noopAsync();
        return new Set(['a.md']);
      };
      await waitForRelease(search());
      expect([replaced.added, changedQuery.added, cancelled.added]).toEqual([[], [], []]);
    });

    it('lets core queue every file when it cannot narrow, with no compiled query, or when no file is narrowable', async () => {
      await loadPatched();
      isEnabled = false;
      expect(paths(search().items.queue)).toEqual(['a.md', 'b.md', 'c.md', 'd.txt']);

      isEnabled = true;
      view.nextQuery = null;
      view.startSearch();
      expect(paths(castTo<FakeItemQueue>(view.queue.queue).items.queue)).toEqual(['a.md', 'b.md', 'c.md', 'd.txt']);

      // Core reads the content of notes only, so with no note vouched for and no other file, nothing is narrowable.
      notVouched = new Set(['a.md', 'b.md', 'c.md']);
      app.vault.deleteVaultAbstractFile__('d.txt');
      expect(paths(search().items.queue)).toEqual(['a.md', 'b.md', 'c.md']);
    });

    it('lets core queue every file when the plugin unloads during the search', async () => {
      await loadPatched();
      view.beforeStart = (): void => {
        component.unload();
      };

      expect(paths(search().items.queue)).toEqual(['a.md', 'b.md', 'c.md', 'd.txt']);
    });

    it('matches Excalidraw notes with their drawing data blanked, and keeps them out of the narrowing', async () => {
      await loadPatched();
      shouldIgnoreExcalidrawDrawings = true;
      vi.spyOn(app.metadataCache, 'getFileCache').mockImplementation((f) => castTo<CachedMetadata>(f.path === 'a.md' ? { frontmatter: { 'excalidraw-plugin': 'parsed' } } : {}));
      const match = vi.fn((_file: TFile, content: string) => content.includes('cat') ? {} : null);
      view.nextQuery = castTo<ObsidianSearchQuery>({ match, matcher: {}, query: 'cat' });
      contentCandidates = async (): Promise<Set<string>> => {
        await noopAsync();
        return new Set(['c.md']);
      };

      view.startSearch();
      const queue = castTo<FakeItemQueue>(view.queue.queue);
      await waitForRelease(queue);

      // The index cannot rule the drawing out: blanking can add trigrams its indexed text lacks.
      expect(queue.added.map((files) => paths(files))).toEqual([['a.md', 'c.md']]);
      const drawing = '---\nexcalidraw-plugin: parsed\n---\n## Drawing\n```compressed-json\n+cat+\n```\n';
      expect(castTo<ObsidianSearchQuery>(view.searchQuery).match(file('a.md'), drawing)).toBeNull();
      expect(match).toHaveBeenCalledWith(file('a.md'), drawing.replace('+cat+', ' '.repeat(5)));
    });

    it('leaves the compiled query alone while drawing data is not ignored', async () => {
      await loadPatched();
      const match = vi.fn(() => null);
      const searchQuery = castTo<ObsidianSearchQuery>({ match, matcher: {}, query: 'cat' });
      view.nextQuery = searchQuery;

      view.startSearch();

      expect(searchQuery.match).toBe(match);
    });

    it('restores an own start property of the queue component after the call', async () => {
      await loadPatched();
      const ownStart = view.queue.start.bind(view.queue);
      Object.defineProperty(view.queue, 'start', { configurable: true, value: ownStart, writable: true });

      const queue = search();
      await waitForRelease(queue);

      expect(Object.getOwnPropertyDescriptor(view.queue, 'start')?.value).toBe(ownStart);
      expect(queue.added.map((files) => paths(files))).toEqual([['a.md', 'c.md']]);
    });
  });

  describe('patching', () => {
    it('patches the Search view once it appears, and only once', async () => {
      const getLeavesOfType = vi.spyOn(app.workspace, 'getLeavesOfType').mockReturnValue([]);
      component.load();
      app.workspace.setLayoutReady__();
      await vi.waitFor(() => {
        expect(getLeavesOfType).toHaveBeenCalled();
      });
      expect(paths(search().items.queue)).toEqual(['a.md', 'b.md', 'c.md', 'd.txt']);

      getLeavesOfType.mockReturnValue(castTo([{ view }]));
      app.workspace.trigger('layout-change');
      app.workspace.trigger('layout-change');

      expect(search().items.queue).toEqual([]);
      expect(getLeavesOfType).toHaveBeenCalledTimes(2);
    });

    it('removes the patch on unload', async () => {
      await loadPatched();
      component.unload();

      expect(paths(search().items.queue)).toEqual(['a.md', 'b.md', 'c.md', 'd.txt']);
      expect(castTo<SearchView>(view).queue.queue).toBeInstanceOf(FakeItemQueue);
      expect(castTo<ItemQueue<TFile>>(view.queue.queue).items.queue).toHaveLength(4);
    });
  });
});
