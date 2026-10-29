import { LocalDataStore } from '@mnaoumov/obsidian-lib/data-stores/local-data-store';
import { noopAsync } from '@mnaoumov/typescript-lib/function';
import { IDBFactory } from 'fake-indexeddb';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type {
  IndexedFileStat,
  TrigramIndexConstructorParams
} from './trigram-index.ts';

import { foldText } from './case-folding.ts';
import { TrigramIndex } from './trigram-index.ts';
import {
  andQuery,
  literalQuery,
  packTrigram
} from './trigram-query.ts';

interface FakeFile {
  readonly mtime: number;
  readonly text: string;
}

interface Harness {
  readonly filesStore: LocalDataStore;
  readonly index: TrigramIndex;
  readonly logs: string[];
  readonly postingsStore: LocalDataStore;
}

type IndexOptions = Omit<TrigramIndexConstructorParams, 'filesStore' | 'log' | 'postingsStore'>;

/**
 * An in-memory vault: paths with text and stats, and a counter of reads.
 */
class FakeVault {
  public readonly reads: string[] = [];
  private clock = 1;
  private readonly files = new Map<string, FakeFile>();

  public constructor(texts: Readonly<Record<string, string>> = {}) {
    for (const [path, text] of Object.entries(texts)) {
      this.write(path, text);
    }
  }

  public delete(path: string): void {
    this.files.delete(path);
  }

  public list(): IndexedFileStat[] {
    return [...this.files.keys()].flatMap((path) => {
      const file = this.stat(path);
      return file ? [file] : [];
    });
  }

  public matching(term: string): string[] {
    const folded = foldText(term);
    return [...this.files].filter(([, file]) => foldText(file.text).includes(folded)).map(([path]) => path).sort();
  }

  public readonly read = async (file: IndexedFileStat): Promise<null | string> => {
    await noopAsync();
    this.reads.push(file.path);
    return this.files.get(file.path)?.text ?? null;
  };

  public rename(oldPath: string, newPath: string): void {
    const file = this.files.get(oldPath);
    if (!file) {
      return;
    }

    this.files.delete(oldPath);
    this.files.set(newPath, file);
  }

  public readonly stat = (path: string): IndexedFileStat | null => {
    const file = this.files.get(path);
    return file ? { mtime: file.mtime, path, size: file.text.length } : null;
  };

  public write(path: string, text: string): void {
    this.files.set(path, { mtime: this.clock++, text });
  }
}

// It replays the whole run once per write, which takes a few seconds on a loaded machine.
const KILL_TEST_TIMEOUT_IN_MILLISECONDS = 60_000;
const SMALL_SEGMENT: IndexOptions = { minCommonFiles: 1_000_000, readConcurrency: 2, segmentSize: 4, writeBatchSize: 3 };

async function candidatePaths(index: TrigramIndex, vault: FakeVault, term: string): Promise<string[]> {
  const files = await index.selectCandidates(vault.list(), literalQuery(term));
  return files.map((file) => file.path).sort();
}

async function openHarness(factory: IDBFactory, options: IndexOptions = SMALL_SEGMENT): Promise<Harness> {
  const filesStore = await LocalDataStore.open({ factory, pluginId: 'indexed-search', storeId: 'files', vaultId: 'vault' });
  const postingsStore = await LocalDataStore.open({ factory, pluginId: 'indexed-search', storeId: 'postings', vaultId: 'vault' });
  const logs: string[] = [];
  const index = new TrigramIndex({
    ...options,
    filesStore,
    log: (message): void => {
      logs.push(message);
    },
    postingsStore
  });
  await index.load();
  return { filesStore, index, logs, postingsStore };
}

function sampleVault(): FakeVault {
  return new FakeVault({
    'a.md': 'The quillwort grows by the harbour.',
    'b.md': 'Nothing to see.',
    'c.md': 'ЖУРАВЛИНА, still ЖУРАВЛИНА',
    'd.md': 'A silver harbour lantern.',
    'e.md': 'quillwort again, in a second segment',
    'f.md': 'журавлина',
    'g.md': 'xy',
    'h.md': 'another plain note'
  });
}

