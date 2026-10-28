/**
 * @file
 *
 * Literal search over a buffer of back-to-back files, reporting each file that contains the pattern once.
 */

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
    shifts[pattern[index] ?? 0] = patternLength - 1 - index;
  }
  const lastPatternByte = pattern[patternLength - 1] ?? 0;
  let fileIndex = 0;
  let fileEnd = offsets[1] ?? 0;
  let position = offsets[0] ?? 0;
  const end = offsets[fileCount] ?? 0;
  while (position + patternLength <= end) {
    const lastByte = bytes[position + patternLength - 1] ?? 0;
    if (lastByte === lastPatternByte && isMatchAt(bytes, pattern, position)) {
      while (position >= fileEnd) {
        fileIndex++;
        fileEnd = offsets[fileIndex + 1] ?? end;
      }
      if (position + patternLength <= fileEnd) {
        result[count++] = fileIndex;
        position = fileEnd;
        continue;
      }
    }
    position += shifts[lastByte] ?? patternLength;
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
