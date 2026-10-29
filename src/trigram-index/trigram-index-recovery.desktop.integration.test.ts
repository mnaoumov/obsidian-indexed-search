/**
 * @file
 *
 * The index survives being cut off mid-build and mid-update, in a real Obsidian on real IndexedDB.
 *
 * A second index component, isolated under its own store id, is cut off from inside a file read: the read
 * unloads it, which closes its stores under whatever write is in flight, as a quit leaves them. A fresh component
 * on the same stores must then read fewer files than a full build would, and answer exactly. The unit suite cuts
 * off every single write in turn on an in-memory IndexedDB; this file does it on the real one.
 *
 * Compaction is off (compactShare: 1), so every read a restart makes is its recheck; the unit suite covers it.
 *
 * Each step is its own call into Obsidian, because one call may run for at most 30 seconds; the state between
 * steps lives on the renderer's `window`.
 */

import type {
  App,
  TFile
} from 'obsidian';

import { evalInObsidian } from 'obsidian-integration-testing';
import { getTemporaryVault } from 'obsidian-integration-testing/vitest-global-setup-plugin';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { TrigramIndexComponent } from './trigram-index-component.ts';
import type { TrigramIndexConstructorParams } from './trigram-index.ts';
import type { TrigramQuery } from './trigram-query.ts';

import { literalQuery } from './trigram-query.ts';

declare global {
  interface Window {
    /**
     * The recovery test's state between its calls into Obsidian.
     */
    readonly indexedSearchRecoveryTest?: RecoveryState;
  }
}

interface IndexPlugin {
  readonly trigramIndexComponent: TrigramIndexComponent;
}

interface RecoveryState {
  /**
   * Counts reads of the test notes from now on, and unloads `victim` from inside the `killAt`-th one.
   */
  readonly armKill: (killAt: number, victim: null | TrigramIndexComponent) => void;
  readonly candidatePaths: (component: TrigramIndexComponent) => Promise<string[]>;
  readonly createComponent: () => TrigramIndexComponent;
  readonly getChangeCount: () => number;
  readonly getReadCount: () => number;
  readonly getSurvivor: () => null | TrigramIndexComponent;
  readonly getUpdatedCount: () => number;
  readonly markUpdated: (index: number) => void;
  readonly matchingPaths: () => string[];
  readonly notePaths: readonly string[];
  readonly restore: () => void;
  readonly setSurvivor: (component: TrigramIndexComponent) => void;
}

type TrigramIndexComponentConstructor = new (params: TrigramIndexComponentTestParams) => TrigramIndexComponent;

interface TrigramIndexComponentTestParams {
  readonly app: App;
  readonly indexOptions: Omit<TrigramIndexConstructorParams, 'filesStore' | 'log' | 'postingsStore'>;
  readonly pluginId: string;
}

const BUILD_KILL_READ = 250;
const FOLDER = 'recovery';
const NOTE_COUNT = 600;
const PLUGIN_ID = 'indexed-search';
const SEGMENT_SIZE = 16;
const STORE_PLUGIN_ID = 'indexed-search-recovery-test';
const UPDATE_KILL_READ = 40;

