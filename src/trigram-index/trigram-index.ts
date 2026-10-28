/**
 * @file
 *
 * The persistent trigram index: which files can contain which trigrams, kept in IndexedDB outside the heap.
 *
 * Every file gets an integer id. Ids are handed out in ascending order and never reused, and they are grouped
 * into segments of `segmentSize`. The postings of one trigram in one segment are one record of delta varints, so
 * a query reads one record per trigram per segment and never loads anything else.
 *
 * A changed file is indexed again under a NEW id at the end; its old id dies the moment the file's record names
 * the new one. A dead id maps to no path, so whatever postings still name it can only ever add nothing. That makes
 * every write crash-safe by ordering alone: ids are reserved in the metadata first, postings are written next and
 * the file records last. A kill at any point leaves postings for ids nobody names, never a file recorded as
 * indexed without its postings. A segment whose trigram list is missing or damaged counts every one of its files
 * as a candidate until it is rebuilt from its files.
 *
 * Every answer is a SUPERSET of the files that can match. An id the index wrongly includes costs a file read; one
 * it wrongly excluded would be a missing search result, so every uncertain case includes.
 */

import type { LocalDataStore } from '@mnaoumov/obsidian-lib/data-stores/local-data-store';

import { noopAsync } from '@mnaoumov/typescript-lib/function';

import type { SegmentPostingRun } from './segment-postings.ts';
import type { TrigramQuery } from './trigram-query.ts';

import {
  decodeCheckedPostings,
  encodePostings,
  evaluateQuery,
  isTypedArray,
  unite
} from './postings.ts';
import { SegmentPostings } from './segment-postings.ts';
import { collectTrigrams } from './trigram-query.ts';

/**
 * A file the index is asked about, with the stats observed before its text is read.
 */
export interface IndexedFileStat {
  /**
   * Last modification time, in milliseconds.
   */
  readonly mtime: number;
  /**
   * The vault-relative path.
   */
  readonly path: string;
  /**
   * Size in bytes.
   */
  readonly size: number;
}

/**
 * Reads one file's text, or returns `null` when the file is gone or unreadable.
 */
export type ReadIndexedFile = (file: IndexedFileStat) => Promise<null | string>;

/**
 * Looks up a file's current stats, or returns `null` when it is gone.
 */
export type StatIndexedFile = (path: string) => IndexedFileStat | null;

/**
 * Where the index keeps its records, and how it builds them.
 */
export interface TrigramIndexConstructorParams {
  /**
   * A trigram in at least this share of the files indexed in one pass is stored as "every file", with no list.
   *
   * @default 0.9
   */
  readonly commonShare?: number;
  /**
   * A segment is rebuilt when at least this share of its ids is dead.
   *
   * @default 0.25
   */
  readonly compactShare?: number;
  /**
   * The store of the metadata and the per-file records.
   */
  readonly filesStore: LocalDataStore;
  /**
   * Receives one line for each notable event: a full-scan fallback, a damaged record, a rebuild.
   */
  readonly log: (message: string) => void;
  /**
   * The fewest files a pass must have indexed before a trigram can be called common.
   *
   * @default 1024
   */
  readonly minCommonFiles?: number;
  /**
   * The store of the posting records and each segment's trigram list.
   */
  readonly postingsStore: LocalDataStore;
  /**
   * How many files are read at once.
   *
   * @default 4
   */
  readonly readConcurrency?: number;
  /**
   * Files per segment.
   *
   * @default 8192
   */
  readonly segmentSize?: number;
  /**
   * How many posting records are written per transaction. Bounding it bounds the memory a write holds.
   *
   * @default 1024
   */
  readonly writeBatchSize?: number;
}

/**
 * What the index knows about one indexed file.
 */
interface FileEntry {
  readonly id: number;
  readonly mtime: number;
  readonly size: number;
}

interface IndexedText {
  readonly entry: FileEntry;
  readonly path: string;
}

interface StoredMeta {
  readonly commonTrigrams: Float64Array;
  readonly nextId: number;
  readonly segmentSize: number;
  readonly version: number;
}

