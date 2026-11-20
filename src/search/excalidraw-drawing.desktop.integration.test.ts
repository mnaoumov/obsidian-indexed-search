/**
 * @file
 *
 * With `shouldIgnoreExcalidrawDrawings` on, core Search in a real Obsidian no longer lists an `Excalidraw` note for a
 * term found only in its drawing data, still lists it for its text elements, and lists every other note as before.
 * Off, it lists exactly what core lists.
 *
 * Search is driven through the view's own `startSearch`, which is what its input box calls; the result list is
 * read from the view's result lookup once its queue stops.
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

import type { PluginSettings } from '../plugin-settings.ts';
import type { TrigramIndexComponent } from '../trigram-index/trigram-index-component.ts';

interface SettingsEditor {
  readonly editAndSave: (editor: (settings: PluginSettings) => void) => Promise<void>;
}

interface SettingsPlugin {
  readonly pluginSettingsComponent: SettingsEditor;
  readonly trigramIndexComponent: TrigramIndexComponent;
}

const FOLDER = 'excalidraw';
const PLUGIN_ID = 'indexed-search';

describe('ignoring Excalidraw drawing data', () => {
  let vaultPath = '';

  beforeAll(async () => {
    vaultPath = getTemporaryVault().path;
    await evalInObsidian({
      async callback({ app, folder, lib: { waitUntil }, pluginId }) {
        await app.vault.createFolder(folder);
        const fence = '`'.repeat(3);
        await app.vault.create(
          `${folder}/sketch.excalidraw.md`,
          [
            '---',
            'excalidraw-plugin: parsed',
            '---',
            '# Excalidraw Data',
            '## Text Elements',
            'A kittenwort by the gate ^a1',
            '',
            '%%',
            '## Drawing',
            `${fence}compressed-json`,
            'N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCpAzoQPYB2KqATLZMzYBXUtiRoIACyhQ4zZAHoFAc0JR',
            'JQgEYA6bGwC2zebrawortcalamintx',
            fence,
            '%%',
            ''
          ].join('\n')
        );
        await app.vault.create(`${folder}/plain.md`, 'A zebrawort in the meadow.');
        await app.vault.create(`${folder}/fake.md`, `## Drawing\n${fence}json\n{"text":"zebrawort"}\n${fence}\n`);
        await waitUntil({
          predicate: () => app.vault.getMarkdownFiles().every((file) => app.metadataCache.getFileCache(file)),
          timeoutInMilliseconds: 20_000
        });
        const plugin = app.plugins.getPlugin(pluginId) as null | SettingsPlugin;
        if (!plugin) {
          throw new Error('Plugin not loaded');
        }
        await plugin.trigramIndexComponent.whenIdle();
      },
      input: { folder: FOLDER, pluginId: PLUGIN_ID },
      vaultPath
    });
  });

  afterAll(async () => {
    await evalInObsidian({
      async callback({ app, folder, pluginId }) {
        const plugin = app.plugins.getPlugin(pluginId) as null | SettingsPlugin;
        await plugin?.pluginSettingsComponent.editAndSave((settings) => {
          settings.shouldIgnoreExcalidrawDrawings = false;
        });
        const root = app.vault.getFolderByPath(folder);
        if (root) {
          await app.fileManager.trashFile(root);
        }
      },
      input: { folder: FOLDER, pluginId: PLUGIN_ID },
      vaultPath
    });
  });

  it('drops a drawing matched only in its data, keeps its text elements, and changes nothing when off', async () => {
    const result = await evalInObsidian({
      async callback({ app, folder, pluginId }) {
        const plugin = app.plugins.getPlugin(pluginId) as null | SettingsPlugin;
        if (!plugin) {
          throw new Error('Plugin not loaded');
        }

        async function runSearch(query: string): Promise<string[]> {
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
          try {
            view.searchComponent.setValue(query);
            view.startSearch();
            await stopped;
          } finally {
            Reflect.deleteProperty(component, 'start');
          }
          return Array.from(view.dom.resultDomLookup.keys(), (file) => file.path).filter((path) => path.startsWith(`${folder}/`)).sort();
        }

        async function runAll(): Promise<Record<string, string[]>> {
          return {
            calamint: await runSearch('calamint'),
            kittenwort: await runSearch('kittenwort'),
            zebrawort: await runSearch('zebrawort')
          };
        }

        const off = await runAll();
        await plugin.pluginSettingsComponent.editAndSave((settings) => {
          settings.shouldIgnoreExcalidrawDrawings = true;
        });
        const on = await runAll();
        return { off, on };
      },
      input: { folder: FOLDER, pluginId: PLUGIN_ID },
      vaultPath
    });

    expect(result.off).toEqual({
      calamint: [`${FOLDER}/sketch.excalidraw.md`],
      kittenwort: [`${FOLDER}/sketch.excalidraw.md`],
      zebrawort: [`${FOLDER}/fake.md`, `${FOLDER}/plain.md`, `${FOLDER}/sketch.excalidraw.md`]
    });
    expect(result.on).toEqual({
      calamint: [],
      kittenwort: [`${FOLDER}/sketch.excalidraw.md`],
      zebrawort: [`${FOLDER}/fake.md`, `${FOLDER}/plain.md`]
    });
  });
});
