/**
 * @file
 *
 * The bundle entry the engine benchmark loads inside Obsidian. A callback sent to Obsidian cannot import, so
 * the benchmark bundles this module as an IIFE named `indexedSearchBenchmark` and loads it as a script there.
 */

import {
  fileNameCandidates,
  runCoreSearch
} from './benchmark-harness.ts';
import { BenchmarkState } from './benchmark-state.ts';
import { BruteScanEngine } from './brute-scan-engine.ts';
import {
  collectGarbage,
  measureMemory,
  withPeakMemory
} from './desktop-memory.ts';
import { TrigramIndexEngine } from './trigram-index-engine.ts';
import {
  literalQuery,
  regexQuery
} from './trigram-query.ts';

/**
 * Everything a benchmark callback reaches in the renderer.
 */
export const benchmarkApi = {
  BruteScanEngine,
  collectGarbage,
  fileNameCandidates,
  literalQuery,
  measureMemory,
  regexQuery,
  runCoreSearch,
  state: new BenchmarkState(),
  TrigramIndexEngine,
  withPeakMemory
};

/**
 * The type of {@link benchmarkApi}.
 */
export type BenchmarkApi = typeof benchmarkApi;
