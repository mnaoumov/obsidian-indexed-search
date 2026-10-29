/**
 * @file
 *
 * Keeps the vault's trigram index current while the plugin is loaded.
 *
 * At layout ready it opens the index, rechecks it against the vault's Markdown files by mtime and size, and
 * rebuilds whatever is damaged or mostly dead. From then on every create, modify, delete and rename reaches it. A
 * changed file stays a candidate from the moment its stats change, because the index vouches only for a file
 * whose stats match its record, so a query never waits for an update to land.
 */

import type { App } from 'obsidian';

import { LayoutReadyComponent } from '@mnaoumov/obsidian-lib/components/layout-ready-component';
import { LocalDataStore } from '@mnaoumov/obsidian-lib/data-stores/local-data-store';
import { isMarkdownFile } from '@mnaoumov/obsidian-lib/file-system';
import { invokeAsyncSafely } from '@mnaoumov/typescript-lib/async';
import { getDebugger } from '@mnaoumov/typescript-lib/debug';
import { noop } from '@mnaoumov/typescript-lib/function';
import {
  debounce,
  TAbstractFile,
  TFile
} from 'obsidian';

import type {
  IndexedFileStat,
  TrigramIndexConstructorParams
} from './trigram-index.ts';
import type { TrigramQuery } from './trigram-query.ts';

import { TrigramIndex } from './trigram-index.ts';

/**
 * What the index component needs.
 */
export interface TrigramIndexComponentConstructorParams {
  /**
   * The application owning the vault.
   */
  readonly app: App;
  /**
   * Overrides of the index's build settings, for tests.
   */
  readonly indexOptions?: Omit<TrigramIndexConstructorParams, 'filesStore' | 'log' | 'postingsStore'>;
  /**
   * The plugin's manifest id, which isolates its stores.
   */
  readonly pluginId: string;
}

const STORE_SCHEMA = 'v1';
const UPDATE_DELAY_IN_MILLISECONDS = 500;

/**
 * Owns the trigram index of one vault.
 */
export class TrigramIndexComponent extends LayoutReadyComponent {
  private index: null | TrigramIndex = null;
  private readonly indexOptions: TrigramIndexComponentConstructorParams['indexOptions'];
  private isReady = false;
  private readonly log = getDebugger('indexed-search:TrigramIndex');
  private readonly pendingPaths = new Set<string>();
  private readonly pluginId: string;
  private readonly readyPromise: Promise<void>;
  private readonly requestUpdate = debounce(
    () => {
      invokeAsyncSafely(async () => this.updatePending());
    },
    UPDATE_DELAY_IN_MILLISECONDS,
    true
  );

  private resolveReady: () => void = noop;

