/**
 * @file
 *
 * Posting lists: sorted file ids, stored as delta varints and combined as sorted `Uint32Array`s.
 */

import type { TrigramQuery } from './trigram-query.ts';

/**
 * A varint byte carries seven payload bits; this bit set means another byte follows.
 */
const VARINT_CONTINUATION = 0x80;
const MAX_VARINT_BYTES = 5;

/**
 * What {@link decodePostings} decodes.
 */
export interface DecodePostingsParams {
  /**
   * The id the first delta is relative to.
   */
  readonly base: number;
  /**
   * The encoded deltas.
   */
  readonly bytes: Uint8Array;
  /**
   * Where in `target` to start writing.
   */
  readonly offset: number;
  /**
   * The array to write into, large enough for every id.
   */
  readonly target: Uint32Array;
}

/**
 * Decodes delta varints into ascending ids, appending them to `target`.
 *
 * @param params - What to decode and where.
 * @returns The number of ids written.
 */
export function decodePostings(params: DecodePostingsParams): number {
  const { base, bytes, offset, target } = params;
  let previous = base;
  let written = 0;
  let position = 0;
  while (position < bytes.length) {
    let delta = 0;
    let byte: number;
    let multiplier = 1;
    do {
      byte = bytes[position++] ?? 0;
      delta += (byte % VARINT_CONTINUATION) * multiplier;
      multiplier *= VARINT_CONTINUATION;
    } while (byte >= VARINT_CONTINUATION);
    previous += delta;
    target[offset + written] = previous;
    written++;
  }
  return written;
}

/**
 * Encodes ascending ids as delta varints.
 *
 * @param ids - The ascending ids.
 * @param base - The id the first delta is relative to; no id may be below it.
 * @returns The encoded bytes.
 */
export function encodePostings(ids: readonly number[] | Uint32Array, base: number): Uint8Array {
  const buffer = new Uint8Array(ids.length * MAX_VARINT_BYTES);
  let position = 0;
  let previous = base;
  for (const id of ids) {
    let delta = id - previous;
    previous = id;
    while (delta >= VARINT_CONTINUATION) {
      buffer[position++] = (delta % VARINT_CONTINUATION) + VARINT_CONTINUATION;
      delta = Math.floor(delta / VARINT_CONTINUATION);
    }
    buffer[position++] = delta;
  }
  return buffer.slice(0, position);
}

/**
 * Evaluates a trigram query over known posting lists.
 *
 * @param query - The query.
 * @param postings - The posting list of every trigram in the query; `null` means "every file".
 * @returns The matching ids, ascending, or `null` for every file.
 */
export function evaluateQuery(query: TrigramQuery, postings: ReadonlyMap<number, null | Uint32Array>): null | Uint32Array {
  switch (query.kind) {
    case 'all': {
      return null;
    }
    case 'and': {
      let result: null | Uint32Array = null;
      for (const child of query.children) {
        const childResult = evaluateQuery(child, postings);
        if (childResult === null) {
          continue;
        }
        result = result === null ? childResult : intersect(result, childResult);
        if (result.length === 0) {
          break;
        }
      }
      return result;
    }
    case 'none': {
      return new Uint32Array(0);
    }
    case 'or': {
      let result: Uint32Array = new Uint32Array(0);
      for (const child of query.children) {
        const childResult = evaluateQuery(child, postings);
        if (childResult === null) {
          return null;
        }
        result = unite(result, childResult);
      }
      return result;
    }
    case 'trigram': {
      const list = postings.get(query.trigram);
      return list === undefined ? new Uint32Array(0) : list;
    }
    default: {
      throw new Error('Unknown query kind');
    }
  }
}

/**
 * Intersects two ascending id lists.
 *
 * @param left - The first list.
 * @param right - The second list.
 * @returns The ids in both.
 */
export function intersect(left: Uint32Array, right: Uint32Array): Uint32Array {
  const result = new Uint32Array(Math.min(left.length, right.length));
  let leftIndex = 0;
  let rightIndex = 0;
  let count = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftId = left[leftIndex] ?? 0;
    const rightId = right[rightIndex] ?? 0;
    if (leftId === rightId) {
      result[count++] = leftId;
      leftIndex++;
      rightIndex++;
    } else if (leftId < rightId) {
      leftIndex++;
    } else {
      rightIndex++;
    }
  }
  return result.slice(0, count);
}

/**
 * Unites two ascending id lists.
 *
 * @param left - The first list.
 * @param right - The second list.
 * @returns The ids in either, ascending, without duplicates.
 */
export function unite(left: Uint32Array, right: Uint32Array): Uint32Array {
  const result = new Uint32Array(left.length + right.length);
  let leftIndex = 0;
  let rightIndex = 0;
  let count = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftId = left[leftIndex] ?? Infinity;
    const rightId = right[rightIndex] ?? Infinity;
    if (leftId <= rightId) {
      result[count++] = leftId;
      leftIndex++;
      if (leftId === rightId) {
        rightIndex++;
      }
    } else {
      result[count++] = rightId;
      rightIndex++;
    }
  }
  return result.slice(0, count);
}
