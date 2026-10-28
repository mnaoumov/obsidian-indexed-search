/**
 * @file
 *
 * The engine benchmark's corpus: the shared performance vault with varied filler prose.
 *
 * The shared generator fills every filler note with one repeated sentence, which leaves a trigram index a few
 * dozen trigrams and every query a 0%, 25% or 75% hit rate. This keeps its paths, its note count, its
 * fixtures and each note's exact UTF-8 byte count, and rewrites only the filler prose: seeded, Zipf-distributed
 * synthetic words in the note's own language, with needle terms planted at known rates. The vocabulary is
 * synthetic, so benchmark conclusions must still say so.
 */

import type { GeneratePerformanceVaultOptions } from '@mnaoumov/obsidian-dev-toolkit/test-runners/performance-vault';

import {
  generatePerformanceVault,
  PERFORMANCE_VAULT_FILLER_FOLDER
} from '@mnaoumov/obsidian-dev-toolkit/test-runners/performance-vault';

/**
 * The options of {@link generateVariedPerformanceVault}: the shared generator's.
 */
export type GenerateVariedPerformanceVaultParams = GeneratePerformanceVaultOptions;

/**
 * A planted needle: a fixed text inserted into every `interval`-th filler note of a language.
 */
export interface PlantedNeedle {
  /**
   * The needle goes into the notes whose ordinal leaves this needle's list position plus one as the remainder,
   * so no two needles of one language share a note.
   */
  readonly interval: number;
  readonly language: 'cyrillic' | 'latin';
  readonly text: string;
}

interface MakeProseParams {
  readonly byteLength: number;
  readonly language: 'cyrillic' | 'latin';
  readonly needles: readonly string[];
}

/**
 * A needle in one note of every hundred of its language.
 */
const ONE_PERCENT_INTERVAL = 100;
/**
 * A needle in one note of every three hundred of its language.
 */
const ONE_THIRD_PERCENT_INTERVAL = 300;

/**
 * The needles every benchmark query is built around.
 */
export const PLANTED_NEEDLES: readonly PlantedNeedle[] = [
  { interval: ONE_PERCENT_INTERVAL, language: 'latin', text: 'Quillwort' },
  { interval: ONE_THIRD_PERCENT_INTERVAL, language: 'latin', text: 'silver harbour lantern' },
  { interval: ONE_THIRD_PERCENT_INTERVAL, language: 'latin', text: 'silver harbor lantern' },
  { interval: ONE_PERCENT_INTERVAL, language: 'cyrillic', text: 'журавлина' }
];

/**
 * The corpus options the benchmark uses: the shared defaults, 37,000 notes and 110,000,000 bytes.
 */
export const VARIED_PERFORMANCE_VAULT_OPTIONS: GeneratePerformanceVaultOptions = {};

const VOCABULARY_SIZE = 20_000;
const ZIPF_EXPONENT = 1.07;
const SEED = 20_261_028;
const PARK_MILLER_MULTIPLIER = 48_271;
const BINARY_SEARCH_DIVISOR = 2;
const PARK_MILLER_MODULUS = 2_147_483_647;
const UTF8_CONTINUATION_MIN = 0x80;
const UTF8_CONTINUATION_END = 0xC0;
const MIN_SENTENCE_WORDS = 6;
const SENTENCE_WORD_SPREAD = 12;
const SENTENCES_PER_PARAGRAPH = 5;
const MIN_WORD_LENGTH = 2;
const WORD_LENGTH_SPREAD = 9;
const MIN_TOKEN_LENGTH = 6;
const TOKEN_LENGTH_SPREAD = 7;
/**
 * The share of words that are id-like tokens (hashes, dates, slugs), which real vaults carry in links and
 * code and which give an index most of its rare trigrams.
 */
const TOKEN_SHARE = 0.02;
const CYRILLIC_PATTERN = /[Ѐ-ӿ]/u;

/**
 * Letters repeated roughly by their frequency in prose, so common trigrams are common.
 */
// Cspell:disable-next-line -- letters weighted by frequency, not a word.
const LATIN_LETTERS = 'eeeeeeeeeeeettttttttaaaaaaaaoooooooiiiiiiinnnnnnnsssssshhhhhhrrrrrrddddllllcccuuummmwwffggyyppbbvkjxqz';
// Cspell:disable-next-line -- letters weighted by frequency, not a word.
const CYRILLIC_LETTERS = 'оооооооааааааннннннииииивввввіііііттттттеееееррррррсссссккккклллллдддддуууумммпппзззяяььггбббчйхжшюцщєїф';
const TOKEN_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789-_';

class VariedCorpusGenerator {
  private readonly cumulativeWeights: Float64Array;
  private readonly cyrillicWords: readonly string[];
  private readonly latinWords: readonly string[];
  private state = SEED;

  public constructor() {
    this.cumulativeWeights = new Float64Array(VOCABULARY_SIZE);
    let total = 0;
    for (let rank = 0; rank < VOCABULARY_SIZE; rank++) {
      total += 1 / (rank + 1) ** ZIPF_EXPONENT;
      this.cumulativeWeights[rank] = total;
    }
    this.latinWords = this.makeVocabulary(LATIN_LETTERS);
    this.cyrillicWords = this.makeVocabulary(CYRILLIC_LETTERS);
  }

