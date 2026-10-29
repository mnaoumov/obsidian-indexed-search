import type { TFile } from 'obsidian';

import { waitForPerformanceVaultScan } from '@mnaoumov/obsidian-dev-toolkit/test-runners/performance-vault-scan';
import process from 'node:process';
import { evalInObsidian } from 'obsidian-integration-testing';
import { getTemporaryVault } from 'obsidian-integration-testing/vitest-global-setup-plugin';
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { BenchmarkApi } from './benchmark-entry.ts';
import type { BruteScanTerm } from './brute-scan-engine.ts';

import {
  bundleForRenderer,
  loadRendererBundle
} from '../../scripts/helpers/renderer-bundle.ts';

declare global {
  interface Window {
    /**
     * The benchmark bundle, once loaded.
     */
    readonly indexedSearchBenchmark?: BenchmarkBundle;
  }
}

interface BenchmarkBundle {
  readonly benchmarkApi: BenchmarkApi;
}

interface BenchmarkQuery {
  /**
   * The query as typed into core Search.
   */
  readonly coreQuery: string;
  readonly label: string;
  readonly term: BruteScanTerm;
}

type EngineName = 'bruteScan' | 'trigram';

interface EngineQueryResult {
  readonly candidateCount: number;
  readonly candidateMedianInMilliseconds: number;
  readonly label: string;
  readonly missingFromCandidates: string[];
  readonly restrictedCoreMedianInMilliseconds: number;
}

interface EngineQueryRun {
  readonly candidateCount: number;
  readonly candidateTimesInMilliseconds: number[];
  readonly coreTimesInMilliseconds: number[];
  readonly missingFromCandidates: string[];
}

const FILE_COUNT = 37_000;
const PLUGIN_ID = 'indexed-search';
const SCAN_TIMEOUT_IN_MILLISECONDS = 900_000;
const CORE_RUNS = 3;
const CANDIDATE_RUNS = 5;
const TRIGRAM_DATABASE_NAME = 'indexed-search-benchmark-trigrams';
const DEFAULT_TRIGRAM_SEGMENT_SIZE = 8192;
const TRIGRAM_SEGMENT_SIZE = Number(process.env['INDEXED_SEARCH_TRIGRAM_SEGMENT_SIZE'] ?? DEFAULT_TRIGRAM_SEGMENT_SIZE);
const TRIGRAM_COMMON_SHARE = 0.9;
const BRUTE_SCAN_READ_BATCH_SIZE = 256;
const DEFAULT_WORKER_COUNT = 2;
const WORKER_COUNT = Math.max(1, Number(process.env['BULK_CORES'] ?? DEFAULT_WORKER_COUNT));

/**
 * The queries, built on the generator's planted terms, whose document frequencies are exact: filler note `i` holds
 * `zq<n>x` for every power of ten `n` dividing `i`, as consecutive words of its first sentence. So `zq100x`, the
 * phrase `zq10x zq100x` and `/zq100?0x/` each match one filler note in 100, `q1000` (inside `zq1000x` and `zq10000x`)
 * one in 1,000, and the planted terms sit in the Cyrillic notes as well as the Latin ones.
 */
const QUERIES: readonly BenchmarkQuery[] = [
  { coreQuery: 'zq100x', label: 'plain term', term: { kind: 'literal', text: 'zq100x' } },
  { coreQuery: '"zq10x zq100x"', label: 'phrase', term: { kind: 'literal', text: 'zq10x zq100x' } },
  { coreQuery: 'q1000', label: 'infix substring', term: { kind: 'literal', text: 'q1000' } },
  { coreQuery: '/zq100?0x/', label: 'regex', term: { kind: 'regex', source: 'zq100?0x' } },
  { coreQuery: 'ZQ100X', label: 'term, other case', term: { kind: 'literal', text: 'ZQ100X' } },
  { coreQuery: '/[0-9]{5}/', label: 'regex with no required trigram', term: { kind: 'regex', source: '[0-9]{5}' } }
];

const results = new Map<string, unknown>([
  ['fileCount', FILE_COUNT],
  ['trigramSegmentSize', TRIGRAM_SEGMENT_SIZE],
  ['workerCount', WORKER_COUNT]
]);

