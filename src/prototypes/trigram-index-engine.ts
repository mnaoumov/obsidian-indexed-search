/**
 * @file
 *
 * Prototype 1: a trigram index kept in IndexedDB.
 *
 * The build reads files in segments of `segmentSize`. Each segment's postings are collected as packed
 * `(trigram id, local file id)` doubles in one typed array, sorted, and written as one record per
 * `[trigram, segment]` holding delta varints, in one transaction per segment. A query reads, per trigram, the
 * key range `[trigram, *]`, which returns every segment's record in ascending id order. Trigrams found in at
 * least `commonShare` of the files are deleted after the build and treated as "every file".
 */

/* eslint-disable unicorn/prefer-code-point -- Core's regexes have no `u` flag, so trigrams are UTF-16 code units. */

import type { TrigramQuery } from '../trigram-index/trigram-query.ts';

import { getFoldTable } from '../trigram-index/case-folding.ts';
import {
  decodePostings,
  encodePostings,
  evaluateQuery
} from '../trigram-index/postings.ts';
import {
  collectTrigrams,
  packTrigram
} from '../trigram-index/trigram-query.ts';

/**
 * One file the index is built from.
 */
export interface IndexedFile {
  readonly mtime: number;
  readonly path: string;
  readonly size: number;
}

/**
 * Reads one file's text.
 */
export type ReadFile = (path: string) => Promise<string>;

/**
 * What a build reports.
 */
export interface TrigramBuildStats {
  readonly commonTrigramCount: number;
  readonly distinctTrigramCount: number;
  readonly postingBytes: number;
  readonly postingCount: number;
  readonly recordCount: number;
}

/**
 * Options of the trigram index prototype.
 */
export interface TrigramIndexEngineConstructorParams {
  /**
   * A trigram in at least this share of files is stored as "every file".
   */
  readonly commonShare: number;
  /**
   * The IndexedDB database name.
   */
  readonly databaseName: string;
  /**
   * Files per segment; at most 65,536, since a local id takes 16 bits of the packed pair.
   */
  readonly segmentSize: number;
}

interface StoredFiles {
  readonly mtimes: Float64Array;
  readonly paths: readonly string[];
  readonly sizes: Float64Array;
}

interface StoredMeta {
  readonly commonTrigrams: Float64Array;
  readonly fileCount: number;
  readonly segmentSize: number;
}

const DATABASE_VERSION = 1;
const FILES_STORE = 'files';
const GROWTH_FACTOR = 2;
const INITIAL_DENSE_CAPACITY = 65_536;
const INITIAL_PAIR_CAPACITY = 4_194_304;
const LOCAL_ID_RADIX = 65_536;
const META_KEY = 'meta';
const META_STORE = 'meta';
const POSTINGS_STORE = 'postings';
const TRIGRAM_LENGTH = 3;

/**
 * Collects one build's postings, segment by segment, holding only one segment's pairs at a time.
 */
class TrigramIndexBuilder {
  private readonly denseIds = new Map<number, number>();
  private documentFrequencies = new Uint32Array(INITIAL_DENSE_CAPACITY);
  private readonly foldTable = getFoldTable();
  private lastSeen = new Int32Array(INITIAL_DENSE_CAPACITY).fill(-1);
  private pairCount = 0;
  private pairs = new Float64Array(INITIAL_PAIR_CAPACITY);
  private postingBytes = 0;
  private postingCount = 0;
  private recordCount = 0;
  private readonly trigramKeys: number[] = [];

  public constructor(private readonly database: IDBDatabase, private readonly segmentSize: number) {}

  public async addSegment(segment: number, segmentFiles: readonly IndexedFile[], read: ReadFile): Promise<void> {
    const segmentBase = segment * this.segmentSize;
    const texts = await Promise.all(segmentFiles.map(async (file) => read(file.path)));
    this.pairCount = 0;
    for (let localId = 0; localId < texts.length; localId++) {
      this.addText(texts[localId] ?? '', segmentBase + localId, localId);
      texts[localId] = '';
    }
    await this.writeSegment(segment, segmentFiles);
  }

  public getCommonTrigrams(threshold: number): number[] {
    const commonTrigrams: number[] = [];
    for (const [denseId, trigramKey] of this.trigramKeys.entries()) {
      if ((this.documentFrequencies[denseId] ?? 0) >= threshold) {
        commonTrigrams.push(trigramKey);
      }
    }
    return commonTrigrams;
  }

