/**
 * @file
 *
 * On the 37,000-note, 110 MB corpus, core Search answers the same results several times faster with the plugin
 * on than with it off.
 *
 * Each query runs with the plugin disabled, so core scans every file, and then enabled with its index caught up,
 * so the plugin narrows core's queue. Each side takes the median of a few runs, timed from `startSearch` until
 * core's queue first runs dry, with the OS file cache warm and the result pane rendering.
 */

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

import type { TrigramIndexComponent } from '../trigram-index/trigram-index-component.ts';

import { loadRendererBundle } from '../../scripts/helpers/renderer-bundle.ts';

interface IndexPlugin {
  readonly trigramIndexComponent: TrigramIndexComponent;
}

interface SearchMeasurement {
  readonly medianInMilliseconds: number;
  readonly paths: string[];
  readonly releaseMedianInMilliseconds: null | number;
  readonly syncMedianInMilliseconds: number;
}

const FILE_COUNT = 37_000;
const MIN_SPEEDUP = 3;
const PLUGIN_ID = 'indexed-search';
// The generator plants `zq<n>x` for every power of ten `n` dividing a filler note's number, so each query's match count is known.
const QUERIES = ['zq100x', '"zq10x zq100x"', 'q1000', '/zq100?0x/', 'ZQ100X'];
const RUN_COUNT = 5;
const SCAN_TIMEOUT_IN_MILLISECONDS = 900_000;
const QUERY_TIMEOUT_IN_MILLISECONDS = 300_000;

describe('core Search with the plugin on the 37,000-note corpus', () => {
  let vaultPath = '';
  const results: Record<string, unknown> = {};

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
    await evalInObsidian({
      async callback({ app, pluginId }) {
        if (!app.plugins.enabledPlugins.has(pluginId)) {
          await app.plugins.enablePlugin(pluginId);
        }
        const plugin = app.plugins.getPlugin(pluginId) as IndexPlugin | null;
        if (!plugin) {
          throw new Error('Plugin not loaded');
        }
        await plugin.trigramIndexComponent.whenIdle();
      },
      input: { pluginId: PLUGIN_ID },
      vaultPath
    });
  }, SCAN_TIMEOUT_IN_MILLISECONDS);

  afterAll(() => {
    console.warn(`Search narrowing results:\n${JSON.stringify(results, null, 2)}`);
  });

  it.each(QUERIES)('answers %s faster, with the same results', async (query) => {
    const measured = await evalInObsidian({
      async callback({ app, pluginId, query: searchQuery, runCount }) {
        const api = window.indexedSearchBenchmark?.benchmarkApi;
        if (!api) {
          throw new Error('The benchmark bundle is not loaded');
        }
        const { runCoreSearch } = api;
        function median(values: number[]): number {
          values.sort((left, right) => left - right);
          return values[Math.floor(values.length / 2)] ?? Infinity;
        }
        async function measure(): Promise<SearchMeasurement> {
          const times: number[] = [];
          const releases: number[] = [];
          const syncs: number[] = [];
          let paths: string[] = [];
          for (let run = 0; run < runCount; run++) {
            const result = await runCoreSearch({ app, candidatePaths: null, query: searchQuery });
            times.push(result.elapsedInMilliseconds);
            syncs.push(result.syncInMilliseconds);
            if (result.releaseInMilliseconds !== null) {
              releases.push(result.releaseInMilliseconds);
            }
            paths = result.paths.sort();
          }
          return {
            medianInMilliseconds: median(times),
            paths,
            releaseMedianInMilliseconds: releases.length === 0 ? null : median(releases),
            syncMedianInMilliseconds: median(syncs)
          };
        }

        await app.plugins.disablePlugin(pluginId);
        const plain = await measure();
        await app.plugins.enablePlugin(pluginId);
        const plugin = app.plugins.getPlugin(pluginId) as IndexPlugin | null;
        if (!plugin) {
          throw new Error('Plugin not loaded');
        }
        await plugin.trigramIndexComponent.whenIdle();
        const narrowed = await measure();
        return {
          narrowedInMilliseconds: narrowed.medianInMilliseconds,
          narrowedPaths: narrowed.paths,
          narrowedReleaseInMilliseconds: narrowed.releaseMedianInMilliseconds,
          narrowedSyncInMilliseconds: narrowed.syncMedianInMilliseconds,
          plainInMilliseconds: plain.medianInMilliseconds,
          plainPaths: plain.paths
        };
      },
      input: { pluginId: PLUGIN_ID, query, runCount: RUN_COUNT },
      vaultPath
    });
    results[query] = {
      matchCount: measured.plainPaths.length,
      narrowedInMilliseconds: Math.round(measured.narrowedInMilliseconds),
      narrowedReleaseInMilliseconds: measured.narrowedReleaseInMilliseconds === null ? null : Math.round(measured.narrowedReleaseInMilliseconds),
      narrowedSyncInMilliseconds: Math.round(measured.narrowedSyncInMilliseconds),
      plainInMilliseconds: Math.round(measured.plainInMilliseconds)
    };

    expect(measured.plainPaths.length).toBeGreaterThan(0);
    expect(measured.narrowedPaths).toEqual(measured.plainPaths);
    expect(measured.narrowedInMilliseconds * MIN_SPEEDUP).toBeLessThan(measured.plainInMilliseconds);
  }, QUERY_TIMEOUT_IN_MILLISECONDS);
});
