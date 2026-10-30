/**
 * @file
 *
 * Desktop-only memory hooks of the engine benchmark: Node's process memory reading and V8's garbage collector.
 * The benchmark runs only in the desktop renderer, where these are the measurement.
 */

import {
  invokeAsyncSafely,
  sleep
} from '@mnaoumov/typescript-lib/async';
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
 * The highest readings within one bucket of a task's run; `-Infinity` for a reading not taken in that bucket.
 */
export interface MemoryTimelineBucket {
  readonly heapUsed: number;
  readonly privateBytes: number;
  readonly rss: number;
  /**
   * The bucket's start, in milliseconds from the start of the task.
   */
  readonly startInMilliseconds: number;
}
/**
 * The highest readings seen while a task ran.
 */
export interface PeakMemory {
  readonly peakArrayBuffers: number;
  readonly peakHeapUsed: number;
  /**
   * The highest private bytes (commit charge) of the renderer process, which the OS does not trim the way it
   * trims the resident set.
   */
  readonly peakPrivateBytes: number;
  /**
   * The largest rise of the private bytes above the lowest reading before it.
   */
  readonly peakPrivateBytesRise: number;
  readonly peakRss: number;
  /**
   * The largest rise of the resident set above the lowest reading before it. A baseline taken while the process is
   * still giving memory back reads high, which makes `peakRss` minus it read low; a rise from a low the task itself
   * reached does not depend on the baseline at all.
   */
  readonly peakRssRise: number;
  /**
   * The highest readings in each {@link TIMELINE_BUCKET_IN_MILLISECONDS} of the task, so a peak can be told from
   * a climb.
   */
  readonly timeline: readonly MemoryTimelineBucket[];
}

/**
 * A task's result with the memory peaks seen while it ran.
 */
export interface WithPeakMemoryResult<T> {
  readonly peak: PeakMemory;
  readonly result: T;
}

/**
 * Electron's addition to the renderer's `process`, which has no typings in this project.
 */
interface ElectronProcess {
  readonly getProcessMemoryInfo: () => Promise<ElectronProcessMemoryInfo>;
}

/**
 * Electron's process memory reading, in kilobytes.
 */
interface ElectronProcessMemoryInfo {
  readonly private: number;
}

/* eslint-disable typescript-dev-toolkit/readonly-interface-members -- Each bucket takes the highest reading of its two seconds as samples arrive. */
/**
 * A timeline bucket while the task runs, before it is handed out read-only.
 */
interface TimelineBucketState {
  heapUsed: number;
  privateBytes: number;
  rss: number;
  readonly startInMilliseconds: number;
}
/* eslint-enable typescript-dev-toolkit/readonly-interface-members -- End of the timeline bucket state. */

const BYTES_PER_KILOBYTE = 1024;
const BYTES_PER_MEGABYTE = BYTES_PER_KILOBYTE * BYTES_PER_KILOBYTE;
const MEMORY_SAMPLE_INTERVAL_IN_MILLISECONDS = 20;
const PRIVATE_BYTES_SAMPLE_EVERY = 10;
const SETTLE_INTERVAL_IN_MILLISECONDS = 250;
const SETTLE_TIMEOUT_IN_MILLISECONDS = 5000;
const SETTLE_TOLERANCE_IN_MEGABYTES = 2;
const TIMELINE_BUCKET_IN_MILLISECONDS = 2000;

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
 * Reads the renderer process's private bytes through Electron.
 *
 * @returns The private bytes.
 */
export async function measurePrivateBytes(): Promise<number> {
  if (!isElectronProcess(process)) {
    throw new Error('The renderer process has no Electron memory reading');
  }
  const info = await process.getProcessMemoryInfo();
  return info.private * BYTES_PER_KILOBYTE;
}

/**
 * Collects garbage, then waits until the resident set stops falling, so a baseline taken right after does not
 * still hold memory the OS is about to give back. Such a baseline makes every later delta read low.
 *
 * @returns The settled reading.
 */
export async function settleMemory(): Promise<MemorySample> {
  collectGarbage();
  let previous = measureMemory();
  const deadline = performance.now() + SETTLE_TIMEOUT_IN_MILLISECONDS;
  while (performance.now() < deadline) {
    await sleep({ milliseconds: SETTLE_INTERVAL_IN_MILLISECONDS });
    const current = measureMemory();
    if (Math.abs(current.rss - previous.rss) < SETTLE_TOLERANCE_IN_MEGABYTES * BYTES_PER_MEGABYTE) {
      return current;
    }
    previous = current;
  }
  return previous;
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
  let peakPrivateBytes = 0;
  let lowestPrivateBytes = Infinity;
  let peakPrivateBytesRise = 0;
  let peakRss = 0;
  let lowestRss = Infinity;
  let peakRssRise = 0;
  const start = performance.now();
  const timeline: TimelineBucketState[] = [];
  let sampleCount = 0;
  function getBucket(): TimelineBucketState {
    const startInMilliseconds = Math.floor((performance.now() - start) / TIMELINE_BUCKET_IN_MILLISECONDS) * TIMELINE_BUCKET_IN_MILLISECONDS;
    const last = timeline.at(-1);
    if (last?.startInMilliseconds === startInMilliseconds) {
      return last;
    }
    // A reading the bucket never took stays `-Infinity`, which JSON writes as `null` rather than a false zero.
    const bucket = { heapUsed: -Infinity, privateBytes: -Infinity, rss: -Infinity, startInMilliseconds };
    timeline.push(bucket);
    return bucket;
  }
  async function samplePrivateBytes(): Promise<void> {
    const privateBytes = await measurePrivateBytes();
    peakPrivateBytes = Math.max(peakPrivateBytes, privateBytes);
    lowestPrivateBytes = Math.min(lowestPrivateBytes, privateBytes);
    peakPrivateBytesRise = Math.max(peakPrivateBytesRise, privateBytes - lowestPrivateBytes);
    const bucket = getBucket();
    bucket.privateBytes = Math.max(bucket.privateBytes, privateBytes);
  }
  function sample(): void {
    const memory = measureMemory();
    peakArrayBuffers = Math.max(peakArrayBuffers, memory.arrayBuffers);
    peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
    peakRss = Math.max(peakRss, memory.rss);
    lowestRss = Math.min(lowestRss, memory.rss);
    peakRssRise = Math.max(peakRssRise, memory.rss - lowestRss);
    const bucket = getBucket();
    bucket.heapUsed = Math.max(bucket.heapUsed, memory.heapUsed);
    bucket.rss = Math.max(bucket.rss, memory.rss);
    // Electron answers asynchronously and costs more than a synchronous reading, so it is read less often.
    if (sampleCount++ % PRIVATE_BYTES_SAMPLE_EVERY === 0) {
      invokeAsyncSafely(samplePrivateBytes);
    }
  }
  sample();
  const timer = window.setInterval(sample, MEMORY_SAMPLE_INTERVAL_IN_MILLISECONDS);
  try {
    const result = await task();
    sample();
    await samplePrivateBytes();
    return { peak: { peakArrayBuffers, peakHeapUsed, peakPrivateBytes, peakPrivateBytesRise, peakRss, peakRssRise, timeline }, result };
  } finally {
    window.clearInterval(timer);
  }
}

function isElectronProcess(value: object): value is ElectronProcess {
  return 'getProcessMemoryInfo' in value && typeof value.getProcessMemoryInfo === 'function';
}
