/**
 * @file
 *
 * The API's `search` answers exactly the files core Search lists, in a real Obsidian.
 *
 * Each query of the corpus runs twice on one vault: through core's Search pane, driven through the view's own
 * `startSearch` (what its input box calls) and read from its result lookup once its queue stops, and through the
 * API reached by the plugin registry. The notes plant terms in content, names, paths, tags, properties, tasks and
 * a canvas, in both cases and in scripts whose case folding differs, so every kind of query core knows is
 * compared against core itself.
 */

import type { SearchView } from '@obsidian-typings/obsidian-public-latest';

import { evalInObsidian } from 'obsidian-integration-testing';
import { getTemporaryVault } from 'obsidian-integration-testing/vitest-global-setup-plugin';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { IndexedSearchApi } from '../../api.d.ts';

interface ConformanceQuery {
  readonly isCaseSensitive?: boolean;
  readonly query: string;
}

interface ConformanceRun {
  readonly apiPaths: string[];
  readonly corePaths: string[];
}

const FOLDER = 'conformance';
const NOTE_COUNT = 120;
const PLUGIN_ID = 'indexed-search';

/**
 * The query corpus: every operator core's query table has, its boolean forms, and the case settings.
 */
const QUERIES: readonly ConformanceQuery[] = [
  { query: 'quillwort' },
  { query: 'QUILLWORT' },
  { isCaseSensitive: true, query: 'QUILLWORT' },
  { query: 'llwor' },
  { query: '"silver harbour lantern"' },
  { query: '/silver harbou?r lantern/' },
  { query: 'ЖУРАВЛИНА' },
  { query: 'σοφος' },
  { query: 'quillwort lantern' },
  { query: 'quillwort OR журавлина' },
  { query: 'quillwort -lantern' },
  { query: '-quillwort' },
  { query: 'content:quillwort' },
  { query: 'match-case:Quillwort' },
  { isCaseSensitive: true, query: 'ignore-case:quillwort' },
  { query: 'file:alpha' },
  { query: 'path:conformance/sub quillwort' },
  { query: 'tag:#plant' },
  { query: 'tag:plant/fern' },
  { query: 'name-only-marker' },
  { query: 'canvasterm' },
  { query: '("harbour lantern" OR file:beta) quillwort' },
  { query: '/[0-9]{5}/' },
  { query: '[status]' },
  { query: '[status:open]' },
  { query: 'line:(quillwort lantern)' },
  { query: 'block:quillwort' },
  { query: 'section:(harbour quillwort)' },
  { query: 'task:quillwort' },
  { query: 'task-todo:quillwort' },
  { query: 'task-done:quillwort' }
];

describe('the search API against core Search', () => {
  let vaultPath = '';

  beforeAll(async () => {
    vaultPath = getTemporaryVault().path;
    await evalInObsidian({
      async callback({ app, folder, lib: { waitUntil }, noteCount }) {
        await app.vault.createFolder(folder);
        await app.vault.createFolder(`${folder}/sub`);
        const words = ['meadow', 'river', 'stone', 'cloud', 'ember', 'willow', 'harbour', 'lantern'];
        for (let index = 0; index < noteCount; index++) {
          const lines: string[] = [];
          if (index % 19 === 0) {
            lines.push('---', 'tags: [plant]', `status: ${index % 2 === 0 ? 'open' : 'done'}`, '---');
          }
          if (index % 11 === 0) {
            lines.push('# Harbour notes');
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
          if (index % 29 === 0) {
            lines.push('- [x] fed the quillwort');
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
        await waitUntil({
          predicate: () => app.vault.getMarkdownFiles().every((file) => app.metadataCache.getFileCache(file)),
          timeoutInMilliseconds: 20_000
        });
      },
      input: { folder: FOLDER, noteCount: NOTE_COUNT },
      vaultPath
    });
  });

  afterAll(async () => {
    await evalInObsidian({
      async callback({ app, folder }) {
        const root = app.vault.getFolderByPath(folder);
        if (root) {
          await app.fileManager.trashFile(root);
        }
      },
      input: { folder: FOLDER },
      vaultPath
    });
  });

  it.each(QUERIES)('answers core\'s own files for $query (case-sensitive: $isCaseSensitive)', async ({ isCaseSensitive, query }) => {
    const run = await evalInObsidian({
      async callback({ app, folder, isCaseSensitive: isSearchCaseSensitive, lib: { findPluginApi }, pluginId, query: searchQuery }): Promise<ConformanceRun> {
        const api = findPluginApi<IndexedSearchApi>({ apiVersionRange: '^1.0.0', pluginId });
        if (!api) {
          throw new Error('The search API is not published');
        }

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
        const wasCaseSensitive = view.matchingCase;
        try {
          view.matchingCase = isSearchCaseSensitive;
          view.searchComponent.setValue(searchQuery);
          view.startSearch();
          await stopped;
        } finally {
          Reflect.deleteProperty(component, 'start');
          view.matchingCase = wasCaseSensitive;
        }

        function isOwn(path: string): boolean {
          return path.startsWith(`${folder}/`);
        }

        const corePaths = Array.from(view.dom.resultDomLookup.keys(), (file) => file.path).filter((path) => isOwn(path)).sort();
        const hits = await api.search(searchQuery, { isCaseSensitive: isSearchCaseSensitive });
        return { apiPaths: hits.map((hit) => hit.file.path).filter((path) => isOwn(path)), corePaths };
      },
      input: { folder: FOLDER, isCaseSensitive: isCaseSensitive ?? false, pluginId: PLUGIN_ID, query },
      vaultPath
    });

    expect(run.corePaths.length).toBeGreaterThan(0);
    expect(run.apiPaths).toEqual(run.corePaths);
  });

  it('reports where a query matched, and answers nothing for an empty query', async () => {
    const result = await evalInObsidian({
      async callback({ folder, lib: { findPluginApi }, pluginId }) {
        const api = findPluginApi<IndexedSearchApi>({ apiVersionRange: '^1.0.0', pluginId });
        if (!api) {
          throw new Error('The search API is not published');
        }
        const hits = await api.search(`path:${folder} "silver harbour lantern"`);
        const canvasHits = await api.search('canvasterm');
        return {
          canvasMatch: canvasHits.find((hit) => hit.file.extension === 'canvas')?.match ?? null,
          empty: await api.search(' '.repeat(3)),
          firstMatch: hits.find((hit) => hit.file.path === `${folder}/sub/alpha-0.md`)?.match ?? null
        };
      },
      input: { folder: FOLDER, pluginId: PLUGIN_ID },
      vaultPath
    });

    expect(result.empty).toEqual([]);
    expect(result.firstMatch?.content).toHaveLength(1);
    expect(result.canvasMatch?.canvasNodes?.['n1']).toEqual([[0, 10]]);
  });

  it('rejects a query core rejects', async () => {
    const message = await evalInObsidian({
      async callback({ lib: { findPluginApi }, pluginId }) {
        const api = findPluginApi<IndexedSearchApi>({ apiVersionRange: '^1.0.0', pluginId });
        if (!api) {
          throw new Error('The search API is not published');
        }
        try {
          await api.search('nosuchoperator:alpha');
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      input: { pluginId: PLUGIN_ID },
      vaultPath
    });

    expect(message).toEqual(expect.any(String));
  });
});