const DEFAULT_COMMON_SHARE = 0.9;
const DEFAULT_COMPACT_SHARE = 0.25;
const DEFAULT_MIN_COMMON_FILES = 1024;
const DEFAULT_READ_CONCURRENCY = 4;
const DEFAULT_SEGMENT_SIZE = 8192;
const DEFAULT_WRITE_BATCH_SIZE = 1024;
const FILE_KEY_PREFIX = 'f:';
const HALF_DIVISOR = 2;
const KEY_RADIX = 36;
const META_KEY = 'meta';
const SCHEMA_VERSION = 1;

/**
 * The trigram index over a set of files.
 */
export class TrigramIndex {
  private readonly commonShare: number;
  private commonTrigrams = new Set<number>();
  private readonly compactedDeadCounts: number[] = [];
  private readonly compactShare: number;
  private readonly damagedSegments = new Set<number>();
  private readonly entries = new Map<string, FileEntry>();
  private readonly filesStore: LocalDataStore;
  private isClosed = false;
  private readonly log: (message: string) => void;
  private readonly minCommonFiles: number;
  private nextId = 0;
  private readonly paths = new Map<number, string>();
  private readonly postingsStore: LocalDataStore;
  private readonly readConcurrency: number;
  private readonly segmentSize: number;
  private readonly segmentTrigrams: (Float64Array | null)[] = [];
  private tail: Promise<unknown> = noopAsync();
  private readonly writeBatchSize: number;

  /**
   * Creates an index over two stores; call {@link load} before anything else.
   *
   * @param params - The stores and the build settings.
   */
  public constructor(params: TrigramIndexConstructorParams) {
    this.commonShare = params.commonShare ?? DEFAULT_COMMON_SHARE;
    this.compactShare = params.compactShare ?? DEFAULT_COMPACT_SHARE;
    this.filesStore = params.filesStore;
    this.log = params.log;
    this.minCommonFiles = params.minCommonFiles ?? DEFAULT_MIN_COMMON_FILES;
    this.postingsStore = params.postingsStore;
    this.readConcurrency = params.readConcurrency ?? DEFAULT_READ_CONCURRENCY;
    this.segmentSize = params.segmentSize ?? DEFAULT_SEGMENT_SIZE;
    this.writeBatchSize = params.writeBatchSize ?? DEFAULT_WRITE_BATCH_SIZE;
  }

  /**
   * Returns the paths of the indexed files a query may match.
   *
   * @param query - The trigram query.
   * @returns The paths, or `null` when the query narrows nothing and every file is a candidate.
   */
  public async candidates(query: TrigramQuery): Promise<null | Set<string>> {
    const trigrams = [...collectTrigrams(query)].filter((trigram) => !this.commonTrigrams.has(trigram));
    const segmentCount = this.getSegmentCount();
    const postings = new Map<number, null | Uint32Array>();
    const unknownSegments = new Set<number>();
    for (let segment = 0; segment < segmentCount; segment++) {
      if (this.segmentTrigrams[segment] === null) {
        unknownSegments.add(segment);
      }
    }
    for (const trigram of this.commonTrigrams) {
      postings.set(trigram, null);
    }
    await Promise.all(trigrams.map(async (trigram) => {
      const lists = await Promise.all(
        Array.from({ length: segmentCount }, async (_, segment) => this.readPostings(trigram, segment, unknownSegments))
      );
      let ids: Uint32Array = new Uint32Array(0);
      for (const list of lists) {
        ids = unite(ids, list);
      }
      postings.set(trigram, ids);
    }));
    let ids = evaluateQuery(query, postings);
    if (ids === null) {
      this.log('The query needs no trigram every match must contain, so core Search scans every file.');
      return null;
    }
    for (const segment of unknownSegments) {
      ids = unite(ids, this.getLiveIds(segment));
    }
    const paths = new Set<string>();
    for (const id of ids) {
      const path = this.paths.get(id);
      if (path !== undefined) {
        paths.add(path);
      }
    }
    return paths;
  }

  /**
   * Closes both stores. Writes still queued fail, and lose nothing a later {@link sync} does not redo.
   */
  public close(): void {
    this.isClosed = true;
    this.filesStore.close();
    this.postingsStore.close();
  }

  /**
   * Returns how many files are indexed.
   *
   * @returns The count of file records.
   */
  public getIndexedFileCount(): number {
    return this.entries.size;
  }

  /**
   * Waits for every queued write.
   *
   * @returns A promise that settles once the queue is empty.
   */
  public async idle(): Promise<void> {
    let tail: Promise<unknown>;
    do {
      tail = this.tail;
      await tail.catch(() => undefined);
    } while (tail !== this.tail);
  }

