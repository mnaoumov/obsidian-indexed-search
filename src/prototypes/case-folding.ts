/**
 * @file
 *
 * Case folding that never separates two characters core Search treats as equal.
 *
 * Core builds every search regex with `gm` or `gmi` and never `u`, so case-insensitive matching follows
 * ECMAScript's NON-Unicode `Canonicalize`: each UTF-16 code unit is upper-cased on its own, and the result is
 * kept only when it is a single code unit that does not move a non-ASCII unit into ASCII. Two code units match
 * under `i` exactly when their canonical forms are equal, so folding text and terms through the same table is
 * exact for `i` and a superset for case-sensitive queries.
 */

/* eslint-disable unicorn/prefer-code-point -- Core's regexes have no `u` flag, so they compare UTF-16 code units, and so must the fold. */

const CODE_UNIT_COUNT = 0x1_00_00;
const ASCII_LIMIT = 0x80;
const FOLD_CHUNK_SIZE = 8192;

const FOLD_TABLE = buildFoldTable();

/**
 * Folds a string code unit by code unit.
 *
 * @param text - The text to fold.
 * @returns The folded text, with the same length as the input.
 */
export function foldText(text: string): string {
  let folded = '';
  for (let start = 0; start < text.length; start += FOLD_CHUNK_SIZE) {
    const end = Math.min(start + FOLD_CHUNK_SIZE, text.length);
    const codes = new Uint16Array(end - start);
    for (let index = start; index < end; index++) {
      codes[index - start] = FOLD_TABLE[text.charCodeAt(index)] ?? 0;
    }
    folded += String.fromCharCode(...codes);
  }
  return folded;
}

/**
 * Returns the fold table: the canonical form of every UTF-16 code unit.
 *
 * @returns A table indexed by code unit.
 */
export function getFoldTable(): Uint16Array {
  return FOLD_TABLE;
}

function buildFoldTable(): Uint16Array {
  const table = new Uint16Array(CODE_UNIT_COUNT);
  for (let codeUnit = 0; codeUnit < CODE_UNIT_COUNT; codeUnit++) {
    table[codeUnit] = canonicalize(codeUnit);
  }
  return table;
}

function canonicalize(codeUnit: number): number {
  const upper = String.fromCharCode(codeUnit).toUpperCase();
  if (upper.length !== 1) {
    return codeUnit;
  }
  const upperCodeUnit = upper.charCodeAt(0);
  return codeUnit >= ASCII_LIMIT && upperCodeUnit < ASCII_LIMIT ? codeUnit : upperCodeUnit;
}

/* eslint-enable unicorn/prefer-code-point -- End of the file-wide UTF-16 code unit section. */
