/**
 * @file
 *
 * The shape of the performance corpus: the shared 37,000-note, 110 MB generated vault, plus empty attachments, so
 * the vault has about as many files as a large real one (measured 2026-11-20: 77,014 files, 40,484 of them notes).
 * Core Search queues every attachment too, and matches it by name and path, so a corpus of notes alone hides what
 * attachments cost a search.
 */

/**
 * The generated notes.
 */
export const PERFORMANCE_NOTE_COUNT = 37_000;

/**
 * The empty attachments added beside them.
 */
export const PERFORMANCE_ATTACHMENT_COUNT = 36_530;

/**
 * Every file of the corpus.
 */
export const PERFORMANCE_FILE_COUNT = PERFORMANCE_NOTE_COUNT + PERFORMANCE_ATTACHMENT_COUNT;

const ATTACHMENTS_PER_FOLDER = 30;

/**
 * Returns the empty attachments of the corpus, by vault-relative path. Their names hold none of the generator's
 * planted terms, so every benchmark query's match count stays what the notes give.
 *
 * @returns The attachments, each with empty content.
 */
export function generatePerformanceAttachments(): Record<string, string> {
  const attachments: Record<string, string> = {};
  for (let index = 0; index < PERFORMANCE_ATTACHMENT_COUNT; index++) {
    const folder = Math.floor(index / ATTACHMENTS_PER_FOLDER);
    attachments[`attachments/folder-${String(folder)}/image-${String(index)}.png`] = '';
  }
  return attachments;
}
