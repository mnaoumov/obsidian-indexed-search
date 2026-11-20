/**
 * @file
 *
 * The API the brute-scan workers expose to the engine, through `@mnaoumov/obsidian-lib`'s worker protocol.
 */

/**
 * One worker's share of the corpus. The buffers are transferred, so the main thread keeps none of them.
 */
export interface BruteScanShare {
  /**
   * Folded UTF-8 text of every file of the share, back to back.
   */
  readonly bytes: Uint8Array;
  /**
   * The global id of each file of the share.
   */
  readonly ids: Uint32Array;
  /**
   * Where each file starts in `bytes`, plus one final entry for the end.
   */
  readonly offsets: Uint32Array;
}

/**
 * What each brute-scan worker exposes. Both finders answer the global ids of the share's matching files, ascending.
 */
export interface BruteScanWorkerApi {
  /**
   * Finds the files whose folded text contains a folded UTF-8 literal.
   */
  readonly findLiteral: (pattern: Uint8Array) => Uint32Array;
  /**
   * Finds the files a regex matches with `i`, over folded text.
   */
  readonly findRegex: (source: string) => Uint32Array;
  /**
   * Hands the worker its share of the corpus.
   */
  readonly load: (share: BruteScanShare) => void;
}