  /**
   * Creates the component; the index opens at layout ready.
   *
   * @param params - The app and the plugin id.
   */
  public constructor(params: TrigramIndexComponentConstructorParams) {
    super(params.app);
    this.indexOptions = params.indexOptions;
    this.pluginId = params.pluginId;
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  /**
   * Returns how many files the index holds records for.
   *
   * @returns The count, or 0 before the index is open.
   */
  public getIndexedFileCount(): number {
    return this.index?.getIndexedFileCount() ?? 0;
  }

  /**
   * Closes the index. Writes still queued are dropped; the next start rechecks what they would have written.
   */
  public override onunload(): void {
    this.requestUpdate.cancel();
    this.index?.close();
    this.index = null;
    this.resolveReady();
    super.onunload();
  }

  /**
   * Returns the files a query may match: every file the index cannot vouch for, and every indexed one whose
   * postings it does not rule out. Before the index is ready, that is every file.
   *
   * @param files - The files to choose from.
   * @param query - The trigram query of the search's content terms.
   * @returns The candidates, in the order given.
   */
  public async selectCandidates(files: readonly TFile[], query: TrigramQuery): Promise<TFile[]> {
    const index = this.index;
    if (!index || !this.isReady) {
      return [...files];
    }
    const paths = await index.candidates(query);
    return paths === null ? [...files] : files.filter((file) => !isMarkdownFile(file) || !index.isIndexed(toIndexedFileStat(file)) || paths.has(file.path));
  }

  /**
   * Waits until the index is open and caught up with the vault, and has written every change seen so far.
   *
   * @returns A promise that settles once nothing is left to write.
   */
  public async whenIdle(): Promise<void> {
    await this.readyPromise;
    this.requestUpdate.cancel();
    await this.updatePending();
    await this.index?.idle();
  }

  /**
   * Opens the index, rechecks it against the vault and starts following its changes.
   */
  protected override async onLayoutReady(): Promise<void> {
    this.registerEvent(this.app.vault.on('create', this.handleChange.bind(this)));
    this.registerEvent(this.app.vault.on('modify', this.handleChange.bind(this)));
    this.registerEvent(this.app.vault.on('delete', this.handleDelete.bind(this)));
    this.registerEvent(this.app.vault.on('rename', this.handleRename.bind(this)));

    const storeParams = { pluginId: this.pluginId, vaultId: this.app.appId };
    const filesStore = await LocalDataStore.open({ ...storeParams, storeId: `trigram-files-${STORE_SCHEMA}` });
    const postingsStore = await LocalDataStore.open({ ...storeParams, storeId: `trigram-postings-${STORE_SCHEMA}` });
    if (this.isUnloaded()) {
      filesStore.close();
      postingsStore.close();
      return;
    }
    const index = new TrigramIndex({
      ...this.indexOptions,
      filesStore,
      log: (message): void => {
        this.log(message);
      },
      postingsStore
    });
    this.index = index;
    await this.runIndexOperation(async () => {
      await index.load();
      // The sync reads the vault as it is now, so it covers every change seen before it.
      this.pendingPaths.clear();
      await index.sync(this.getMarkdownFiles(), this.readFile.bind(this));
      this.isReady = true;
      this.resolveReady();
      this.requestUpdate();
      await index.maintain(this.readFile.bind(this), this.statFile.bind(this));
    });
  }

  private getMarkdownFiles(): IndexedFileStat[] {
    return this.app.vault.getMarkdownFiles().map((file) => toIndexedFileStat(file));
  }

  private handleChange(file: TAbstractFile): void {
    if (!(file instanceof TFile && isMarkdownFile(file))) {
      return;
    }

    this.pendingPaths.add(file.path);
    this.requestUpdate();
  }

  private handleDelete(file: TAbstractFile): void {
    this.pendingPaths.delete(file.path);
    if (this.index && file instanceof TFile) {
      this.runIndexOperationSafely(async (index) => index.remove([file.path]));
    }
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile)) {
      return;
    }
    if (this.pendingPaths.delete(oldPath)) {
      this.pendingPaths.add(file.path);
    }
    if (!this.index) {
      return;
    }
    if (isMarkdownFile(file)) {
      this.runIndexOperationSafely(async (index) => index.rename(oldPath, file.path));
      // A rename can also change the file, as an external move-and-edit does; its stats tell.
      this.handleChange(file);
    } else {
      this.runIndexOperationSafely(async (index) => index.remove([oldPath]));
    }
  }

  private async readFile(file: IndexedFileStat): Promise<null | string> {
    const vaultFile = this.app.vault.getFileByPath(file.path);
    if (!vaultFile) {
      return null;
    }
    try {
      return await this.app.vault.cachedRead(vaultFile);
    } catch {
      return null;
    }
  }

  /**
   * Runs an index operation, letting a failure that only says the plugin unloaded under it pass silently: the
   * closed stores refuse the write, and the next start rechecks whatever it would have written.
   *
   * @param operation - The operation.
   * @returns A promise that settles with the operation.
   */
  private async runIndexOperation(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (!this.isUnloaded()) {
        throw error;
      }
    }
  }

  private runIndexOperationSafely(operation: (index: TrigramIndex) => Promise<void>): void {
    const index = this.index;
    if (index) {
      invokeAsyncSafely(async () => this.runIndexOperation(async () => operation(index)));
    }
  }

  private statFile(path: string): IndexedFileStat | null {
    const file = this.app.vault.getFileByPath(path);
    return file ? toIndexedFileStat(file) : null;
  }

  private async updatePending(): Promise<void> {
    const index = this.index;
    if (!index || !this.isReady || this.pendingPaths.size === 0) {
      return;
    }
    const files = [...this.pendingPaths].flatMap((path) => {
      const file = this.statFile(path);
      return file ? [file] : [];
    });
    this.pendingPaths.clear();
    await this.runIndexOperation(async () => index.update(files, this.readFile.bind(this)));
  }
}

function toIndexedFileStat(file: TFile): IndexedFileStat {
  return { mtime: file.stat.mtime, path: file.path, size: file.stat.size };
}