describe('trigram index recovery after a kill', () => {
  let vaultPath = '';
  let updatedCount = 0;

  beforeAll(async () => {
    vaultPath = getTemporaryVault().path;
    await evalInObsidian({
      async callback({ app, folder, noteCount, pluginId, query, segmentSize, storePluginId }) {
        const plugin = app.plugins.getPlugin(pluginId) as IndexPlugin | null;
        if (!plugin) {
          throw new Error('Plugin not loaded');
        }
        const Component = plugin.trigramIndexComponent.constructor as TrigramIndexComponentConstructor;
        // The plugin's own index would read the same notes; the test's component is the only reader left.
        await app.plugins.disablePlugin(pluginId);
        for (const storeId of ['trigram-files-v1', 'trigram-postings-v1']) {
          await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(`obsidian-lib:${JSON.stringify([app.appId, storePluginId, storeId])}`);
            request.addEventListener('success', () => {
              resolve();
            });
            request.addEventListener('error', () => {
              reject(new Error('Could not delete the test stores'));
            });
          });
        }
        const updated = new Set<number>();
        function isMatch(index: number): boolean {
          return updated.has(index) ? index % 2 === 0 && index % 7 !== 0 : index % 7 === 0;
        }
        function toIndex(path: string): number {
          return Number(path.slice(`${folder}/note-`.length, -'.md'.length));
        }
        await app.vault.createFolder(folder);
        const notePaths: string[] = [];
        for (let index = 0; index < noteCount; index++) {
          const text = isMatch(index) ? `note ${String(index)} about quillwort` : `note ${String(index)} about something plain`;
          const note = await app.vault.create(`${folder}/note-${String(index)}.md`, text);
          notePaths.push(note.path);
        }

        let readCount = 0;
        let killAtRead = Infinity;
        let victim: null | TrigramIndexComponent = null;
        let survivor: null | TrigramIndexComponent = null;
        let changeCount = 0;
        const originalCachedRead = app.vault.cachedRead.bind(app.vault);
        app.vault.cachedRead = async (file: TFile): Promise<string> => {
          if (file.path.startsWith(`${folder}/`)) {
            readCount++;
            if (readCount === killAtRead) {
              victim?.unload();
            }
          }
          return originalCachedRead(file);
        };
        const changedRef = app.metadataCache.on('changed', (file) => {
          if (file.path.startsWith(`${folder}/`)) {
            changeCount++;
          }
        });
        const state: RecoveryState = {
          armKill(killAt: number, component: null | TrigramIndexComponent): void {
            readCount = 0;
            killAtRead = killAt;
            victim = component;
          },
          async candidatePaths(component: TrigramIndexComponent): Promise<string[]> {
            const files = await component.selectCandidates(app.vault.getMarkdownFiles(), query);
            return files.map((file) => file.path).filter((path) => path.startsWith(`${folder}/`)).sort();
          },
          createComponent(): TrigramIndexComponent {
            return new Component({ app, indexOptions: { compactShare: 1, readConcurrency: 2, segmentSize, writeBatchSize: 8 }, pluginId: storePluginId });
          },
          getChangeCount: (): number => changeCount,
          getReadCount: (): number => readCount,
          getSurvivor: (): null | TrigramIndexComponent => survivor,
          getUpdatedCount: (): number => updated.size,
          markUpdated(index: number): void {
            updated.add(index);
          },
          matchingPaths(): string[] {
            return notePaths.filter((path) => isMatch(toIndex(path))).sort();
          },
          notePaths,
          restore(): void {
            app.vault.cachedRead = originalCachedRead;
            app.metadataCache.offref(changedRef);
            survivor?.unload();
          },
          setSurvivor(component: TrigramIndexComponent): void {
            survivor = component;
          }
        };
        Object.assign(window, { indexedSearchRecoveryTest: state });
      },
      input: {
        folder: FOLDER,
        noteCount: NOTE_COUNT,
        pluginId: PLUGIN_ID,
        query: literalQuery('quillwort') satisfies TrigramQuery,
        segmentSize: SEGMENT_SIZE,
        storePluginId: STORE_PLUGIN_ID
      },
      vaultPath
    });
    // The metadata cache reads every new note too; the counting starts only once it is done.
    await evalInObsidian({
      async callback({ app, lib: { waitUntil } }) {
        const state = window.indexedSearchRecoveryTest;
        if (!state) {
          throw new Error('The recovery test state is missing');
        }
        await waitUntil({
          predicate: () => state.notePaths.every((path) => app.metadataCache.getCache(path)),
          timeoutInMilliseconds: 20_000
        });
      },
      vaultPath
    });
  });

  afterAll(async () => {
    await evalInObsidian({
      async callback({ app, folder, pluginId }) {
        const state = window.indexedSearchRecoveryTest;
        if (!state) {
          throw new Error('The recovery test state is missing');
        }
        state.restore();
        // One trash of the whole folder: a trash per note took past the per-eval cap on a loaded machine.
        const recoveryFolder = app.vault.getFolderByPath(folder);
        if (recoveryFolder) {
          await app.fileManager.trashFile(recoveryFolder);
        }
        Reflect.deleteProperty(window, 'indexedSearchRecoveryTest');
        await app.plugins.enablePlugin(pluginId);
      },
      input: { folder: FOLDER, pluginId: PLUGIN_ID },
      vaultPath
    });
  });

  it('resumes a build cut off mid-way, without starting over', async () => {
    const readsBeforeKill = await evalInObsidian({
      async callback({ killAt }) {
        const state = window.indexedSearchRecoveryTest;
        if (!state) {
          throw new Error('The recovery test state is missing');
        }
        const victim = state.createComponent();
        state.armKill(killAt, victim);
        victim.load();
        await victim.whenIdle();
        return state.getReadCount();
      },
      input: { killAt: BUILD_KILL_READ },
      vaultPath
    });
    const resumed = await evalInObsidian({
      async callback() {
        const state = window.indexedSearchRecoveryTest;
        if (!state) {
          throw new Error('The recovery test state is missing');
        }
        const survivor = state.createComponent();
        state.armKill(Infinity, null);
        state.setSurvivor(survivor);
        survivor.load();
        await survivor.whenIdle();
        return {
          candidates: await state.candidatePaths(survivor),
          expected: state.matchingPaths(),
          indexed: survivor.getIndexedFileCount(),
          reads: state.getReadCount()
        };
      },
      vaultPath
    });

    // The cut-off build read no further than the files already in flight.
    expect(readsBeforeKill).toBeGreaterThanOrEqual(BUILD_KILL_READ);
    expect(readsBeforeKill).toBeLessThan(BUILD_KILL_READ + SEGMENT_SIZE);
    // The restart read the rest, at most a segment more, and not every note again.
    expect(resumed.reads).toBeGreaterThan(0);
    expect(resumed.reads).toBeLessThanOrEqual(NOTE_COUNT - BUILD_KILL_READ + SEGMENT_SIZE);
    expect(resumed.indexed).toBeGreaterThanOrEqual(NOTE_COUNT);
    expect(resumed.candidates).toEqual(resumed.expected);
  });

  it('resumes an update cut off mid-way, reading only changed notes', async () => {
    const modified = await evalInObsidian({
      async callback({ app, folder }) {
        const state = window.indexedSearchRecoveryTest;
        if (!state) {
          throw new Error('The recovery test state is missing');
        }
        const changesBefore = state.getChangeCount();
        for (const path of state.notePaths) {
          const index = Number(path.slice(`${folder}/note-`.length, -'.md'.length));
          const file = app.vault.getFileByPath(path);
          if (!(file && (index % 7 === 0 || index % 2 === 0))) {
            continue;
          }

          state.markUpdated(index);
          await app.vault.modify(file, index % 7 === 0 ? `changed ${String(index)} plain` : `changed ${String(index)} quillwort`);
        }
        return { changesBefore, updatedCount: state.getUpdatedCount() };
      },
      input: { folder: FOLDER },
      vaultPath
    });
    updatedCount = modified.updatedCount;
    await evalInObsidian({
      async callback({ changeTarget, lib: { waitUntil } }) {
        const state = window.indexedSearchRecoveryTest;
        if (!state) {
          throw new Error('The recovery test state is missing');
        }
        // Every modified note's metadata is recomputed from its new text first, so those reads are over.
        await waitUntil({
          predicate: () => state.getChangeCount() >= changeTarget,
          timeoutInMilliseconds: 20_000
        });
      },
      input: { changeTarget: modified.changesBefore + modified.updatedCount },
      vaultPath
    });
    const readsBeforeKill = await evalInObsidian({
      async callback({ killAt }) {
        const state = window.indexedSearchRecoveryTest;
        if (!state) {
          throw new Error('The recovery test state is missing');
        }
        const survivor = state.getSurvivor();
        if (!survivor) {
          throw new Error('The build step left no index');
        }
        state.armKill(killAt, survivor);
        await survivor.whenIdle();
        return state.getReadCount();
      },
      input: { killAt: UPDATE_KILL_READ },
      vaultPath
    });
    const resumed = await evalInObsidian({
      async callback() {
        const state = window.indexedSearchRecoveryTest;
        if (!state) {
          throw new Error('The recovery test state is missing');
        }
        const survivor = state.createComponent();
        state.armKill(Infinity, null);
        state.setSurvivor(survivor);
        survivor.load();
        await survivor.whenIdle();
        return {
          candidates: await state.candidatePaths(survivor),
          expected: state.matchingPaths(),
          indexed: survivor.getIndexedFileCount(),
          reads: state.getReadCount()
        };
      },
      vaultPath
    });

    expect(readsBeforeKill).toBeGreaterThanOrEqual(UPDATE_KILL_READ);
    expect(readsBeforeKill).toBeLessThan(updatedCount);
    expect(resumed.reads).toBeGreaterThan(0);
    expect(resumed.reads).toBeLessThanOrEqual(updatedCount);
    expect(resumed.indexed).toBeGreaterThanOrEqual(NOTE_COUNT);
    expect(resumed.candidates).toEqual(resumed.expected);
  });
});
