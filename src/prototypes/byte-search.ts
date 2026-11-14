/**
 * @file
 *
 * Literal search over a buffer of back-to-back files, reporting each file that contains the pattern once.
 */

import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';

const BYTE_VALUES = 256;

/**
 * What {@link findFilesContaining} searches.
 */
export interface FindFilesContainingParams {
  readonly bytes: Uint8Array;
  /**
   * Where each file starts in `bytes`, plus one final entry for the end.
   */
  readonly offsets: Uint32Array;
  readonly pattern: Uint8Array;
}

/**
 * Finds the files containing a byte pattern, with Boyer-Moore-Horspool. A match may not cross a file boundary.
 *
 * @param params - The buffer, its file offsets and the pattern.
 * @returns The indexes of the matching files, ascending.
 */
export function findFilesContaining(params: FindFilesContainingParams): Uint32Array {
  const { bytes, offsets, pattern } = params;
  const fileCount = offsets.length - 1;
  const result = new Uint32Array(fileCount);
  let count = 0;
  const patternLength = pattern.length;
  if (patternLength === 0) {
    for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
      result[fileIndex] = fileIndex;
    }
    return result;
  }
  const shifts = new Uint32Array(BYTE_VALUES).fill(patternLength);
  for (let index = 0; index < patternLength - 1; index++) {
    shifts[ensureNonNullable(pattern[index])] = patternLength - 1 - index;
  }
  const lastPatternByte = ensureNonNullable(pattern[patternLength - 1]);
  let fileIndex = 0;
  let fileEnd = ensureNonNullable(offsets[1]);
  let position = ensureNonNullable(offsets[0]);
  const end = ensureNonNullable(offsets[fileCount]);
  while (position + patternLength <= end) {
    const lastByte = ensureNonNullable(bytes[position + patternLength - 1]);
    if (lastByte === lastPatternByte && isMatchAt(bytes, pattern, position)) {
      while (position >= fileEnd) {
        fileIndex++;
        fileEnd = ensureNonNullable(offsets[fileIndex + 1]);
      }
      if (position + patternLength <= fileEnd) {
        result[count++] = fileIndex;
        position = fileEnd;
        continue;
      }
    }
    position += ensureNonNullable(shifts[lastByte]);
  }
  return result.slice(0, count);
}

function isMatchAt(bytes: Uint8Array, pattern: Uint8Array, position: number): boolean {
  for (let index = 0; index < pattern.length - 1; index++) {
    if (bytes[position + index] !== pattern[index]) {
      return false;
    }
  }
  return true;
}
