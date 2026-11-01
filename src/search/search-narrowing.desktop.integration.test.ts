/**
 * @file
 *
 * Core Search returns the same results with the plugin on and off, in a real Obsidian, and reads fewer notes
 * with it on.
 *
 * Each query runs twice on one vault: once with the plugin disabled, so core scans every file, and once enabled
 * and caught up, so the index narrows core's queue. The notes plant terms in content, names, paths, tags and a
 * canvas, in both cases and in scripts whose case folding differs, so every branch of the translation is checked
 * against core's own matcher. Every read of a test note is slowed by a millisecond, so a full scan outlasts the
 * index's answer and the narrowing is visible in the read count.
 *
 * Search is driven through the view's own `startSearch`, which is what its input box calls; the result list is
 * read from the view's result lookup once its queue stops.
 */

import type { SearchView } from '@obsidian-typings/obsidian-public-latest';
import type { TFile } from 'obsidian';

import { evalInObsidian } from 'obsidian-integration-testing';
import { getTemporaryVault } from 'obsidian-integration-testing/vitest-global-setup-plugin';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { TrigramIndexComponent } from '../trigram-index/trigram-index-component.ts';

declare global {
  interface Window {
    /**
     * The parity test's state between its calls into Obsidian.
     */
    readonly indexedSearchParityTest?: ParityState;
  }
}

interface IndexPlugin {
  readonly trigramIndexComponent: TrigramIndexComponent;
}

interface ParityQuery {
  readonly isNarrowable: boolean;
  readonly query: string;
}

interface ParityState {
  readonly restore: () => void;
  readonly runSearch: (query: string, duringScan?: () => Promise<void>) => Promise<SearchRun>;
}

interface SearchRun {
  readonly paths: string[];
  readonly reads: number;
}

const FOLDER = 'parity';
const NOTE_COUNT = 600;
const PLUGIN_ID = 'indexed-search';

/**
 * The query corpus. `isNarrowable` marks the queries the index must narrow, so their narrowed run reads fewer notes.
 */
const QUERIES: readonly ParityQuery[] = [
  { isNarrowable: true, query: 'quillwort' },
  { isNarrowable: true, query: 'QUILLWORT' },
  { isNarrowable: true, query: 'llwor' },
  { isNarrowable: true, query: '"silver harbour lantern"' },
  { isNarrowable: true, query: '/silver harbou?r lantern/' },
  { isNarrowable: true, query: 'ЖУРАВЛИНА' },
  { isNarrowable: true, query: 'σοφος' },
  { isNarrowable: true, query: 'quillwort lantern' },
  { isNarrowable: true, query: 'quillwort OR журавлина' },
  { isNarrowable: true, query: 'quillwort -lantern' },
  { isNarrowable: true, query: 'content:quillwort' },
  { isNarrowable: true, query: 'match-case:Quillwort' },
  // A name-only query reads no content, with or without the plugin.
  { isNarrowable: false, query: 'file:alpha' },
  { isNarrowable: true, query: 'path:parity/sub quillwort' },
  { isNarrowable: true, query: 'tag:#plant' },
  { isNarrowable: true, query: 'tag:plant/fern' },
  { isNarrowable: true, query: 'name-only-marker' },
  { isNarrowable: true, query: 'canvasterm' },
  { isNarrowable: true, query: '("harbour lantern" OR file:beta) quillwort' },
  { isNarrowable: false, query: '-quillwort' },
  { isNarrowable: false, query: '/[0-9]{5}/' },
  { isNarrowable: false, query: '[status]' },
  { isNarrowable: false, query: 'line:(quillwort lantern)' },
  { isNarrowable: false, query: 'task-todo:quillwort' },
  { isNarrowable: false, query: 'qu' }
];