  public getStats(commonTrigramCount: number): TrigramBuildStats {
    return {
      commonTrigramCount,
      distinctTrigramCount: this.trigramKeys.length,
      postingBytes: this.postingBytes,
      postingCount: this.postingCount,
      recordCount: this.recordCount
    };
  }

  private addPair(denseId: number, globalId: number, localId: number): void {
    if (this.lastSeen[denseId] === globalId) {
      return;
    }
    this.lastSeen[denseId] = globalId;
    this.documentFrequencies[denseId] = (this.documentFrequencies[denseId] ?? 0) + 1;
    if (this.pairCount === this.pairs.length) {
      const grown = new Float64Array(this.pairs.length * GROWTH_FACTOR);
      grown.set(this.pairs);
      this.pairs = grown;
    }
    this.pairs[this.pairCount++] = denseId * LOCAL_ID_RADIX + localId;
  }

  private addText(text: string, globalId: number, localId: number): void {
    if (text.length < TRIGRAM_LENGTH) {
      return;
    }
    let first = this.foldTable[text.charCodeAt(0)] ?? 0;
    let second = this.foldTable[text.charCodeAt(1)] ?? 0;
    for (let index = TRIGRAM_LENGTH - 1; index < text.length; index++) {
      const third = this.foldTable[text.charCodeAt(index)] ?? 0;
      this.addPair(this.getDenseId(packTrigram(first, second, third)), globalId, localId);
      first = second;
      second = third;
    }
  }

  private getDenseId(key: number): number {
    let denseId = this.denseIds.get(key);
    if (denseId !== undefined) {
      return denseId;
    }
    denseId = this.trigramKeys.length;
    this.denseIds.set(key, denseId);
    this.trigramKeys.push(key);
    if (denseId >= this.lastSeen.length) {
      const lastSeen = new Int32Array(this.lastSeen.length * GROWTH_FACTOR).fill(-1);
      lastSeen.set(this.lastSeen);
      this.lastSeen = lastSeen;
      const documentFrequencies = new Uint32Array(this.documentFrequencies.length * GROWTH_FACTOR);
      documentFrequencies.set(this.documentFrequencies);
      this.documentFrequencies = documentFrequencies;
    }
    return denseId;
  }

  private async writeSegment(segment: number, segmentFiles: readonly IndexedFile[]): Promise<void> {
    const segmentBase = segment * this.segmentSize;
    const sorted = this.pairs.subarray(0, this.pairCount).sort();
    const transaction = this.database.transaction([POSTINGS_STORE, FILES_STORE], 'readwrite');
    const postingsStore = transaction.objectStore(POSTINGS_STORE);
    const ids = new Uint32Array(segmentFiles.length);
    let runStart = 0;
    while (runStart < this.pairCount) {
      const denseId = Math.floor((sorted[runStart] ?? 0) / LOCAL_ID_RADIX);
      let runEnd = runStart;
      while (runEnd < this.pairCount && Math.floor((sorted[runEnd] ?? 0) / LOCAL_ID_RADIX) === denseId) {
        ids[runEnd - runStart] = segmentBase + ((sorted[runEnd] ?? 0) % LOCAL_ID_RADIX);
        runEnd++;
      }
      const bytes = encodePostings(ids.subarray(0, runEnd - runStart), 0);
      postingsStore.put(bytes, [this.trigramKeys[denseId] ?? 0, segment]);
      this.postingBytes += bytes.length;
      this.postingCount += runEnd - runStart;
      this.recordCount++;
      runStart = runEnd;
    }
    const stored: StoredFiles = {
      mtimes: Float64Array.from(segmentFiles, (file) => file.mtime),
      paths: segmentFiles.map((file) => file.path),
      sizes: Float64Array.from(segmentFiles, (file) => file.size)
    };
    transaction.objectStore(FILES_STORE).put(stored, segment);
    await transactionToPromise(transaction);
  }
}

/**
 * The trigram index prototype.
 */
export class TrigramIndexEngine {
  private readonly commonShare: number;
  private commonTrigrams = new Set<number>();
  private database: IDBDatabase | null = null;
  private readonly databaseName: string;
  private fileCount = 0;
  private readonly segmentSize: number;

  public constructor(params: TrigramIndexEngineConstructorParams) {
    if (params.segmentSize > LOCAL_ID_RADIX) {
      throw new RangeError(`segmentSize must be at most ${String(LOCAL_ID_RADIX)}`);
    }
    this.commonShare = params.commonShare;
    this.databaseName = params.databaseName;
    this.segmentSize = params.segmentSize;
  }