  public generate(options: GeneratePerformanceVaultOptions): Map<string, string> {
    const notes = new Map(Object.entries(generatePerformanceVault(options)));
    const counters = { cyrillic: 0, latin: 0 };
    for (const [path, text] of notes) {
      if (!path.startsWith(`${PERFORMANCE_VAULT_FILLER_FOLDER}/`) || text.length === 0) {
        continue;
      }
      const language = CYRILLIC_PATTERN.test(text) ? 'cyrillic' : 'latin';
      const ordinal = counters[language]++;
      const needles = PLANTED_NEEDLES
        .filter((needle, index) => needle.language === language && ordinal % needle.interval === index + 1)
        .map((needle) => needle.text);
      notes.set(path, this.makeProse({ byteLength: Buffer.byteLength(text), language, needles }));
    }
    return notes;
  }

  private makeProse(params: MakeProseParams): string {
    const words = params.language === 'cyrillic' ? this.cyrillicWords : this.latinWords;
    const parts: string[] = [];
    let byteCount = 0;
    let sentence = 0;
    const pending = [...params.needles];
    while (byteCount < params.byteLength) {
      const wordCount = MIN_SENTENCE_WORDS + this.nextInt(SENTENCE_WORD_SPREAD);
      const sentenceWords: string[] = [];
      for (let index = 0; index < wordCount; index++) {
        sentenceWords.push(
          this.nextFloat() < TOKEN_SHARE
            ? this.makeWord(TOKEN_CHARACTERS, MIN_TOKEN_LENGTH + this.nextInt(TOKEN_LENGTH_SPREAD))
            : words[this.nextZipfRank()] ?? ''
        );
      }
      // Needles go into the second sentence onwards, one per sentence, well inside every filler note's budget.
      const needle = sentence > 0 ? pending.shift() : undefined;
      if (needle) {
        sentenceWords.splice(this.nextInt(sentenceWords.length), 0, needle);
      }
      const first = sentenceWords[0] ?? '';
      sentenceWords[0] = first.charAt(0).toUpperCase() + first.slice(1);
      sentence++;
      const separator = sentence % SENTENCES_PER_PARAGRAPH === 0 ? '\n\n' : ' ';
      const part = `${sentenceWords.join(' ')}.${separator}`;
      parts.push(part);
      byteCount += Buffer.byteLength(part);
    }
    return fitToByteLength(parts.join(''), params.byteLength);
  }

  private makeVocabulary(letters: string): string[] {
    const seen = new Set<string>();
    const vocabulary: string[] = [];
    while (vocabulary.length < VOCABULARY_SIZE) {
      // Frequent words are short, as in real prose: the length grows with the rank.
      const lengthSpread = Math.max(1, Math.round(WORD_LENGTH_SPREAD * Math.sqrt(vocabulary.length / VOCABULARY_SIZE)));
      const word = this.makeWord(letters, MIN_WORD_LENGTH + this.nextInt(lengthSpread + 1));
      if (seen.has(word)) {
        continue;
      }

      seen.add(word);
      vocabulary.push(word);
    }
    return vocabulary;
  }

  private makeWord(characters: string, length: number): string {
    let word = '';
    for (let index = 0; index < length; index++) {
      word += characters.charAt(this.nextInt(characters.length));
    }
    return word;
  }

  private nextFloat(): number {
    // The Park-Miller minimal standard generator: every product stays exact in a double.
    this.state = (this.state * PARK_MILLER_MULTIPLIER) % PARK_MILLER_MODULUS;
    return (this.state - 1) / (PARK_MILLER_MODULUS - 1);
  }

  private nextInt(limit: number): number {
    return Math.floor(this.nextFloat() * limit);
  }

  private nextZipfRank(): number {
    const target = this.nextFloat() * (this.cumulativeWeights[VOCABULARY_SIZE - 1] ?? 0);
    let low = 0;
    let high = VOCABULARY_SIZE - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / BINARY_SEARCH_DIVISOR);
      if ((this.cumulativeWeights[middle] ?? 0) < target) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }
}

/**
 * Generates the benchmark corpus.
 *
 * @param params - The shared generator's options.
 * @returns Vault-relative paths mapped to text.
 */
export function generateVariedPerformanceVault(params: GenerateVariedPerformanceVaultParams): Map<string, string> {
  return new VariedCorpusGenerator().generate(params);
}

/**
 * Cuts text to at most `byteLength` UTF-8 bytes on a code point boundary, then pads it with spaces to exactly that.
 *
 * @param text - The text.
 * @param byteLength - The exact byte length wanted.
 * @returns The fitted text.
 */
function fitToByteLength(text: string, byteLength: number): string {
  const encoded = Buffer.from(text, 'utf-8');
  let end = Math.min(byteLength, encoded.length);
  while (end > 0 && end < encoded.length && isUtf8ContinuationByte(encoded[end] ?? 0)) {
    end--;
  }
  const fitted = encoded.subarray(0, end).toString('utf-8');
  return fitted + ' '.repeat(byteLength - end);
}

function isUtf8ContinuationByte(byte: number): boolean {
  return byte >= UTF8_CONTINUATION_MIN && byte < UTF8_CONTINUATION_END;
}
