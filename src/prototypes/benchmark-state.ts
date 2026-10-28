/**
 * @file
 *
 * What the engine benchmark keeps in the renderer between its steps.
 */

import type { BruteScanEngine } from './brute-scan-engine.ts';
import type {
  IndexedFile,
  TrigramIndexEngine
} from './trigram-index-engine.ts';

/**
 * The benchmark's state across callbacks.
 */
export class BenchmarkState {
  private bruteScan: BruteScanEngine | null = null;
  private readonly coreResults = new Map<string, string[]>();
  private files: IndexedFile[] = [];
  private trigramIndex: null | TrigramIndexEngine = null;

  /**
   * Returns the built brute-scan engine.
   *
   * @returns The engine.
   */
  public getBruteScan(): BruteScanEngine {
    if (!this.bruteScan) {
      throw new Error('Brute scan not built');
    }
    return this.bruteScan;
  }

  /**
   * Returns core Search's result paths for a query label.
   *
   * @param label - The query label.
   * @returns The paths, or an empty list before the baseline ran.
   */
  public getCoreResult(label: string): string[] {
    return this.coreResults.get(label) ?? [];
  }

  /**
   * Returns the benchmark's files, in id order.
   *
   * @returns The files.
   */
  public getFiles(): IndexedFile[] {
    return this.files;
  }

  /**
   * Returns the built trigram index.
   *
   * @returns The engine.
   */
  public getTrigramIndex(): TrigramIndexEngine {
    if (!this.trigramIndex) {
      throw new Error('Trigram index not built');
    }
    return this.trigramIndex;
  }

  /**
   * Stores or clears the brute-scan engine.
   *
   * @param engine - The engine, or `null`.
   */
  public setBruteScan(engine: BruteScanEngine | null): void {
    this.bruteScan = engine;
  }

  /**
   * Stores core Search's result paths for a query label.
   *
   * @param label - The query label.
   * @param paths - The paths.
   */
  public setCoreResult(label: string, paths: string[]): void {
    this.coreResults.set(label, paths);
  }

  /**
   * Stores the benchmark's files.
   *
   * @param files - The files, in id order.
   */
  public setFiles(files: IndexedFile[]): void {
    this.files = files;
  }

  /**
   * Stores or clears the trigram index.
   *
   * @param engine - The engine, or `null`.
   */
  public setTrigramIndex(engine: null | TrigramIndexEngine): void {
    this.trigramIndex = engine;
  }
}