  /**
   * Tells whether a file's postings are current, so that the index may exclude it.
   *
   * @param file - The file with its current stats.
   * @returns Whether its record matches those stats.
   */
  public isIndexed(file: IndexedFileStat): boolean {
    const entry = this.entries.get(file.path);
    return entry?.mtime === file.mtime && entry.size === file.size;
  }

  /**
   * Reads the metadata, the file records and each segment's trigram list. Damaged parts are dropped or marked for
   * a rebuild; damaged metadata clears the whole index.
   *
   * @returns A promise that resolves once the index is usable.
   */
  public async load(): Promise<void> {
    await this.enqueue(async () => {
      this.entries.clear();
      this.paths.clear();
      this.damagedSegments.clear();
      this.segmentTrigrams.length = 0;
      this.compactedDeadCounts.length = 0;
      const meta = parseMeta(await this.filesStore.get(META_KEY));
      if (meta?.segmentSize !== this.segmentSize) {
        const storedEntries = await this.filesStore.entries();
        if (meta || storedEntries.length > 0) {
          this.log('The trigram index metadata is missing, damaged or from another version; rebuilding the index.');
        }
        await this.clearStores();
        return;
      }
      this.nextId = meta.nextId;
      this.commonTrigrams = new Set(meta.commonTrigrams);
      await this.loadFileRecords();
      await this.loadSegmentTrigrams();
    });
  }

  /**
   * Rebuilds the segments that are damaged or mostly dead, from their files' current text.
   *
   * @param read - Reads one file's text.
   * @param stat - Looks up a file's current stats.
   * @returns A promise that resolves once every such segment is rebuilt.
   */
  public async maintain(read: ReadIndexedFile, stat: StatIndexedFile): Promise<void> {
    await this.enqueue(async () => {
      for (let segment = 0; segment < this.getSegmentCount(); segment++) {
        if (this.damagedSegments.has(segment) || this.isMostlyDead(segment)) {
          await this.rebuildSegment(segment, read, stat);
        }
      }
    });
  }

  /**
   * Forgets deleted files.
   *
   * @param paths - The deleted files' paths.
   * @returns A promise that resolves once the deletion commits.
   */
  public async remove(paths: readonly string[]): Promise<void> {
    await this.enqueue(async () => {
      await this.removeEntries(paths);
    });
  }

  /**
   * Moves a file's record to its new path; its text, and so its postings, did not change.
   *
   * @param oldPath - The path before the rename.
   * @param newPath - The path after it.
   * @returns A promise that resolves once the move commits.
   */
  public async rename(oldPath: string, newPath: string): Promise<void> {
    await this.enqueue(async () => {
      const entry = this.entries.get(oldPath);
      if (!entry) {
        return;
      }
      await this.filesStore.commit({ entries: [[toFileKey(newPath), entry]], removedKeys: [toFileKey(oldPath)] });
      this.forget(oldPath);
      this.forget(newPath);
      this.remember(newPath, entry);
    });
  }

  /**
   * Returns the files a query may match: every file the index cannot vouch for, and every indexed one whose
   * postings it does not rule out.
   *
   * @typeParam TFile - The caller's file type.
   * @param files - The files to choose from, with their current stats.
   * @param query - The trigram query.
   * @returns The candidates, in the order given.
   */
  public async selectCandidates<TFile extends IndexedFileStat>(files: readonly TFile[], query: TrigramQuery): Promise<TFile[]> {
    const paths = await this.candidates(query);
    return paths === null ? [...files] : files.filter((file) => !this.isIndexed(file) || paths.has(file.path));
  }

  /**
   * Brings the index in line with the files there are: forgets the ones that are gone, and indexes the new and
   * changed ones.
   *
   * @param files - Every file to index, with its current stats.
   * @param read - Reads one file's text.
   * @returns A promise that resolves once every file is indexed.
   */
  public async sync(files: readonly IndexedFileStat[], read: ReadIndexedFile): Promise<void> {
    await this.enqueue(async () => {
      const present = new Set(files.map((file) => file.path));
      await this.removeEntries([...this.entries.keys()].filter((path) => !present.has(path)));
      await this.indexFiles(files.filter((file) => !this.isIndexed(file)), read);
    });
  }

