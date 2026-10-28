/**
 * @file
 *
 * Desktop-only memory hooks of the engine benchmark: Node's process memory reading and V8's garbage collector.
 * The benchmark runs only in the desktop renderer, where these are the measurement.
 */

import process from 'node:process';
import v8 from 'node:v8';
import vm from 'node:vm';

/**
 * One memory reading of the renderer process.
 */
export interface MemorySample {
  /**
   * Bytes of `ArrayBuffer`s of the main isolate, outside its JS heap.
   */
  readonly arrayBuffers: number;
  /**
   * The main isolate's JS heap in use.
   */
  readonly heapUsed: number;
  /**
   * The resident set of the whole renderer process, workers included.
   */
  readonly rss: number;
}

/**
 * The highest readings seen while a task ran.
 */
export interface PeakMemory {
  readonly peakArrayBuffers: number;
  readonly peakHeapUsed: number;
  readonly peakRss: number;
}

/**
 * A task's result with the memory peaks seen while it ran.
 */
export interface WithPeakMemoryResult<T> {
  readonly peak: PeakMemory;
  readonly result: T;
}

const MEMORY_SAMPLE_INTERVAL_IN_MILLISECONDS = 20;

/**
 * Forces a full garbage collection through V8's `gc`, exposed on demand.
 */
export function collectGarbage(): void {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  gc();
  gc();
}

/**
 * Reads the renderer's memory.
 *
 * @returns The sample.
 */
export function measureMemory(): MemorySample {
  const usage = process.memoryUsage();
  return { arrayBuffers: usage.arrayBuffers, heapUsed: usage.heapUsed, rss: usage.rss };
}

/**
 * Runs a task while sampling memory, and reports the peaks.
 *
 * @param task - The task.
 * @returns The task's result and the peaks.
 */
export async function withPeakMemory<T>(task: () => Promise<T>): Promise<WithPeakMemoryResult<T>> {
  let peakArrayBuffers = 0;
  let peakHeapUsed = 0;
  let peakRss = 0;
  function sample(): void {
    const memory = measureMemory();
    peakArrayBuffers = Math.max(peakArrayBuffers, memory.arrayBuffers);
    peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
    peakRss = Math.max(peakRss, memory.rss);
  }
  sample();
  const timer = window.setInterval(sample, MEMORY_SAMPLE_INTERVAL_IN_MILLISECONDS);
  try {
    const result = await task();
    sample();
    return { peak: { peakArrayBuffers, peakHeapUsed, peakRss }, result };
  } finally {
    window.clearInterval(timer);
  }
}