describe('core Search parity with the plugin on and off', () => {
  let vaultPath = '';

  beforeAll(async () => {
    vaultPath = getTemporaryVault().path;
    await evalInObsidian({
      async callback({ app, folder, noteCount }) {
        await app.vault.createFolder(folder);
        await app.vault.createFolder(`${folder}/sub`);
        const words = ['meadow', 'river', 'stone', 'cloud', 'ember', 'willow', 'harbour', 'lantern'];
        for (let index = 0; index < noteCount; index++) {
          const lines: string[] = [];
          if (index % 19 === 0) {
            lines.push('---', 'tags: [plant]', `status: ${index % 2 === 0 ? 'open' : 'done'}`, '---');
          }
          lines.push(`Note ${String(index)} about the ${words[index % words.length] ?? ''} and the ${words[(index * 3) % words.length] ?? ''}.`);
          if (index % 10 === 0) {
            lines.push('A patch of Quillwort grows here.');
          }
          if (index % 25 === 0) {
            lines.push('QUILLWORT, shouted.');
          }
          if (index % 15 === 0) {
            lines.push('The silver harbour lantern.');
          }
          if (index % 20 === 0) {
            lines.push('The silver harbor lantern.');
          }
          if (index % 12 === 0) {
            lines.push('Кущ журавлина.');
          }
          if (index % 33 === 0) {
            lines.push('Ο ΣΟΦΟΣ.');
          }
          if (index % 17 === 0) {
            lines.push('Filed under #plant/fern.');
          }
          if (index % 23 === 0) {
            lines.push('- [ ] water the quillwort lantern');
          }
          if (index % 9 === 0) {
            lines.push(`Code ${String(10_000 + index)}.`);
          }
          const name = index % 5 === 0 ? `alpha-${String(index)}` : (index % 7 === 0 ? `beta-${String(index)}` : `note-${String(index)}`);
          const parent = index % 4 === 0 ? `${folder}/sub` : folder;
          await app.vault.create(`${parent}/${name}.md`, lines.join('\n'));
        }
        await app.vault.create(`${folder}/name-only-marker.md`, 'Nothing to see in the body.');
        await app.vault.create(
          `${folder}/board.canvas`,
          JSON.stringify({ edges: [], nodes: [{ height: 60, id: 'n1', text: 'canvasterm quillwort', type: 'text', width: 200, x: 0, y: 0 }] })
        );

        let reads = 0;
        const originalCachedRead = app.vault.cachedRead.bind(app.vault);
        app.vault.cachedRead = async (file: TFile): Promise<string> => {
          if (file.path.startsWith(`${folder}/`)) {
            reads++;
            await sleep(1);
          }
          return originalCachedRead(file);
        };

        async function runSearch(query: string, duringScan?: () => Promise<void>): Promise<SearchRun> {
          let leaf = app.workspace.getLeavesOfType('search')[0];
          if (!leaf) {
            app.internalPlugins.getEnabledPluginById('global-search')?.openGlobalSearch('');
            leaf = app.workspace.getLeavesOfType('search')[0];
          }
          if (!leaf) {
            throw new Error('Core Search view is not available');
          }
          await app.workspace.revealLeaf(leaf);
          const view = leaf.view as SearchView;
          const component = view.queue;
          const originalStart = component.start.bind(component);
          const stopped = new Promise<void>((resolve) => {
            component.start = (options): ReturnType<typeof originalStart> =>
              originalStart({
                ...options,
                onStop(): void {
                  options?.onStop?.();
                  resolve();
                }
              });
          });
          reads = 0;
          try {
            view.searchComponent.setValue(query);
            view.startSearch();
            await duringScan?.();
            await stopped;
          } finally {
            Reflect.deleteProperty(component, 'start');
          }
          return {
            paths: Array.from(view.dom.resultDomLookup.keys(), (file) => file.path).filter((path) => path.startsWith(`${folder}/`)).sort(),
            reads
          };
        }

        const state: ParityState = {
          restore(): void {
            app.vault.cachedRead = originalCachedRead;
          },
          runSearch
        };
        Object.assign(window, { indexedSearchParityTest: state });
      },
      input: { folder: FOLDER, noteCount: NOTE_COUNT },
      vaultPath
    });
    await evalInObsidian({
      async callback({ app, lib: { waitUntil }, pluginId }) {
        await waitUntil({
          predicate: () => app.vault.getMarkdownFiles().every((file) => app.metadataCache.getFileCache(file)),
          timeoutInMilliseconds: 20_000
        });
        const plugin = app.plugins.getPlugin(pluginId) as IndexPlugin | null;
        if (!plugin) {
          throw new Error('Plugin not loaded');
        }
        await plugin.trigramIndexComponent.whenIdle();
      },
      input: { pluginId: PLUGIN_ID },
      vaultPath
    });
  });

  afterAll(async () => {
    await evalInObsidian({
      async callback({ app, folder, pluginId }) {
        window.indexedSearchParityTest?.restore();
        Reflect.deleteProperty(window, 'indexedSearchParityTest');
        if (!app.plugins.enabledPlugins.has(pluginId)) {
          await app.plugins.enablePlugin(pluginId);
        }
        const root = app.vault.getFolderByPath(folder);
        if (root) {
          await app.fileManager.trashFile(root);
        }
      },
      input: { folder: FOLDER, pluginId: PLUGIN_ID },
      vaultPath
    });
  });

  it.each(QUERIES)('returns core\'s own results for $query', async ({ isNarrowable, query }) => {
    const result = await evalInObsidian({
      async callback({ app, pluginId, query: searchQuery }) {
        const state = window.indexedSearchParityTest;
        if (!state) {
          throw new Error('The parity test state is missing');
        }
        await app.plugins.disablePlugin(pluginId);
        const plain = await state.runSearch(searchQuery);
        await app.plugins.enablePlugin(pluginId);
        const plugin = app.plugins.getPlugin(pluginId) as IndexPlugin | null;
        if (!plugin) {
          throw new Error('Plugin not loaded');
        }
        await plugin.trigramIndexComponent.whenIdle();
        const narrowed = await state.runSearch(searchQuery);
        return { narrowed, plain };
      },
      input: { pluginId: PLUGIN_ID, query },
      vaultPath
    });

    expect(result.plain.paths.length).toBeGreaterThan(0);
    expect(result.narrowed.paths).toEqual(result.plain.paths);
    if (!isNarrowable) {
      return;
    }

    expect(result.plain.reads).toBeGreaterThan(NOTE_COUNT);
    expect(result.narrowed.reads).toBeLessThan(result.plain.reads / 2);
  });

  it('finds a note edited to match while the narrowed scan runs', async () => {
    const isResult = await evalInObsidian({
      async callback({ app, folder, lib: { waitUntil } }) {
        const state = window.indexedSearchParityTest;
        if (!state) {
          throw new Error('The parity test state is missing');
        }
        const path = `${folder}/note-1.md`;
        const file = app.vault.getFileByPath(path);
        if (!file) {
          throw new Error('The edited note is missing');
        }
        const original = await app.vault.read(file);
        try {
          await state.runSearch('quillwort', async () => {
            await app.vault.modify(file, `${original}\nNow with quillwort.`);
          });
          const view = app.workspace.getLeavesOfType('search')[0]?.view as SearchView | undefined;
          function isShown(): boolean {
            return Array.from(view?.dom.resultDomLookup.keys() ?? [], (resultFile) => resultFile.path).includes(path);
          }
          // Core queues the edited note again once its metadata is recomputed, which may be after the first pass.
          try {
            await waitUntil({ predicate: isShown, timeoutInMilliseconds: 5000 });
          } catch {
            return false;
          }
          return isShown();
        } finally {
          await app.vault.modify(file, original);
        }
      },
      input: { folder: FOLDER },
      vaultPath
    });

    expect(isResult).toBe(true);
  });
});