  /**
   * Deletes the database.
   *
   * @param databaseName - The database name.
   * @returns A promise that resolves once it is gone.
   */
  public static async deleteDatabase(databaseName: string): Promise<void> {
    await requestToPromise(indexedDB.deleteDatabase(databaseName));
  }

  /**
   * Builds the index from scratch.
   *
   * @param files - The files, in id order.
   * @param read - Reads one file's text.
   * @returns What was built.
   */
  public async build(files: readonly IndexedFile[], read: ReadFile): Promise<TrigramBuildStats> {
    const database = await this.open();
    const builder = new TrigramIndexBuilder(database, this.segmentSize);
    const segmentCount = Math.ceil(files.length / this.segmentSize);
    for (let segment = 0; segment < segmentCount; segment++) {
      const segmentFiles = files.slice(segment * this.segmentSize, (segment + 1) * this.segmentSize);
      await builder.addSegment(segment, segmentFiles, read);
    }
    const commonTrigrams = builder.getCommonTrigrams(Math.ceil(files.length * this.commonShare));
    const transaction = database.transaction([POSTINGS_STORE, META_STORE], 'readwrite');
    const postingsStore = transaction.objectStore(POSTINGS_STORE);
    for (const trigram of commonTrigrams) {
      postingsStore.delete(IDBKeyRange.bound([trigram, 0], [trigram, Infinity]));
    }
    const meta: StoredMeta = { commonTrigrams: Float64Array.from(commonTrigrams), fileCount: files.length, segmentSize: this.segmentSize };
    transaction.objectStore(META_STORE).put(meta, META_KEY);
    await transactionToPromise(transaction);
    this.commonTrigrams = new Set(commonTrigrams);
    this.fileCount = files.length;
    return builder.getStats(commonTrigrams.length);
  }

  /**
   * Returns the ids of the files a query may match.
   *
   * @param query - The trigram query.
   * @returns The candidate ids ascending, or `null` for every file.
   */
  public async candidates(query: TrigramQuery): Promise<null | Uint32Array> {
    const database = await this.open();
    const trigrams = collectTrigrams(query);
    const postings = new Map<number, null | Uint32Array>();
    const transaction = database.transaction(POSTINGS_STORE, 'readonly');
    const store = transaction.objectStore(POSTINGS_STORE);
    await Promise.all(Array.from(trigrams, async (trigram) => {
      if (this.commonTrigrams.has(trigram)) {
        postings.set(trigram, null);
        return;
      }
      const records = await requestToPromise(store.getAll(IDBKeyRange.bound([trigram, 0], [trigram, Infinity])));
      postings.set(trigram, decodeRecords(records));
    }));
    return evaluateQuery(query, postings);
  }

  /**
   * Closes the database connection.
   */
  public close(): void {
    this.database?.close();
    this.database = null;
  }

  /**
   * Returns the number of indexed files.
   *
   * @returns The count.
   */
  public getFileCount(): number {
    return this.fileCount;
  }

  /**
   * Opens the database and loads its metadata, as a restart would.
   *
   * @returns The open database.
   */
  public async open(): Promise<IDBDatabase> {
    if (this.database) {
      return this.database;
    }
    const request = indexedDB.open(this.databaseName, DATABASE_VERSION);
    request.addEventListener('upgradeneeded', (): void => {
      const upgradingDatabase = request.result;
      for (const name of [POSTINGS_STORE, FILES_STORE, META_STORE]) {
        if (!upgradingDatabase.objectStoreNames.contains(name)) {
          upgradingDatabase.createObjectStore(name);
        }
      }
    });
    const database = await requestToPromise(request);
    this.database = database;
    const meta = await requestToPromise(database.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(META_KEY)) as
      | StoredMeta
      | undefined;
    if (meta) {
      this.commonTrigrams = new Set(meta.commonTrigrams);
      this.fileCount = meta.fileCount;
    }
    return database;
  }
}

function decodeRecords(records: readonly Uint8Array[]): Uint32Array {
  let byteCount = 0;
  for (const record of records) {
    byteCount += record.length;
  }
  const target = new Uint32Array(byteCount);
  let offset = 0;
  for (const record of records) {
    offset += decodePostings({ base: 0, bytes: record, offset, target });
  }
  return target.slice(0, offset);
}

async function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', (): void => {
      resolve(request.result);
    });
    request.addEventListener('error', (): void => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    });
  });
}

async function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', (): void => {
      resolve();
    });
    transaction.addEventListener('error', (): void => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    });
    transaction.addEventListener('abort', (): void => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
  });
}

/* eslint-enable unicorn/prefer-code-point -- End of the file-wide UTF-16 code unit section. */