  /**
   * Indexes files that were created or changed.
   *
   * @param files - The files with their current stats.
   * @param read - Reads one file's text.
   * @returns A promise that resolves once they are indexed.
   */
  public async update(files: readonly IndexedFileStat[], read: ReadIndexedFile): Promise<void> {
    await this.enqueue(async () => {
      await this.indexFiles(files.filter((file) => !this.isIndexed(file)), read);
    });
  }

  private async appendPostings(segment: number, postings: SegmentPostings, isNewSegment: boolean): Promise<void> {
    const segmentBase = segment * this.segmentSize;
    const flush = async (batch: readonly SegmentPostingRun[]): Promise<void> => {
      const entries = await Promise.all(batch.map(async (run): Promise<[string, Uint8Array]> => {
        const key = toPostingKey(run.trigram, segment);
        if (isNewSegment) {
          return [key, encodePostings(run.ids, segmentBase)];
        }
        const stored = await this.postingsStore.get(key);
        if (stored === undefined) {
          return [key, encodePostings(run.ids, segmentBase)];
        }
        const existing = decodeCheckedPostings({ bytes: stored, maxExclusive: segmentBase + this.segmentSize, min: segmentBase });
        if (existing === null || !isTypedArray(stored, 'Uint8Array')) {
          await this.markDamaged(segment, `posting record ${key}`);
          return [key, encodePostings(run.ids, segmentBase)];
        }
        // Every new id is above every stored one, so the new deltas simply continue the stored list.
        const appended = encodePostings(run.ids, existing.at(-1) ?? segmentBase);
        const merged = new Uint8Array(stored.length + appended.length);
        merged.set(stored);
        merged.set(appended, stored.length);
        return [key, merged];
      }));
      await this.postingsStore.commit({ entries });
    };
    let batch: SegmentPostingRun[] = [];
    for (const run of postings.runs()) {
      if (this.commonTrigrams.has(run.trigram)) {
        continue;
      }
      batch.push(run);
      if (batch.length !== this.writeBatchSize) {
        continue;
      }

      await flush(batch);
      batch = [];
    }
    if (batch.length > 0) {
      await flush(batch);
    }
  }

  private async clearStores(): Promise<void> {
    await this.filesStore.clear();
    await this.postingsStore.clear();
    this.commonTrigrams = new Set();
    this.nextId = 0;
    await this.saveMeta();
  }

  private async commitRemovals(store: LocalDataStore, keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += this.writeBatchSize) {
      await store.commit({ entries: [], removedKeys: keys.slice(start, start + this.writeBatchSize) });
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // The tail never rejects, so an operation runs after the previous one whether that one failed or not.
    const run = this.tail.then(operation);
    this.tail = run.catch(() => undefined);
    return await run;
  }

  private async findCommonTrigrams(frequencies: Map<number, number>, processedCount: number, segment: number): Promise<void> {
    if (processedCount < this.minCommonFiles) {
      return;
    }
    const threshold = this.commonShare * processedCount;
    const found: number[] = [];
    for (const [trigram, frequency] of frequencies) {
      if (frequency >= threshold && !this.commonTrigrams.has(trigram)) {
        found.push(trigram);
      }
    }
    if (found.length === 0) {
      return;
    }
    for (const trigram of found) {
      this.commonTrigrams.add(trigram);
    }
    // The metadata goes first: once a trigram is common its records are never read, so deleting them after is safe.
    await this.saveMeta();
    const removedKeys: string[] = [];
    for (const trigram of found) {
      for (let earlierSegment = 0; earlierSegment < segment; earlierSegment++) {
        removedKeys.push(toPostingKey(trigram, earlierSegment));
      }
    }
    await this.commitRemovals(this.postingsStore, removedKeys);
  }

  private forget(path: string): void {
    const entry = this.entries.get(path);
    if (!entry) {
      return;
    }

    this.entries.delete(path);
    this.paths.delete(entry.id);
  }

  private getDeadCount(segment: number): number {
    const segmentBase = segment * this.segmentSize;
    const allocated = Math.min(this.nextId, segmentBase + this.segmentSize) - segmentBase;
    return allocated - this.getLiveIds(segment).length;
  }

