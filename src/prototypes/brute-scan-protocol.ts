/**
 * @file
 *
 * Messages between the brute-scan engine and its workers.
 */

/**
 * Finds the files whose folded text contains a folded UTF-8 literal.
 */
export interface LiteralRequest {
  readonly kind: 'literal';
  readonly pattern: Uint8Array;
}

/**
 * Hands a worker its share of the corpus. The buffers are transferred, so the main thread keeps none of them.
 */
export interface LoadRequest {
  /**
   * Folded UTF-8 text of every file of the share, back to back.
   */
  readonly bytes: Uint8Array;
  /**
   * The global id of each file of the share.
   */
  readonly ids: Uint32Array;
  readonly kind: 'load';
  /**
   * Where each file starts in `bytes`, plus one final entry for the end.
   */
  readonly offsets: Uint32Array;
}

/**
 * Finds the files a regex matches with `i`, over folded text.
 */
export interface RegexRequest {
  readonly kind: 'regex';
  readonly source: string;
}

/**
 * Any request to a worker.
 */
export type ScanRequest = LiteralRequest | LoadRequest | RegexRequest;

/**
 * A worker's answer: the ids of its matching files, ascending, or an empty array for `load`.
 */
export interface ScanResponse {
  readonly error?: string;
  readonly ids: Uint32Array;
}
