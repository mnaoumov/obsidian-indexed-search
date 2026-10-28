/**
 * @file
 *
 * Prototype 2: every note's folded text as UTF-8 in memory, brute-scanned per query in workers.
 *
 * The main thread reads and folds every file, encodes it into one buffer per worker, sized by the files'
 * on-disk byte counts, and transfers each buffer to its worker, so the corpus lives once, outside the main
 * heap. A literal is a Boyer-Moore-Horspool byte search; a regex decodes each file and runs with `i`. Nothing
 * is persisted: every start rebuilds the buffers from the files.
 */

/* eslint-disable n/no-unsupported-features/node-builtins -- `Worker` and object URLs are Web APIs of the renderer, not Node builtins. */

import type {
  ScanRequest,
  ScanResponse
} from './brute-scan-protocol.ts';
import type {
  IndexedFile,
  ReadFile
} from './trigram-index-engine.ts';

import { foldText } from './case-folding.ts';
import { unite } from './postings.ts';

/**
 * What a build reports.
 */
export interface BruteScanBuildStats {
  readonly bufferBytes: number;
  readonly workerCount: number;
}

/**
 * Options of the brute-scan prototype.
 */
export interface BruteScanEngineConstructorParams {
  /**
   * Files read at once while building.
   */
  readonly readBatchSize: number;
  readonly workerCount: number;
  /**
   * The bundled source of the worker.
   */
  readonly workerSource: string;
}

/**
 * A literal the brute scan looks for.
 */
export interface BruteScanLiteralTerm {
  readonly kind: 'literal';
  readonly text: string;
}

/**
 * A regex the brute scan runs.
 */
export interface BruteScanRegexTerm {
  readonly kind: 'regex';
  readonly source: string;
}

/**
 * A term the brute scan can look for.
 */
export type BruteScanTerm = BruteScanLiteralTerm | BruteScanRegexTerm;

interface EncodedShare {
  readonly bytes: Uint8Array;
  readonly offsets: Uint32Array;
}

interface Share {
  readonly files: readonly IndexedFile[];
  readonly size: number;
  readonly start: number;
}

const GROWTH_FACTOR = 2;
const MINIMUM_SHARE_BYTES = 1024;
const SHARE_SLACK = 1.05;

/**
 * The brute-scan prototype.
 */
export class BruteScanEngine {
  private readonly encoder = new TextEncoder();
  private readonly readBatchSize: number;
  private readonly workerCount: number;
  private workers: Worker[] = [];
  private readonly workerSource: string;
  private workerUrl: null | string = null;

  public constructor(params: BruteScanEngineConstructorParams) {
    this.readBatchSize = params.readBatchSize;
    this.workerCount = params.workerCount;
    this.workerSource = params.workerSource;
  }

  /**
   * Reads every file and hands each worker its share.
   *
   * @param files - The files, in id order.
   * @param read - Reads one file's text.
   * @returns What was built.
   */
  public async build(files: readonly IndexedFile[], read: ReadFile): Promise<BruteScanBuildStats> {
    this.terminate();
    const workerUrl = URL.createObjectURL(new Blob([this.workerSource], { type: 'text/javascript' }));
    this.workerUrl = workerUrl;
    let bufferBytes = 0;
    for (const share of splitIntoShares(files, this.workerCount)) {
      const { bytes, offsets } = await this.encodeShare(share, read);
      bufferBytes += bytes.length;
      const ids = Uint32Array.from(share.files, (_file, index) => share.start + index);
      const worker = new Worker(workerUrl);
      this.workers.push(worker);
      await this.request(worker, { bytes, ids, kind: 'load', offsets }, [bytes.buffer, offsets.buffer, ids.buffer]);
    }
    return { bufferBytes, workerCount: this.workers.length };
  }

  /**
   * Returns the ids of the files whose folded text contains the term.
   *
   * @param term - The literal or regex.
   * @returns The candidate ids, ascending.
   */
  public async candidates(term: BruteScanTerm): Promise<Uint32Array> {
    const request: ScanRequest = term.kind === 'literal'
      ? { kind: 'literal', pattern: this.encoder.encode(foldText(term.text)) }
      : { kind: 'regex', source: term.source };
    const answers = await Promise.all(this.workers.map(async (worker) => this.request(worker, request, [])));
    let result: Uint32Array = new Uint32Array(0);
    for (const answer of answers) {
      result = unite(result, answer);
    }
    return result;
  }

  /**
   * Stops the workers, releasing the corpus.
   */
  public terminate(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    if (!this.workerUrl) {
      return;
    }

    URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
  }

  private async encodeShare(share: Share, read: ReadFile): Promise<EncodedShare> {
    let bytes = new Uint8Array(Math.ceil(share.size * SHARE_SLACK) + MINIMUM_SHARE_BYTES);
    const offsets = new Uint32Array(share.files.length + 1);
    let position = 0;
    for (let batchStart = 0; batchStart < share.files.length; batchStart += this.readBatchSize) {
      const batch = share.files.slice(batchStart, batchStart + this.readBatchSize);
      const texts = await Promise.all(batch.map(async (file) => read(file.path)));
      for (const [index, text] of texts.entries()) {
        offsets[batchStart + index] = position;
        const folded = foldText(text);
        let result = this.encoder.encodeInto(folded, bytes.subarray(position));
        while (result.read < folded.length) {
          const grown = new Uint8Array(bytes.length * GROWTH_FACTOR);
          grown.set(bytes.subarray(0, position));
          bytes = grown;
          result = this.encoder.encodeInto(folded, bytes.subarray(position));
        }
        position += result.written;
      }
    }
    offsets[share.files.length] = position;
    return { bytes: bytes.slice(0, position), offsets };
  }

  private async request(worker: Worker, request: ScanRequest, transfer: Transferable[]): Promise<Uint32Array> {
    return new Promise((resolve, reject) => {
      function onMessage(messageEvent: MessageEvent<ScanResponse>): void {
        cleanUp();
        if (messageEvent.data.error) {
          reject(new Error(messageEvent.data.error));
          return;
        }
        resolve(messageEvent.data.ids);
      }
      function onError(errorEvent: ErrorEvent): void {
        cleanUp();
        reject(new Error(errorEvent.message));
      }
      function cleanUp(): void {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
      }
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage(request, transfer);
    });
  }
}

/**
 * Splits the files into contiguous shares of roughly equal byte size, one per worker.
 *
 * @param files - The files, in id order.
 * @param shareCount - How many shares.
 * @returns The shares.
 */
function splitIntoShares(files: readonly IndexedFile[], shareCount: number): Share[] {
  let totalSize = 0;
  for (const file of files) {
    totalSize += file.size;
  }
  const shareTarget = Math.ceil(totalSize / shareCount);
  const shares: Share[] = [];
  let start = 0;
  for (let shareIndex = 0; shareIndex < shareCount; shareIndex++) {
    let end = start;
    let size = 0;
    const sizeLimit = shareIndex === shareCount - 1 ? Infinity : shareTarget;
    while (end < files.length && size < sizeLimit) {
      size += files[end]?.size ?? 0;
      end++;
    }
    shares.push({ files: files.slice(start, end), size, start });
    start = end;
  }
  return shares;
}

/* eslint-enable n/no-unsupported-features/node-builtins -- End of the file-wide Web API section. */