  private getLiveIds(segment: number): Uint32Array {
    const segmentBase = segment * this.segmentSize;
    const ids: number[] = [];
    for (const id of this.paths.keys()) {
      if (id >= segmentBase && id < segmentBase + this.segmentSize) {
        ids.push(id);
      }
    }
    return Uint32Array.from(ids).sort();
  }

  private getSegmentCount(): number {
    return Math.ceil(this.nextId / this.segmentSize);
  }

  private async indexFiles(files: readonly IndexedFileStat[], read: ReadIndexedFile): Promise<void> {
    const frequencies = new Map<number, number>();
    let processedCount = 0;
    let start = 0;
    while (start < files.length) {
      const firstId = this.nextId;
      const segment = Math.floor(firstId / this.segmentSize);
      const segmentBase = segment * this.segmentSize;
      const chunk = files.slice(start, start + segmentBase + this.segmentSize - firstId);
      start += chunk.length;
      this.nextId += chunk.length;
      await this.saveMeta();

      const postings = new SegmentPostings({ segmentBase, segmentSize: this.segmentSize });
      const indexed = await this.readTexts(chunk, firstId, read, postings);
      processedCount += indexed.length;
      for (const [trigram, frequency] of postings.getDocumentFrequencies()) {
        frequencies.set(trigram, (frequencies.get(trigram) ?? 0) + frequency);
      }
      await this.findCommonTrigrams(frequencies, processedCount, segment);

      const isNewSegment = firstId === segmentBase;
      await this.saveSegmentTrigrams(segment, postings, isNewSegment);
      await this.appendPostings(segment, postings, isNewSegment);
      await this.saveEntries(indexed);
    }
  }

  private isMostlyDead(segment: number): boolean {
    const segmentBase = segment * this.segmentSize;
    const allocated = Math.min(this.nextId, segmentBase + this.segmentSize) - segmentBase;
    const deadSinceRebuild = this.getDeadCount(segment) - (this.compactedDeadCounts[segment] ?? 0);
    return deadSinceRebuild > 0 && deadSinceRebuild >= this.compactShare * allocated;
  }

  private async loadFileRecords(): Promise<void> {
    const removedKeys: string[] = [];
    for (const [key, value] of await this.filesStore.entries()) {
      if (key === META_KEY) {
        continue;
      }
      const entry = key.startsWith(FILE_KEY_PREFIX) ? parseFileEntry(value, this.nextId) : null;
      const path = key.slice(FILE_KEY_PREFIX.length);
      if (!entry || this.paths.has(entry.id)) {
        this.log(`Dropping the damaged trigram index record ${key}; its file is indexed again.`);
        removedKeys.push(key);
        continue;
      }
      this.remember(path, entry);
    }
    await this.commitRemovals(this.filesStore, removedKeys);
  }

  private async loadSegmentTrigrams(): Promise<void> {
    const segmentCount = this.getSegmentCount();
    const lists = await Promise.all(
      Array.from({ length: segmentCount }, async (_, segment) => this.postingsStore.get(toSegmentKey(segment)))
    );
    const compactedDeadCounts = await Promise.all(
      Array.from({ length: segmentCount }, async (_, segment) => this.postingsStore.get(toCompactedKey(segment)))
    );
    for (const [segment, count] of compactedDeadCounts.entries()) {
      this.compactedDeadCounts[segment] = isNonNegativeInteger(count) ? count : 0;
    }
    for (const [segment, list] of lists.entries()) {
      if (isSortedTrigramList(list)) {
        this.segmentTrigrams[segment] = list;
      } else {
        this.segmentTrigrams[segment] = null;
        this.damagedSegments.add(segment);
        this.log(`The trigram list of segment ${String(segment)} is missing or damaged; its files stay candidates until it is rebuilt.`);
      }
    }
  }

  private async markDamaged(segment: number, what: string): Promise<void> {
    this.log(`The trigram index ${what} is damaged; the files of segment ${String(segment)} stay candidates until it is rebuilt.`);
    this.damagedSegments.add(segment);
    this.segmentTrigrams[segment] = null;
    // Deleting the list persists the mark: a restart sees a segment with no list and treats it the same way.
    await this.postingsStore.delete(toSegmentKey(segment));
  }