describe('engine benchmark on the 37,000-note corpus', () => {
  let vaultPath = '';

  beforeAll(async () => {
    vaultPath = getTemporaryVault().path;
    await waitForPerformanceVaultScan({
      cachePath: 'links/link-0.md',
      expectedFileCount: FILE_COUNT,
      timeoutInMilliseconds: SCAN_TIMEOUT_IN_MILLISECONDS,
      vaultPath
    });
    await loadRendererBundle({ entryUrl: new URL('benchmark-entry.ts', import.meta.url), globalName: 'indexedSearchBenchmark', vaultPath });
    await evalInObsidian({
      async callback({ app, pluginId }) {
        const api = window.indexedSearchBenchmark?.benchmarkApi;
        if (!api) {
          throw new Error('The benchmark bundle did not define its API');
        }
        // The plugin's own index would build in the background and skew every number here.
        await app.plugins.disablePlugin(pluginId);
        api.state.setFiles(
          app.vault.getMarkdownFiles()
            .sort((left, right) => left.path.localeCompare(right.path))
            .map((file: TFile) => ({ mtime: file.stat.mtime, path: file.path, size: file.stat.size }))
        );
      },
      input: { pluginId: PLUGIN_ID },
      vaultPath
    });
  }, SCAN_TIMEOUT_IN_MILLISECONDS);

  afterAll(() => {
    console.warn(`Engine benchmark results:\n${JSON.stringify(Object.fromEntries(results), null, 2)}`);
  });

  it('measures core Search with no plugin', async () => {
    const baseline = new Map<string, unknown>();
    for (const query of QUERIES) {
      const timesInMilliseconds = await evalInObsidian({
        async callback({ app, coreQuery, label, runs }) {
          const api = window.indexedSearchBenchmark?.benchmarkApi;
          if (!api) {
            throw new Error('Benchmark bundle not loaded');
          }
          await api.runCoreSearch({ app, candidatePaths: null, query: coreQuery });
          const times: number[] = [];
          for (let run = 0; run < runs; run++) {
            const result = await api.runCoreSearch({ app, candidatePaths: null, query: coreQuery });
            times.push(result.elapsedInMilliseconds);
            api.state.setCoreResult(label, result.paths);
          }
          return times;
        },
        input: { coreQuery: query.coreQuery, label: query.label, runs: CORE_RUNS },
        vaultPath
      });
      const matchCount = await evalInObsidian({
        callback({ label }) {
          return window.indexedSearchBenchmark?.benchmarkApi.state.getCoreResult(label).length ?? 0;
        },
        input: { label: query.label },
        vaultPath
      });
      baseline.set(query.label, { matchCount, medianInMilliseconds: median(timesInMilliseconds), timesInMilliseconds });
    }
    results.set('coreSearch', Object.fromEntries(baseline));
    expect(baseline.size).toBe(QUERIES.length);
  });

  it('builds the trigram index', async () => {
    const buildResult = await evalInObsidian({
      async callback({ app, commonShare, databaseName, segmentSize }) {
        const api = window.indexedSearchBenchmark?.benchmarkApi;
        if (!api) {
          throw new Error('Benchmark bundle not loaded');
        }
        await api.TrigramIndexEngine.deleteDatabase(databaseName);
        api.collectGarbage();
        const before = api.measureMemory();
        const storageBefore = await navigator.storage.estimate();
        const engine = new api.TrigramIndexEngine({ commonShare, databaseName, segmentSize });
        const startTime = performance.now();
        const { peak, result: stats } = await api.withPeakMemory(async () =>
          engine.build(api.state.getFiles(), async (path) => {
            const file = app.vault.getFileByPath(path);
            return file ? app.vault.cachedRead(file) : '';
          })
        );
        const buildInMilliseconds = performance.now() - startTime;
        api.state.setTrigramIndex(engine);
        api.collectGarbage();
        const after = api.measureMemory();
        const storageAfter = await navigator.storage.estimate();
        return { after, before, buildInMilliseconds, peak, stats, storageUsageDelta: (storageAfter.usage ?? 0) - (storageBefore.usage ?? 0) };
      },
      input: { commonShare: TRIGRAM_COMMON_SHARE, databaseName: TRIGRAM_DATABASE_NAME, segmentSize: TRIGRAM_SEGMENT_SIZE },
      vaultPath
    });
    results.set('trigramBuild', buildResult);
    expect(buildResult.stats.distinctTrigramCount).toBeGreaterThan(0);
  });

  it('queries the trigram index', async () => {
    const queryResults: EngineQueryResult[] = [];
    for (const query of QUERIES) {
      queryResults.push(await measureEngineQuery('trigram', query));
    }
    results.set('trigramQueries', queryResults);
    for (const queryResult of queryResults) {
      expect(queryResult.missingFromCandidates, queryResult.label).toEqual([]);
    }
  });

  it('reopens the trigram index as a restart would', async () => {
    const coldStart = await evalInObsidian({
      async callback({ commonShare, databaseName, segmentSize }) {
        const api = window.indexedSearchBenchmark?.benchmarkApi;
        if (!api) {
          throw new Error('Benchmark bundle not loaded');
        }
        api.state.getTrigramIndex().close();
        api.state.setTrigramIndex(null);
        api.collectGarbage();
        const before = api.measureMemory();
        const startTime = performance.now();
        const engine = new api.TrigramIndexEngine({ commonShare, databaseName, segmentSize });
        await engine.open();
        const openInMilliseconds = performance.now() - startTime;
        await engine.candidates(api.literalQuery('zq100x'));
        const firstQueryInMilliseconds = performance.now() - startTime;
        api.collectGarbage();
        const resting = api.measureMemory();
        engine.close();
        return { before, firstQueryInMilliseconds, openInMilliseconds, resting };
      },
      input: { commonShare: TRIGRAM_COMMON_SHARE, databaseName: TRIGRAM_DATABASE_NAME, segmentSize: TRIGRAM_SEGMENT_SIZE },
      vaultPath
    });
    results.set('trigramColdStart', coldStart);
    expect(coldStart.openInMilliseconds).toBeGreaterThan(0);
  });

  it('builds the brute-scan buffers', async () => {
    const workerCode = await bundleForRenderer(new URL('brute-scan-worker-entry.ts', import.meta.url));
    const buildResult = await evalInObsidian({
      async callback({ app, code, readBatchSize, workerCount }) {
        const api = window.indexedSearchBenchmark?.benchmarkApi;
        if (!api) {
          throw new Error('Benchmark bundle not loaded');
        }
        api.collectGarbage();
        const before = api.measureMemory();
        const engine = new api.BruteScanEngine({ readBatchSize, workerCount, workerSource: code });
        const startTime = performance.now();
        const { peak, result: stats } = await api.withPeakMemory(async () =>
          engine.build(api.state.getFiles(), async (path) => {
            const file = app.vault.getFileByPath(path);
            return file ? app.vault.cachedRead(file) : '';
          })
        );
        const buildInMilliseconds = performance.now() - startTime;
        api.state.setBruteScan(engine);
        api.collectGarbage();
        const after = api.measureMemory();
        return { after, before, buildInMilliseconds, peak, stats };
      },
      input: { code: workerCode, readBatchSize: BRUTE_SCAN_READ_BATCH_SIZE, workerCount: WORKER_COUNT },
      vaultPath
    });
    results.set('bruteScanBuild', buildResult);
    expect(buildResult.stats.bufferBytes).toBeGreaterThan(0);
  });

  it('queries the brute-scan buffers', async () => {
    const queryResults: EngineQueryResult[] = [];
    for (const query of QUERIES) {
      queryResults.push(await measureEngineQuery('bruteScan', query));
    }
    results.set('bruteScanQueries', queryResults);
    await evalInObsidian({
      callback() {
        const state = window.indexedSearchBenchmark?.benchmarkApi.state;
        state?.getBruteScan().terminate();
        state?.setBruteScan(null);
      },
      vaultPath
    });
    for (const queryResult of queryResults) {
      expect(queryResult.missingFromCandidates, queryResult.label).toEqual([]);
    }
  });

  async function measureEngineQuery(engineName: EngineName, query: BenchmarkQuery): Promise<EngineQueryResult> {
    const run = await evalInObsidian({
      async callback({ app, candidateRuns, coreQuery, coreRuns, engineName: name, label, term }): Promise<EngineQueryRun> {
        const api = window.indexedSearchBenchmark?.benchmarkApi;
        if (!api) {
          throw new Error('Benchmark bundle not loaded');
        }
        const paths = api.state.getFiles().map((file) => file.path);
        const candidateTimesInMilliseconds: number[] = [];
        let candidatePaths: null | Set<string> = null;
        for (let candidateRun = 0; candidateRun < candidateRuns; candidateRun++) {
          const startTime = performance.now();
          let ids: null | Uint32Array;
          if (name === 'trigram') {
            const trigramQuery = term.kind === 'literal' ? api.literalQuery(term.text) : api.regexQuery(term.source);
            ids = await api.state.getTrigramIndex().candidates(trigramQuery);
          } else {
            ids = await api.state.getBruteScan().candidates(term);
          }
          const nameIds = api.fileNameCandidates(paths, term);
          candidatePaths = ids ? new Set(Array.from([...ids, ...nameIds], (id) => paths[id] ?? '')) : null;
          candidateTimesInMilliseconds.push(performance.now() - startTime);
        }
        const coreTimesInMilliseconds: number[] = [];
        for (let coreRun = 0; coreRun < coreRuns; coreRun++) {
          const result = await api.runCoreSearch({ app, candidatePaths, query: coreQuery });
          coreTimesInMilliseconds.push(result.elapsedInMilliseconds);
        }
        const expected = api.state.getCoreResult(label);
        return {
          candidateCount: candidatePaths ? candidatePaths.size : paths.length,
          candidateTimesInMilliseconds,
          coreTimesInMilliseconds,
          missingFromCandidates: candidatePaths ? expected.filter((path) => !candidatePaths.has(path)) : []
        };
      },
      input: {
        candidateRuns: CANDIDATE_RUNS,
        coreQuery: query.coreQuery,
        coreRuns: CORE_RUNS,
        engineName,
        label: query.label,
        term: query.term
      },
      vaultPath
    });
    return {
      candidateCount: run.candidateCount,
      candidateMedianInMilliseconds: median(run.candidateTimesInMilliseconds),
      label: query.label,
      missingFromCandidates: run.missingFromCandidates,
      restrictedCoreMedianInMilliseconds: median(run.coreTimesInMilliseconds)
    };
  }
});

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}