async function storedKeys(store: LocalDataStore): Promise<string[]> {
  const records = await store.entries();
  return records.map(([key]) => key);
}

describe('TrigramIndex', () => {
  it('narrows plain, infix and other-case terms to the files that contain them', async () => {
    const vault = sampleVault();
    const { index } = await openHarness(new IDBFactory());
    await index.sync(vault.list(), vault.read);
    expect(index.getIndexedFileCount()).toBe(8);
    for (const term of ['quillwort', 'llwor', 'harbour', 'журавлина', 'ЖУРАВЛИНА', 'missing']) {
      expect(await candidatePaths(index, vault, term)).toEqual(vault.matching(term));
    }
  });

  it('answers from disk after a restart, reading no file', async () => {
    const factory = new IDBFactory();
    const vault = sampleVault();
    const first = await openHarness(factory);
    await first.index.sync(vault.list(), vault.read);
    first.index.close();

    const second = await openHarness(factory);
    vault.reads.length = 0;
    await second.index.sync(vault.list(), vault.read);
    expect(vault.reads).toEqual([]);
    expect(await candidatePaths(second.index, vault, 'quillwort')).toEqual(['a.md', 'e.md']);
  });

  it('rechecks only the files whose mtime or size changed, and forgets the gone ones', async () => {
    const factory = new IDBFactory();
    const vault = sampleVault();
    const first = await openHarness(factory);
    await first.index.sync(vault.list(), vault.read);
    first.index.close();

    vault.write('b.md', 'now with quillwort');
    vault.delete('a.md');
    vault.write('z.md', 'a new quillwort note');
    const second = await openHarness(factory);
    vault.reads.length = 0;
    await second.index.sync(vault.list(), vault.read);
    expect(vault.reads.sort()).toEqual(['b.md', 'z.md']);
    expect(await candidatePaths(second.index, vault, 'quillwort')).toEqual(['b.md', 'e.md', 'z.md']);
    expect(second.index.getIndexedFileCount()).toBe(8);
  });

  it('keeps a changed file a candidate until its update lands, then narrows by its new text', async () => {
    const vault = sampleVault();
    const { index } = await openHarness(new IDBFactory());
    await index.sync(vault.list(), vault.read);

    vault.write('a.md', 'no longer about plants');
    expect(await candidatePaths(index, vault, 'quillwort')).toEqual(['a.md', 'e.md']);
    expect(await candidatePaths(index, vault, 'plants')).toEqual(['a.md']);
    const stat = vault.stat('a.md');
    expect(stat).not.toBeNull();
    await index.update(stat ? [stat] : [], vault.read);
    expect(await candidatePaths(index, vault, 'quillwort')).toEqual(['e.md']);
    expect(await candidatePaths(index, vault, 'plants')).toEqual(['a.md']);
  });

  it('moves a renamed file without reading it', async () => {
    const vault = sampleVault();
    const { index } = await openHarness(new IDBFactory());
    await index.sync(vault.list(), vault.read);

    vault.rename('a.md', 'folder/renamed.md');
    vault.reads.length = 0;
    await index.rename('a.md', 'folder/renamed.md');
    await index.rename('never-indexed.md', 'other.md');
    expect(vault.reads).toEqual([]);
    expect(await candidatePaths(index, vault, 'quillwort')).toEqual(['e.md', 'folder/renamed.md']);
  });

  it('forgets deleted files', async () => {
    const vault = sampleVault();
    const { index } = await openHarness(new IDBFactory());
    await index.sync(vault.list(), vault.read);
    vault.delete('a.md');
    await index.remove(['a.md', 'unknown.md']);
    expect(index.getIndexedFileCount()).toBe(7);
    expect(await candidatePaths(index, vault, 'quillwort')).toEqual(['e.md']);
  });

  it('skips a file that disappears before it is read', async () => {
    const vault = sampleVault();
    const { index } = await openHarness(new IDBFactory());
    const files = vault.list();
    vault.delete('b.md');
    await index.sync(files, vault.read);
    expect(index.getIndexedFileCount()).toBe(7);
  });

  it('combines trigram lists across segments for an AND query', async () => {
    const vault = sampleVault();
    const { index } = await openHarness(new IDBFactory());
    await index.sync(vault.list(), vault.read);
    const files = await index.selectCandidates(vault.list(), andQuery([literalQuery('quillwort'), literalQuery('segment')]));
    expect(files.map((file) => file.path)).toEqual(['e.md']);
  });

  it('stores trigrams found in almost every file as every file, never writing their lists after they are found', async () => {
    const texts: Record<string, string> = {};
    for (let index = 0; index < 12; index++) {
      texts[`note-${String(index)}.md`] = `common text ${String(index)}${index === 5 ? ' rare' : ''}`;
    }
    const vault = new FakeVault(texts);
    const { index, logs, postingsStore } = await openHarness(new IDBFactory(), { ...SMALL_SEGMENT, commonShare: 0.9, minCommonFiles: 4 });
    await index.sync(vault.list(), vault.read);

    const storedPostings = await postingsStore.entries();
    const keys = storedPostings.map(([key]) => key);
    expect(await index.candidates(literalQuery('common'))).toBeNull();
    expect(logs.at(-1)).toContain('scans every file');
    expect(await candidatePaths(index, vault, 'rare')).toEqual(['note-5.md']);
    // `com` is in every note, so no segment keeps a list for it.
    expect(keys.filter((key) => key.startsWith(`p:${packedTrigramKey('COM')}:`))).toEqual([]);
  });

  it('treats a damaged posting record as every file of its segment, then rebuilds that segment', async () => {
    const vault = sampleVault();
    const { index, logs, postingsStore } = await openHarness(new IDBFactory());
    await index.sync(vault.list(), vault.read);
    await postingsStore.set(`p:${packedTrigramKey('QUI')}:0`, new Uint8Array([0x80]));

    expect(await candidatePaths(index, vault, 'quillwort')).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'e.md']);
    await index.idle();
    expect(logs.some((line) => line.includes('is damaged'))).toBe(true);
    await index.maintain(vault.read, vault.stat);
    expect(await candidatePaths(index, vault, 'quillwort')).toEqual(['a.md', 'e.md']);
  });

  it('treats a missing segment trigram list as every file of its segment after a restart', async () => {
    const factory = new IDBFactory();
    const vault = sampleVault();
    const first = await openHarness(factory);
    await first.index.sync(vault.list(), vault.read);
    await first.postingsStore.delete('t:1');
    first.index.close();

    const second = await openHarness(factory);
    expect(second.logs.some((line) => line.includes('segment 1'))).toBe(true);
    expect(await candidatePaths(second.index, vault, 'quillwort')).toEqual(['a.md', 'e.md', 'f.md', 'g.md', 'h.md']);
    await second.index.maintain(vault.read, vault.stat);
    expect(await candidatePaths(second.index, vault, 'quillwort')).toEqual(['a.md', 'e.md']);
  });

  it('drops a damaged file record and indexes its file again', async () => {
    const factory = new IDBFactory();
    const vault = sampleVault();
    const first = await openHarness(factory);
    await first.index.sync(vault.list(), vault.read);
    await first.filesStore.set('f:a.md', { id: 'broken' });
    await first.filesStore.set('stray', 1);
    first.index.close();

    const second = await openHarness(factory);
    expect(second.index.getIndexedFileCount()).toBe(7);
    vault.reads.length = 0;
    await second.index.sync(vault.list(), vault.read);
    expect(vault.reads).toEqual(['a.md']);
    expect(await candidatePaths(second.index, vault, 'quillwort')).toEqual(['a.md', 'e.md']);
  });

  it('clears the whole index when its metadata is damaged', async () => {
    const factory = new IDBFactory();
    const vault = sampleVault();
    const first = await openHarness(factory);
    await first.index.sync(vault.list(), vault.read);
    await first.filesStore.set('meta', { version: 99 });
    first.index.close();

    const second = await openHarness(factory);
    expect(second.index.getIndexedFileCount()).toBe(0);
    expect(second.logs.some((line) => line.includes('rebuilding the index'))).toBe(true);
    expect(await second.postingsStore.entries()).toEqual([]);
  });

  it('rebuilds a segment most of whose ids are dead, and then leaves it alone', async () => {
    const vault = sampleVault();
    const { index, logs } = await openHarness(new IDBFactory());
    await index.sync(vault.list(), vault.read);
    vault.write('a.md', 'rewritten once');
    vault.write('b.md', 'rewritten twice');
    await index.sync(vault.list(), vault.read);

    await index.maintain(vault.read, vault.stat);
    const rebuilt = logs.filter((line) => line.startsWith('Rebuilt segment 0'));
    expect(rebuilt).toHaveLength(1);
    await index.maintain(vault.read, vault.stat);
    expect(logs.filter((line) => line.startsWith('Rebuilt segment 0'))).toHaveLength(1);
    expect(await candidatePaths(index, vault, 'rewritten')).toEqual(['a.md', 'b.md']);
    expect(await candidatePaths(index, vault, 'quillwort')).toEqual(['e.md']);
  });

  it('indexes again, under a new id, a file that changed while its segment was rebuilt', async () => {
    const vault = sampleVault();
    const { index } = await openHarness(new IDBFactory());
    await index.sync(vault.list(), vault.read);
    vault.write('a.md', 'moved on from quillwort');
    vault.write('b.md', 'quillwort here now');
    await index.update([vault.stat('a.md'), vault.stat('b.md')].flatMap((file) => (file ? [file] : [])), vault.read);
    vault.write('c.md', 'changed under the rebuild');
    await index.maintain(vault.read, vault.stat);
    expect(await candidatePaths(index, vault, 'rebuild')).toEqual(['c.md']);
    const c = vault.stat('c.md');
    expect(c && index.isIndexed(c)).toBe(true);
  });

  it('keeps file records packed per segment, with renames, removals and updates kept in the journal between folds', async () => {
    const factory = new IDBFactory();
    const vault = sampleVault();
    const options: IndexOptions = { ...SMALL_SEGMENT, journalLimit: 2 };
    const first = await openHarness(factory, options);
    await first.index.sync(vault.list(), vault.read);
    vault.write('a.md', 'no longer about plants');
    vault.rename('e.md', 'moved/e.md');
    vault.delete('b.md');
    await first.index.sync(vault.list(), vault.read);
    await first.index.rename('e.md', 'moved/e.md');
    const keys = await storedKeys(first.filesStore);
    expect(keys.filter((key) => key.startsWith('s:'))).toEqual(['s:0', 's:1', 's:2']);
    expect(keys.filter((key) => key.startsWith('f:')).length).toBeLessThanOrEqual(2);
    first.index.close();

    const second = await openHarness(factory, options);
    vault.reads.length = 0;
    await second.index.sync(vault.list(), vault.read);
    expect(vault.reads).toEqual([]);
    expect(second.index.getIndexedFileCount()).toBe(7);
    expect(await candidatePaths(second.index, vault, 'quillwort')).toEqual(['moved/e.md']);
    expect(await candidatePaths(second.index, vault, 'plants')).toEqual(['a.md']);
  });

  it('folds a journal past its limit when it loads', async () => {
    const factory = new IDBFactory();
    const vault = sampleVault();
    const first = await openHarness(factory);
    await first.index.sync(vault.list(), vault.read);
    const keys = await storedKeys(first.filesStore);
    expect(keys.filter((key) => key.startsWith('f:'))).toHaveLength(8);
    first.index.close();

    const second = await openHarness(factory, { ...SMALL_SEGMENT, journalLimit: 2 });
    expect(await storedKeys(second.filesStore)).toEqual(['meta', 's:0', 's:1']);
    vault.reads.length = 0;
    await second.index.sync(vault.list(), vault.read);
    expect(vault.reads).toEqual([]);
    expect(await candidatePaths(second.index, vault, 'quillwort')).toEqual(['a.md', 'e.md']);
  });

  it('drops a damaged segment file record and indexes its files again', async () => {
    const factory = new IDBFactory();
    const vault = sampleVault();
    const options: IndexOptions = { ...SMALL_SEGMENT, journalLimit: 0 };
    const first = await openHarness(factory, options);
    await first.index.sync(vault.list(), vault.read);
    await first.filesStore.set('s:0', { ids: new Float64Array([1, 0]), mtimes: new Float64Array(2), paths: ['a.md', 'b.md'], sizes: new Float64Array(2) });
    first.index.close();

    const second = await openHarness(factory, options);
    expect(second.logs.some((line) => line.includes('record s:0'))).toBe(true);
    expect(second.index.getIndexedFileCount()).toBe(4);
    vault.reads.length = 0;
    await second.index.sync(vault.list(), vault.read);
    expect(vault.reads.sort()).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
    expect(await candidatePaths(second.index, vault, 'quillwort')).toEqual(['a.md', 'e.md']);
    second.index.close();

    const third = await openHarness(factory, options);
    expect(third.logs).toEqual([]);
    expect(third.index.getIndexedFileCount()).toBe(8);
  });

  it.each([
    { name: 'in the journal', options: SMALL_SEGMENT },
    { name: 'folded into segments', options: { ...SMALL_SEGMENT, journalLimit: 1 } }
  ])('never misses a match, whichever write a kill interrupts (file records $name)', async ({ options }) => {
    const terms = ['quillwort', 'harbour', 'журавлина', 'again', 'note'];
    let writeCount = Infinity;
    for (let budget = 0; budget < writeCount; budget++) {
      const factory = new IDBFactory();
      const vault = sampleVault();
      const crashing = await openHarness(factory, options);
      const writes = killAfterWrites([crashing.filesStore, crashing.postingsStore], budget);
      await crashing.index.sync(vault.list(), vault.read).catch(() => undefined);
      vault.write('a.md', 'an update with no plants');
      const stat = vault.stat('a.md');
      await crashing.index.update(stat ? [stat] : [], vault.read).catch(() => undefined);
      vault.rename('d.md', 'renamed.md');
      await crashing.index.rename('d.md', 'renamed.md').catch(() => undefined);
      vault.delete('b.md');
      await crashing.index.remove(['b.md']).catch(() => undefined);
      if (writes.getCount() <= budget) {
        writeCount = writes.getCount();
      }
      crashing.index.close();

      const restarted = await openHarness(factory, options);
      for (const term of terms) {
        expect(await candidatePaths(restarted.index, vault, term)).toEqual(expect.arrayContaining(vault.matching(term)));
      }
      await restarted.index.sync(vault.list(), vault.read);
      await restarted.index.maintain(vault.read, vault.stat);
      for (const term of terms) {
        expect(await candidatePaths(restarted.index, vault, term)).toEqual(expect.arrayContaining(vault.matching(term)));
      }
      restarted.index.close();
    }
    expect(writeCount).toBeGreaterThan(10);
  }, KILL_TEST_TIMEOUT_IN_MILLISECONDS);
});

