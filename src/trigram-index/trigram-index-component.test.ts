import type {
  TFile,
  Vault
} from 'obsidian';

import { LocalDataStore } from '@mnaoumov/obsidian-lib/data-stores/local-data-store';
import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';
import { IDBFactory } from 'fake-indexeddb';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import { TrigramIndexComponent } from './trigram-index-component.ts';
import { TrigramIndex } from './trigram-index.ts';
import { literalQuery } from './trigram-query.ts';

// Longer than the component's 500 ms update debounce.
const DEBOUNCE_WAIT_IN_MILLISECONDS = 3000;

describe('TrigramIndexComponent', () => {
  let app: App;
  let component: TrigramIndexComponent;
  let vault: Vault;

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    app = App.createConfigured__();
    vault = app.asOriginalType__().vault;
    component = new TrigramIndexComponent({
      app: app.asOriginalType__(),
      indexOptions: { minCommonFiles: 1_000_000, segmentSize: 4 },
      pluginId: 'indexed-search'
    });
  });

  afterEach(() => {
    component.unload();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function file(path: string): TFile {
    return ensureNonNullable(vault.getFileByPath(path), `No file ${path}`);
  }

  async function quillwortCandidates(): Promise<null | string[]> {
    const paths = await component.getContentCandidates(literalQuery('quillwort'));
    return paths ? [...paths].sort() : null;
  }

  async function startReady(): Promise<void> {
    component.load();
    app.workspace.setLayoutReady__();
    await component.whenIdle();
  }

  it('narrows nothing and vouches for nothing before the layout is ready', async () => {
    app.vault.createSync__('a.md', 'quillwort');
    component.load();

    expect(await quillwortCandidates()).toBeNull();
    expect(component.getIndexedFileCount()).toBe(0);
    expect(component.isVouched(file('a.md'))).toBe(false);
    const candidates = await component.selectCandidates([file('a.md')], literalQuery('lantern'));
    expect(candidates.map((f) => f.path)).toEqual(['a.md']);
  });

  it('indexes the vault\'s notes at layout ready and answers from them', async () => {
    app.vault.createSync__('a.md', 'a quillwort patch');
    app.vault.createSync__('b.md', 'the silver lantern');
    app.vault.createSync__('c.txt', 'quillwort in a text file');

    await startReady();

    expect(component.getIndexedFileCount()).toBe(2);
    expect(await quillwortCandidates()).toEqual(['a.md']);
    expect(component.isVouched(file('a.md'))).toBe(true);
    expect(component.isVouched(file('c.txt'))).toBe(false);
  });

  it('selects every file it cannot vouch for, and the indexed notes the postings do not rule out', async () => {
    app.vault.createSync__('a.md', 'a quillwort patch');
    app.vault.createSync__('b.md', 'the silver lantern');
    app.vault.createSync__('c.md', 'nothing at all');
    app.vault.createSync__('d.txt', 'not a note');
    await startReady();
    // Changed after indexing: its stats no longer match the record, so the index cannot rule it out.
    await vault.modify(file('c.md'), 'nothing at all, still');

    const files = ['a.md', 'b.md', 'c.md', 'd.txt'].map((path) => file(path));
    const narrowed = await component.selectCandidates(files, literalQuery('quillwort'));
    expect(narrowed.map((f) => f.path)).toEqual(['a.md', 'c.md', 'd.txt']);
    const everyFile = await component.selectCandidates(files, { kind: 'all' });
    expect(everyFile.map((f) => f.path)).toEqual(['a.md', 'b.md', 'c.md', 'd.txt']);
  });

  it('follows created, modified, deleted and renamed notes', async () => {
    app.vault.createSync__('a.md', 'a quillwort patch');
    app.vault.createSync__('b.md', 'the silver lantern');
    await startReady();

    await vault.create('new.md', 'quillwort again');
    await vault.modify(file('b.md'), 'quillwort by the lantern');
    await component.whenIdle();
    expect(await quillwortCandidates()).toEqual(['a.md', 'b.md', 'new.md']);

    await app.asOriginalType__().fileManager.trashFile(file('a.md'));
    await vault.rename(file('new.md'), 'moved.md');
    await component.whenIdle();
    expect(await quillwortCandidates()).toEqual(['b.md', 'moved.md']);
    expect(component.isVouched(file('moved.md'))).toBe(true);
  });

  it('forgets a note renamed to a file type it does not index, and ignores non-notes and folders', async () => {
    app.vault.createSync__('a.md', 'a quillwort patch');
    app.vault.createFolderSync__('folder');
    app.vault.createFolderSync__('other');
    await startReady();

    await vault.create('c.txt', 'quillwort in text');
    await vault.rename(file('a.md'), 'a.txt');
    await vault.rename(ensureNonNullable(vault.getFolderByPath('folder')), 'renamed');
    await app.asOriginalType__().fileManager.trashFile(ensureNonNullable(vault.getFolderByPath('other')));
    await component.whenIdle();

    expect(await quillwortCandidates()).toEqual([]);
    expect(component.getIndexedFileCount()).toBe(0);
  });

  it('carries a pending change over a rename, and drops a pending note that is gone', async () => {
    app.vault.createSync__('a.md', 'a silver patch');
    app.vault.createSync__('b.md', 'the silver lantern');
    await startReady();

    await vault.modify(file('a.md'), 'a quillwort patch');
    await vault.rename(file('a.md'), 'renamed.md');
    await vault.modify(file('b.md'), 'quillwort by the lantern');
    // Gone with no event: the pending path no longer names a file.
    app.vault.deleteVaultAbstractFile__('b.md');
    await component.whenIdle();

    expect(await quillwortCandidates()).toEqual(['renamed.md']);
  });

  it('writes a change once the update debounce fires', async () => {
    app.vault.createSync__('a.md', 'a silver patch');
    await startReady();

    await vault.modify(file('a.md'), 'a quillwort patch');

    await vi.waitFor(async () => {
      expect(await quillwortCandidates()).toEqual(['a.md']);
    }, { timeout: DEBOUNCE_WAIT_IN_MILLISECONDS });
  });

  it('indexes a note it cannot read, or that is gone when read, as empty', async () => {
    app.vault.createSync__('a.md', 'a quillwort patch');
    app.vault.createSync__('b.md', 'quillwort too');
    vi.spyOn(app.vault, 'cachedRead').mockRejectedValue(new Error('read failed'));
    const getFileByPath = app.vault.getFileByPath.bind(app.vault);
    vi.spyOn(app.vault, 'getFileByPath').mockImplementation((path) => path === 'b.md' ? null : getFileByPath(path));

    await startReady();

    expect(await quillwortCandidates()).toEqual([]);
  });

  it('closes its stores when unloaded before they open', async () => {
    const close = vi.spyOn(LocalDataStore.prototype, 'close');
    const load = vi.spyOn(TrigramIndex.prototype, 'load');
    const open = LocalDataStore.open.bind(LocalDataStore);
    vi.spyOn(LocalDataStore, 'open').mockImplementation(async (params) => {
      const store = await open(params);
      component.unload();
      return store;
    });
    component.load();
    app.workspace.setLayoutReady__();
    await component.whenIdle();

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(2);
    });
    expect(load).not.toHaveBeenCalled();
    expect(component.getIndexedFileCount()).toBe(0);
  });

  it('leaves a deletion seen before the index opens to the initial sync', async () => {
    app.vault.createSync__('a.md', 'a quillwort patch');
    app.vault.createSync__('b.md', 'quillwort too');
    const open = LocalDataStore.open.bind(LocalDataStore);
    const remove = vi.spyOn(TrigramIndex.prototype, 'remove');
    vi.spyOn(LocalDataStore, 'open').mockImplementationOnce(async (params) => {
      await app.asOriginalType__().fileManager.trashFile(file('b.md'));
      return open(params);
    });

    await startReady();

    expect(remove).not.toHaveBeenCalled();
    expect(await quillwortCandidates()).toEqual(['a.md']);
  });

  it('lets an index operation the unload cut short fail silently', async () => {
    app.vault.createSync__('a.md', 'a quillwort patch');
    const sync = vi.spyOn(TrigramIndex.prototype, 'sync').mockImplementation(() => {
      component.unload();
      return Promise.reject(new Error('store closed'));
    });
    component.load();
    app.workspace.setLayoutReady__();
    await component.whenIdle();

    expect(sync).toHaveBeenCalledOnce();
    expect(component.isVouched(file('a.md'))).toBe(false);
  });

  it('passes on an index operation that fails while loaded', async () => {
    app.vault.createSync__('a.md', 'a silver patch');
    await startReady();
    vi.spyOn(TrigramIndex.prototype, 'update').mockRejectedValue(new Error('update failed'));

    await vault.modify(file('a.md'), 'a quillwort patch');

    await expect(component.whenIdle()).rejects.toThrow('update failed');
  });
});
