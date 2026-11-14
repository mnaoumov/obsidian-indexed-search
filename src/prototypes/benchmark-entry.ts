/**
 * @file
 *
 * The bundle entry the engine benchmark loads inside Obsidian. A callback sent to Obsidian cannot import, so
 * the benchmark bundles this module as an IIFE named `indexedSearchBenchmark` and loads it as a script there.
 */

/* v8 ignore file -- Not unit tested: the engine benchmark's bundle entry, loaded as a script into a real Obsidian by the desktop performance suite, which is its test. */

import {
  literalQuery,
  regexQuery
} from '../trigram-index/trigram-query.ts';
import {
  fileNameCandidates,
  runCoreSearch
} from './benchmark-harness.ts';
import { BenchmarkState } from './benchmark-state.ts';
import { BruteScanEngine } from './brute-scan-engine.ts';
import {
  collectGarbage,
  measureMemory,
  measurePrivateBytes,
  settleMemory,
  withPeakMemory
} from './desktop-memory.ts';
import { TrigramIndexEngine } from './trigram-index-engine.ts';

/**
 * Everything a benchmark callback reaches in the renderer.
 */
export const benchmarkApi = {
  BruteScanEngine,
  collectGarbage,
  fileNameCandidates,
  literalQuery,
  measureMemory,
  measurePrivateBytes,
  regexQuery,
  runCoreSearch,
  settleMemory,
  state: new BenchmarkState(),
  TrigramIndexEngine,
  withPeakMemory
};

/**
 * The type of {@link benchmarkApi}.
 */
export type BenchmarkApi = typeof benchmarkApi;