  private async readPostings(trigram: number, segment: number, unknownSegments: Set<number>): Promise<Uint32Array> {
    const trigrams = this.segmentTrigrams[segment];
    if (!trigrams || !hasTrigram(trigrams, trigram)) {
      return new Uint32Array(0);
    }
    const segmentBase = segment * this.segmentSize;
    const key = toPostingKey(trigram, segment);
    const stored = await this.postingsStore.get(key);
    if (stored === undefined) {
      return new Uint32Array(0);
    }
    const ids = decodeCheckedPostings({ bytes: stored, maxExclusive: segmentBase + this.segmentSize, min: segmentBase });
    if (ids === null) {
      unknownSegments.add(segment);
      await this.enqueue(async () => {
        if (this.segmentTrigrams[segment] !== null) {
          await this.markDamaged(segment, `posting record ${key}`);
        }
      });
      return new Uint32Array(0);
    }
    return ids;
  }

  private async readTexts(
    files: readonly IndexedFileStat[],
    firstId: number,
    read: ReadIndexedFile,
    postings: SegmentPostings
  ): Promise<IndexedText[]> {
    const indexed: IndexedText[] = [];
    await forEachConcurrently(files, this.readConcurrency, async (file, index) => {
      // A closed index reads nothing more: its writes would fail, and the next start rereads what it skipped.
      const text = this.isClosed ? null : await read(file);
      if (text === null) {
        return;
      }
      const id = firstId + index;
      postings.addText(text, id);
      indexed.push({ entry: { id, mtime: file.mtime, size: file.size }, path: file.path });
    });
    return indexed;
  }

  private async rebuildSegment(segment: number, read: ReadIndexedFile, stat: StatIndexedFile): Promise<void> {
    const segmentBase = segment * this.segmentSize;
    const live = [...this.getLiveIds(segment)].flatMap((id) => {
      const path = this.paths.get(id);
      const entry = path === undefined ? undefined : this.entries.get(path);
      return path === undefined || !entry ? [] : [{ entry, path }];
    });
    const postings = new SegmentPostings({ segmentBase, segmentSize: this.segmentSize });
    const stale: string[] = [];
    await forEachConcurrently(live, this.readConcurrency, async (item) => {
      const current = stat(item.path);
      const text = !this.isClosed && current?.mtime === item.entry.mtime && current.size === item.entry.size ? await read(current) : null;
      if (text === null) {
        stale.push(item.path);
      } else {
        postings.addText(text, item.entry.id);
      }
    });
    // A file whose text could not be read as recorded loses its record before its postings are rewritten without it.
    await this.removeEntries(stale);

    const oldTrigrams = this.segmentTrigrams[segment];
    const newTrigrams = postings.getTrigrams().filter((trigram) => !this.commonTrigrams.has(trigram));
    let entries: [string, Uint8Array][] = [];
    for (const run of postings.runs()) {
      if (this.commonTrigrams.has(run.trigram)) {
        continue;
      }
      entries.push([toPostingKey(run.trigram, segment), encodePostings(run.ids, segmentBase)]);
      if (entries.length !== this.writeBatchSize) {
        continue;
      }

      await this.postingsStore.commit({ entries });
      entries = [];
    }
    await this.postingsStore.commit({ entries });
    if (oldTrigrams) {
      const removedKeys = [...oldTrigrams].filter((trigram) => !hasTrigram(newTrigrams, trigram)).map((trigram) => toPostingKey(trigram, segment));
      await this.commitRemovals(this.postingsStore, removedKeys);
    }
    await this.postingsStore.set(toSegmentKey(segment), newTrigrams);
    this.segmentTrigrams[segment] = newTrigrams;
    this.damagedSegments.delete(segment);
    const deadCount = this.getDeadCount(segment);
    await this.postingsStore.set(toCompactedKey(segment), deadCount);
    this.compactedDeadCounts[segment] = deadCount;
    this.log(`Rebuilt segment ${String(segment)} of the trigram index from ${String(live.length - stale.length)} files.`);

    const files = stale.flatMap((path) => {
      const current = stat(path);
      return current ? [current] : [];
    });
    await this.indexFiles(files, read);
  }

  private remember(path: string, entry: FileEntry): void {
    this.entries.set(path, entry);
    this.paths.set(entry.id, path);
  }

  private async removeEntries(paths: readonly string[]): Promise<void> {
    const known = paths.filter((path) => this.entries.has(path));
    await this.commitRemovals(this.filesStore, known.map((path) => toFileKey(path)));
    for (const path of known) {
      this.forget(path);
    }
  }

