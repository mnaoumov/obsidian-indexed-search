/**
 * @file
 *
 * The brute-scan worker: holds one share of the folded corpus and scans it per call.
 */

/* v8 ignore file -- Not unit tested: a benchmark prototype that runs inside a Web Worker; the desktop performance suite is its test. */

import type {
  TransferredValue,
  WorkerApiHandlers
} from '@mnaoumov/obsidian-lib/worker-protocol';

import { withTransfer } from '@mnaoumov/obsidian-lib/worker-protocol';

import type {
  BruteScanShare,
  BruteScanWorkerApi
} from './brute-scan-protocol.ts';

import { findFilesContaining } from './byte-search.ts';

/**
 * Creates the handlers of one brute-scan worker, which keep its share between calls.
 *
 * @returns The handlers.
 */
export function createBruteScanHandlers(): WorkerApiHandlers<BruteScanWorkerApi> {
  const decoder = new TextDecoder();
  let loadedShare: BruteScanShare | null = null;

  function getShare(): BruteScanShare {
    if (!loadedShare) {
      throw new Error('No share loaded');
    }
    return loadedShare;
  }

  function toIds(share: BruteScanShare, fileIndexes: Uint32Array): TransferredValue<Uint32Array> {
    const ids = fileIndexes.map((fileIndex) => share.ids[fileIndex] ?? 0);
    return withTransfer(ids, [ids.buffer]);
  }

  return {
    findLiteral(pattern): TransferredValue<Uint32Array> {
      const share = getShare();
      return toIds(share, findFilesContaining({ bytes: share.bytes, offsets: share.offsets, pattern }));
    },
    findRegex(source): TransferredValue<Uint32Array> {
      const share = getShare();
      // `i` over folded text accepts every file core's `gm` or `gmi` regex accepts over the original text.
      const regex = new RegExp(source, 'mi');
      const fileCount = share.offsets.length - 1;
      const fileIndexes = new Uint32Array(fileCount);
      let count = 0;
      for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
        const text = decoder.decode(share.bytes.subarray(share.offsets[fileIndex], share.offsets[fileIndex + 1]));
        if (regex.test(text)) {
          fileIndexes[count++] = fileIndex;
        }
      }
      return toIds(share, fileIndexes.subarray(0, count));
    },
    load(share): void {
      loadedShare = share;
    }
  };
}
