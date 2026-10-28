/**
 * @file
 *
 * The brute-scan worker: holds one share of the folded corpus and scans it per request.
 */

import type {
  LoadRequest,
  ScanRequest,
  ScanResponse
} from './brute-scan-protocol.ts';

import { findFilesContaining } from './byte-search.ts';

interface WorkerScope {
  readonly addEventListener: (type: 'message', listener: (messageEvent: MessageEvent<ScanRequest>) => void) => void;
  readonly postMessage: (message: ScanResponse, options: StructuredSerializeOptions) => void;
}

class BruteScanWorker {
  private readonly decoder = new TextDecoder();
  private share: LoadRequest | null = null;

  public handle(request: ScanRequest): Uint32Array {
    if (request.kind === 'load') {
      this.share = request;
      return new Uint32Array(0);
    }
    const share = this.share;
    if (!share) {
      throw new Error('No share loaded');
    }
    const fileIndexes = request.kind === 'literal'
      ? findFilesContaining({ bytes: share.bytes, offsets: share.offsets, pattern: request.pattern })
      : this.findFilesMatching(share, request.source);
    return fileIndexes.map((fileIndex) => share.ids[fileIndex] ?? 0);
  }

  private findFilesMatching(share: LoadRequest, source: string): Uint32Array {
    // `i` over folded text accepts every file core's `gm` or `gmi` regex accepts over the original text.
    const regex = new RegExp(source, 'mi');
    const fileCount = share.offsets.length - 1;
    const result = new Uint32Array(fileCount);
    let count = 0;
    for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
      const text = this.decoder.decode(share.bytes.subarray(share.offsets[fileIndex], share.offsets[fileIndex + 1]));
      if (regex.test(text)) {
        result[count++] = fileIndex;
      }
    }
    return result.slice(0, count);
  }
}

/**
 * Starts answering requests on a worker scope.
 *
 * @param scope - The worker's global scope.
 */
export function startBruteScanWorker(scope: WorkerScope): void {
  const worker = new BruteScanWorker();
  scope.addEventListener('message', (messageEvent): void => {
    let ids: Uint32Array;
    try {
      ids = worker.handle(messageEvent.data);
    } catch (error) {
      scope.postMessage({ error: String(error), ids: new Uint32Array(0) }, { transfer: [] });
      return;
    }
    scope.postMessage({ ids }, { transfer: [ids.buffer] });
  });
}
