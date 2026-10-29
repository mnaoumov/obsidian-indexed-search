/**
 * @file
 *
 * The postings of one segment of file ids, collected in memory before they are written.
 *
 * Each `(trigram, file)` pair is packed into one number, `denseTrigramId * segmentSize + localId`, so sorting the
 * pairs groups them by trigram with the file ids ascending inside each group. The pairs live in a `Uint32Array`
 * while every packed pair fits 32 bits, and move to a `Float64Array` only when a segment has so many distinct
 * trigrams that they no longer do.
 */

/* eslint-disable unicorn/prefer-code-point -- Core's regexes have no `u` flag, so trigrams are UTF-16 code units. */

import { getFoldTable } from './case-folding.ts';
import { packTrigram } from './trigram-query.ts';

/**
 * One trigram's file ids in a segment.
 */
export interface SegmentPostingRun {
  /**
   * The file ids, ascending.
   */
  readonly ids: Uint32Array;
  /**
   * The packed trigram.
   */
  readonly trigram: number;
}

/**
 * Where a segment's postings start and how many ids it holds.
 */
export interface SegmentPostingsConstructorParams {
  /**
   * The first id of the segment.
   */
  readonly segmentBase: number;
  /**
   * The number of ids in a segment.
   */
  readonly segmentSize: number;
}

const GROWTH_FACTOR = 2;
const INITIAL_DENSE_CAPACITY = 4096;
const INITIAL_PAIR_CAPACITY = 65_536;
const TRIGRAM_LENGTH = 3;
const UINT32_LIMIT = 0x1_00_00_00_00;

/**
 * Collects the trigrams of the files of one segment.
 */
export class SegmentPostings {
  private readonly denseIds = new Map<number, number>();
  private documentFrequencies = new Uint32Array(INITIAL_DENSE_CAPACITY);
  private readonly foldTable = getFoldTable();
  private lastSeen = new Int32Array(INITIAL_DENSE_CAPACITY).fill(-1);
  private pairCount = 0;
  private pairs: Float64Array | Uint32Array = new Uint32Array(INITIAL_PAIR_CAPACITY);
  private readonly segmentBase: number;
  private readonly segmentSize: number;
  private readonly trigramKeys: number[] = [];

  /**
   * Creates an empty collection for one segment.
   *
   * @param params - The segment's position.
   */
  public constructor(params: SegmentPostingsConstructorParams) {
    this.segmentBase = params.segmentBase;
    this.segmentSize = params.segmentSize;
  }

  /**
   * Adds the trigrams of one file's text, folded the way core Search folds case.
   *
   * @param text - The file's text.
   * @param id - The file's id, inside this segment.
   */
  public addText(text: string, id: number): void {
    const localId = id - this.segmentBase;
    if (localId < 0 || localId >= this.segmentSize) {
      throw new RangeError(`File id ${String(id)} is outside its segment`);
    }
    if (text.length < TRIGRAM_LENGTH) {
      return;
    }
    let first = this.foldTable[text.charCodeAt(0)] ?? 0;
    let second = this.foldTable[text.charCodeAt(1)] ?? 0;
    for (let index = TRIGRAM_LENGTH - 1; index < text.length; index++) {
      const third = this.foldTable[text.charCodeAt(index)] ?? 0;
      this.addPair(this.getDenseId(packTrigram(first, second, third)), localId);
      first = second;
      second = third;
    }
  }

  /**
   * Returns how many files of this segment contain each trigram.
   *
   * @returns The document frequency of every trigram seen.
   */
  public getDocumentFrequencies(): Map<number, number> {
    const frequencies = new Map<number, number>();
    for (const [denseId, trigram] of this.trigramKeys.entries()) {
      frequencies.set(trigram, this.documentFrequencies[denseId] ?? 0);
    }
    return frequencies;
  }

  /**
   * Returns every trigram seen, ascending.
   *
   * @returns The packed trigrams.
   */
  public getTrigrams(): Float64Array {
    return Float64Array.from(this.trigramKeys).sort();
  }

  /**
   * Sorts the pairs and yields one run per trigram. Call once, after every text is added.
   *
   * @yields Each trigram with its file ids.
   */
  public *runs(): Generator<SegmentPostingRun> {
    const sorted = this.pairs.subarray(0, this.pairCount).sort();
    let runStart = 0;
    while (runStart < this.pairCount) {
      const denseId = Math.floor((sorted[runStart] ?? 0) / this.segmentSize);
      let runEnd = runStart;
      while (runEnd < this.pairCount && Math.floor((sorted[runEnd] ?? 0) / this.segmentSize) === denseId) {
        runEnd++;
      }
      const ids = new Uint32Array(runEnd - runStart);
      for (let index = runStart; index < runEnd; index++) {
        ids[index - runStart] = this.segmentBase + ((sorted[index] ?? 0) % this.segmentSize);
      }
      yield { ids, trigram: this.trigramKeys[denseId] ?? 0 };
      runStart = runEnd;
    }
  }

  private addPair(denseId: number, localId: number): void {
    if (this.lastSeen[denseId] === localId) {
      return;
    }
    this.lastSeen[denseId] = localId;
    this.documentFrequencies[denseId] = (this.documentFrequencies[denseId] ?? 0) + 1;
    if (this.pairCount === this.pairs.length) {
      this.pairs = this.copyPairs(this.pairs.length * GROWTH_FACTOR, this.pairs instanceof Float64Array);
    }
    this.pairs[this.pairCount++] = denseId * this.segmentSize + localId;
  }

  private copyPairs(capacity: number, isWide: boolean): Float64Array | Uint32Array {
    const copy = isWide ? new Float64Array(capacity) : new Uint32Array(capacity);
    copy.set(this.pairs.subarray(0, this.pairCount));
    return copy;
  }

  private getDenseId(trigram: number): number {
    let denseId = this.denseIds.get(trigram);
    if (denseId !== undefined) {
      return denseId;
    }
    denseId = this.trigramKeys.length;
    this.denseIds.set(trigram, denseId);
    this.trigramKeys.push(trigram);
    if (denseId >= this.lastSeen.length) {
      const lastSeen = new Int32Array(this.lastSeen.length * GROWTH_FACTOR).fill(-1);
      lastSeen.set(this.lastSeen);
      this.lastSeen = lastSeen;
      const documentFrequencies = new Uint32Array(this.documentFrequencies.length * GROWTH_FACTOR);
      documentFrequencies.set(this.documentFrequencies);
      this.documentFrequencies = documentFrequencies;
    }
    if (!(this.pairs instanceof Float64Array) && (denseId + 1) * this.segmentSize > UINT32_LIMIT) {
      this.pairs = this.copyPairs(this.pairs.length, true);
    }
    return denseId;
  }
}

/* eslint-enable unicorn/prefer-code-point -- End of the file-wide UTF-16 code unit section. */