  private async saveEntries(indexed: readonly IndexedText[]): Promise<void> {
    for (let start = 0; start < indexed.length; start += this.writeBatchSize) {
      const batch = indexed.slice(start, start + this.writeBatchSize);
      await this.filesStore.commit({ entries: batch.map(({ entry, path }) => [toFileKey(path), entry]) });
      for (const { entry, path } of batch) {
        this.forget(path);
        this.remember(path, entry);
      }
    }
  }

  private async saveMeta(): Promise<void> {
    const meta: StoredMeta = {
      commonTrigrams: Float64Array.from(this.commonTrigrams),
      nextId: this.nextId,
      segmentSize: this.segmentSize,
      version: SCHEMA_VERSION
    };
    await this.filesStore.set(META_KEY, meta);
  }

  private async saveSegmentTrigrams(segment: number, postings: SegmentPostings, isNewSegment: boolean): Promise<void> {
    const existing = isNewSegment ? new Float64Array(0) : this.segmentTrigrams[segment];
    if (existing === null || existing === undefined) {
      // An unknown list stays unknown: writing a partial one would claim the segment holds nothing else.
      this.segmentTrigrams[segment] = null;
      this.damagedSegments.add(segment);
      return;
    }
    const added = postings.getTrigrams().filter((trigram) => !this.commonTrigrams.has(trigram) && !hasTrigram(existing, trigram));
    if (added.length === 0 && !isNewSegment) {
      return;
    }
    const merged = new Float64Array(existing.length + added.length);
    merged.set(existing);
    merged.set(added, existing.length);
    merged.sort();
    // The list is written before the postings, so it always names at least every record the segment has.
    await this.postingsStore.set(toSegmentKey(segment), merged);
    this.segmentTrigrams[segment] = merged;
  }
}

/**
 * Runs a callback over items with at most `concurrency` of them in flight, so a build holds only that many texts.
 *
 * @param items - The items.
 * @param concurrency - The most callbacks in flight at once.
 * @param callback - Receives each item and its index.
 * @returns A promise that resolves once every callback has.
 */
async function forEachConcurrently<T>(
  items: readonly T[],
  concurrency: number,
  callback: (item: T, index: number) => Promise<void>
): Promise<void> {
  // One iterator shared by every worker hands each item to exactly one of them.
  const iterator = items.entries();
  async function work(): Promise<void> {
    for (const [index, item] of iterator) {
      await callback(item, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, work));
}

function hasTrigram(trigrams: Float64Array, trigram: number): boolean {
  let low = 0;
  let high = trigrams.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / HALF_DIVISOR);
    const value = trigrams[middle] ?? 0;
    if (value === trigram) {
      return true;
    }
    if (value < trigram) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return false;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSortedTrigramList(value: unknown): value is Float64Array {
  if (!isTypedArray(value, 'Float64Array')) {
    return false;
  }
  for (let index = 1; index < value.length; index++) {
    if ((value[index - 1] ?? 0) >= (value[index] ?? 0)) {
      return false;
    }
  }
  return true;
}

function parseFileEntry(value: unknown, nextId: number): FileEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { id, mtime, size } = value as Partial<Record<keyof FileEntry, unknown>>;
  return !isNonNegativeInteger(id) || id >= nextId || typeof mtime !== 'number' || !Number.isFinite(mtime) || !isNonNegativeInteger(size) ? null : { id, mtime, size };
}

function parseMeta(value: unknown): null | StoredMeta {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { commonTrigrams, nextId, segmentSize, version } = value as Partial<Record<keyof StoredMeta, unknown>>;
  return version !== SCHEMA_VERSION || !isNonNegativeInteger(nextId) || !isNonNegativeInteger(segmentSize) || !isTypedArray(commonTrigrams, 'Float64Array') ? null : { commonTrigrams, nextId, segmentSize, version };
}

function toCompactedKey(segment: number): string {
  return `d:${String(segment)}`;
}

function toFileKey(path: string): string {
  return `${FILE_KEY_PREFIX}${path}`;
}

function toPostingKey(trigram: number, segment: number): string {
  return `p:${trigram.toString(KEY_RADIX)}:${String(segment)}`;
}

function toSegmentKey(segment: number): string {
  return `t:${String(segment)}`;
}
