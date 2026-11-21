/**
 * @file
 *
 * A bounded, least-recently-used cache of decoded posting lists, one per trigram across every segment.
 *
 * Typing a query in core Search starts a search on every keystroke, and each new prefix shares all but one of its
 * trigrams with the one before. Reading those again from IndexedDB costs a round trip of 40 ms or more each, and
 * far more on a busy machine (0.4 to 2.2 s on a copy of a 40,000-note real vault, 2026-11-20), so the lists a search
 * read are kept for the next one.
 */

/**
 * What {@link PostingCache} holds at most.
 */
export interface PostingCacheConstructorParams {
  /**
   * How many file ids all cached lists may hold together; 4 bytes each.
   */
  readonly maxIds: number;
}

/**
 * Decoded posting lists by trigram, evicting the least recently used once over its bound.
 */
export class PostingCache {
  private readonly lists = new Map<number, Uint32Array>();
  private readonly maxIds: number;
  private totalIds = 0;

  /**
   * Creates an empty cache.
   *
   * @param params - The bound.
   */
  public constructor(params: PostingCacheConstructorParams) {
    this.maxIds = params.maxIds;
  }

  /**
   * Drops every list.
   */
  public clear(): void {
    this.lists.clear();
    this.totalIds = 0;
  }

  /**
   * Returns a trigram's cached list, marking it recently used.
   *
   * @param trigram - The trigram.
   * @returns The list, or `null` when it is not cached.
   */
  public get(trigram: number): null | Uint32Array {
    const ids = this.lists.get(trigram);
    if (ids === undefined) {
      return null;
    }
    // Re-inserting moves the entry to the end of the map's order, which is the most recently used end.
    this.lists.delete(trigram);
    this.lists.set(trigram, ids);
    return ids;
  }

  /**
   * Caches a trigram's list, evicting the least recently used lists past the bound. A list larger than the whole
   * bound is not cached.
   *
   * @param trigram - The trigram.
   * @param ids - Its list.
   */
  public set(trigram: number, ids: Uint32Array): void {
    const previous = this.lists.get(trigram);
    if (previous !== undefined) {
      this.lists.delete(trigram);
      this.totalIds -= previous.length;
    }
    if (ids.length > this.maxIds) {
      return;
    }
    this.lists.set(trigram, ids);
    this.totalIds += ids.length;
    for (const [oldest, oldestIds] of this.lists) {
      if (this.totalIds <= this.maxIds) {
        break;
      }
      this.lists.delete(oldest);
      this.totalIds -= oldestIds.length;
    }
  }
}
