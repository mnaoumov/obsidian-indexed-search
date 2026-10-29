/**
 * @file
 *
 * The plugin's own index, built from scratch on the 37,000-note, 110 MB corpus, stays inside the memory and disk
 * budget `AGENTS.md` sets, and its candidates keep every note a plain term matches.
 *
 * Each figure is what the index ADDS over the same moment with the plugin disabled: the JS heap and the process's
 * resident set (which also holds every `ArrayBuffer` and worker), at rest after a forced garbage collection and at
 * the peak of the build, and the origin's storage usage.
 */

import type { TFile } from 'obsidian';

import { waitForPerformanceVaultScan } from '@mnaoumov/obsidian-dev-toolkit/test-runners/performance-vault-scan';
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

import { loadRendererBundle } from '../../scripts/helpers/renderer-bundle.ts';
import { literalQuery } from './trigram-query.ts';

interface IndexPlugin {
  readonly trigramIndexComponent: TrigramIndexComponent;
}

const BYTES_PER_MEGABYTE = 1024 * 1024;
const FILE_COUNT = 37_000;
const PEAK_BUDGET_IN_BYTES = 256 * BYTES_PER_MEGABYTE;
const DISK_BUDGET_IN_BYTES = 220 * BYTES_PER_MEGABYTE;
const PLUGIN_ID = 'indexed-search';
// Measured at 0.66 s on a loaded machine with the file records packed per segment, against 3.7 to 22 s with one
// record per path; the bound sits between the two, so a regression to per-path reads fails it.
const RESTART_BUDGET_IN_MILLISECONDS = 2000;
const SCAN_TIMEOUT_IN_MILLISECONDS = 900_000;
const STEADY_BUDGET_IN_BYTES = 64 * BYTES_PER_MEGABYTE;
const STORE_IDS = ['trigram-files-v1', 'trigram-postings-v1'];

describe('the trigram index on the 37,000-note corpus', () => {
  let vaultPath = '';

  beforeAll(async () => {
    vaultPath = getTemporaryVault().path;
    await waitForPerformanceVaultScan({
      cachePath: 'links/link-0.md',
      expectedFileCount: FILE_COUNT,
      timeoutInMilliseconds: SCAN_TIMEOUT_IN_MILLISECONDS,
      vaultPath
    });
    await loadRendererBundle({
      entryUrl: new URL('../prototypes/benchmark-entry.ts', import.meta.url),
      globalName: 'indexedSearchBenchmark',
      vaultPath
    });
  }, SCAN_TIMEOUT_IN_MILLISECONDS);

  afterAll(() => {
    console.warn(`Trigram index budget results:\n${JSON.stringify(results, null, 2)}`);
  });

  const results: Record<string, unknown> = {};

  it('builds within the peak, steady and disk budgets, and restarts quickly without rereading', async () => {
    const measured = await evalInObsidian({
      async callback({ app, pluginId, query, storeIds }) {
        const api = window.indexedSearchBenchmark?.benchmarkApi;
        if (!api) {
          throw new Error('The benchmark bundle is not loaded');
        }
        function getComponent(): TrigramIndexComponent {
          const plugin = app.plugins.getPlugin(pluginId) as IndexPlugin | null;
          if (!plugin) {
            throw new Error('Plugin not loaded');
          }
          return plugin.trigramIndexComponent;
        }

        await app.plugins.disablePlugin(pluginId);
        for (const storeId of storeIds) {
          await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(`obsidian-lib:${JSON.stringify([app.appId, pluginId, storeId])}`);
            request.addEventListener('success', () => {
              resolve();
            });
            request.addEventListener('error', () => {
              reject(new Error('Could not delete the plugin stores'));
            });
          });
        }
        api.collectGarbage();
        const before = api.measureMemory();
        const storageBefore = await navigator.storage.estimate();

        const buildStart = performance.now();
        const { peak } = await api.withPeakMemory(async () => {
          await app.plugins.enablePlugin(pluginId);
          await getComponent().whenIdle();
        });
        const buildInMilliseconds = performance.now() - buildStart;
        const indexedFileCount = getComponent().getIndexedFileCount();

        api.collectGarbage();
        const after = api.measureMemory();
        const storageAfter = await navigator.storage.estimate();

        const files = app.vault.getMarkdownFiles();
        const queryStart = performance.now();
        const candidateFiles = await getComponent().selectCandidates(files, query);
        const candidates = new Set(candidateFiles.map((file) => file.path));
        const queryInMilliseconds = performance.now() - queryStart;
        const missing: string[] = [];
        for (const file of files) {
          if (candidates.has(file.path)) {
            continue;
          }
          const text = await app.vault.cachedRead(file);
          if (text.toLowerCase().includes('quillwort')) {
            missing.push(file.path);
          }
        }

        const originalCachedRead = app.vault.cachedRead.bind(app.vault);
        let restartReads = 0;
        Object.assign(app.vault, {
          async cachedRead(file: TFile): Promise<string> {
            restartReads++;
            return originalCachedRead(file);
          }
        });
        let restartInMilliseconds: number;
        try {
          await app.plugins.disablePlugin(pluginId);
          const restartStart = performance.now();
          await app.plugins.enablePlugin(pluginId);
          await getComponent().whenIdle();
          restartInMilliseconds = performance.now() - restartStart;
        } finally {
          Object.assign(app.vault, { cachedRead: originalCachedRead });
        }

        return {
          after,
          before,
          buildInMilliseconds,
          candidateCount: candidates.size,
          indexedFileCount,
          missing,
          peak,
          queryInMilliseconds,
          restartInMilliseconds,
          restartReads,
          storageUsageDelta: (storageAfter.usage ?? 0) - (storageBefore.usage ?? 0)
        };
      },
      input: { pluginId: PLUGIN_ID, query: literalQuery('quillwort'), storeIds: STORE_IDS },
      vaultPath
    });
    Object.assign(results, measured);

    expect(measured.indexedFileCount).toBe(FILE_COUNT);
    expect(measured.missing).toEqual([]);
    expect(measured.candidateCount).toBeLessThan(FILE_COUNT / 10);
    expect(measured.restartReads).toBe(0);
    expect(measured.restartInMilliseconds).toBeLessThanOrEqual(RESTART_BUDGET_IN_MILLISECONDS);
    expect(measured.after.heapUsed - measured.before.heapUsed).toBeLessThanOrEqual(STEADY_BUDGET_IN_BYTES);
    expect(measured.after.rss - measured.before.rss).toBeLessThanOrEqual(STEADY_BUDGET_IN_BYTES);
    expect(measured.peak.peakHeapUsed - measured.before.heapUsed).toBeLessThanOrEqual(PEAK_BUDGET_IN_BYTES);
    expect(measured.peak.peakRss - measured.before.rss).toBeLessThanOrEqual(PEAK_BUDGET_IN_BYTES);
    expect(measured.storageUsageDelta).toBeLessThanOrEqual(DISK_BUDGET_IN_BYTES);
  }, SCAN_TIMEOUT_IN_MILLISECONDS);
});