/**
 * Counts writes, and makes every one after the first `budget` throw, as a kill would stop them.
 */
class WriteBudget {
  private count = 0;

  public constructor(private readonly budget: number) {}

  public getCount(): number {
    return this.count;
  }

  public spend(): void {
    if (this.count++ >= this.budget) {
      throw new Error('killed');
    }
  }
}

/**
 * Makes every write after the first `budget` ones throw, as a kill would stop them, and counts them all.
 *
 * @param stores - The stores to cut off.
 * @param budget - How many writes still land.
 * @returns The budget, which counts the attempted writes.
 */
function killAfterWrites(stores: readonly LocalDataStore[], budget: number): WriteBudget {
  const writeBudget = new WriteBudget(budget);
  for (const store of stores) {
    for (const method of ['commit', 'delete', 'set'] as const) {
      const original = store[method].bind(store) as (...arguments_: unknown[]) => Promise<void>;
      vi.spyOn(store, method).mockImplementation(async (...arguments_: unknown[]) => {
        writeBudget.spend();
        await original(...arguments_);
      });
    }
  }
  return writeBudget;
}

function packedTrigramKey(text: string): string {
  const [first = 0, second = 0, third = 0] = Array.from({ length: 3 }, (_, index) => text.codePointAt(index) ?? 0);
  return packTrigram(first, second, third).toString(36);
}
