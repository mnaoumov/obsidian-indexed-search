/**
 * @file
 *
 * The runtime half of `Indexed Search`' published API: its CONTRACT, one entry per method of
 * {@link IndexedSearchApi}, each with a schema over the argument list and a schema over the value the method
 * returns (awaited).
 *
 * This plugin publishes exactly this constant with its API, and a consumer copies it beside `api.d.ts` and
 * passes it as the `contract` when it looks the API up, so both ends validate against ONE definition. The
 * plugin registry checks the payloads against it only while the `obsidian-lib:validate-plugin-api-payloads`
 * debug switch is on.
 *
 * Copying it takes one dependency beside `api.d.ts` and `obsidian`: `@mnaoumov/typescript-lib`, whose
 * `api-contract` entry point carries the contract type, the {@link https://standardschema.dev | Standard Schema}
 * builders and the common guards. {@link defineApiContract} checks every entry against its method's signature.
 *
 * It is not named `api.ts`: TypeScript would read `api.d.ts` as that file's own declarations.
 */

import {
  arrayGuard,
  BOOLEAN_GUARD,
  createApiContractSchemaBuilders,
  createExpectedTypeGuard,
  defineApiContract,
  instanceOfGuard,
  objectGuard,
  optionalGuard,
  optionsGuard,
  STRING_GUARD
} from '@mnaoumov/typescript-lib/api-contract';
import { TFile } from 'obsidian';

import type {
  IndexedSearchApi,
  IndexedSearchHit,
  IndexedSearchMatch,
  IndexedSearchOptions,
  IndexedSearchPropertyMatch,
  IndexedSearchRange
} from './api.d.ts';

const { createArgumentsSchema, createTypeGuardSchema } = createApiContractSchemaBuilders('indexed-search');

/**
 * A range is its start and its end.
 */
const RANGE_LENGTH = 2;

function isRange(value: unknown): value is IndexedSearchRange {
  return Array.isArray(value) && value.length === RANGE_LENGTH && value.every((offset) => Number.isSafeInteger(offset));
}

function isRanges(value: unknown): value is readonly IndexedSearchRange[] {
  return Array.isArray(value) && value.every(isRange);
}

const RANGE_GUARD = createExpectedTypeGuard('a [start, end] range', isRange);
const RANGES_GUARD = createExpectedTypeGuard('a list of [start, end] ranges', isRanges);

const CANVAS_NODES_GUARD = createExpectedTypeGuard(
  'the ranges of each canvas card, by card id',
  (value: unknown): value is Readonly<Record<string, readonly IndexedSearchRange[]>> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isRanges)
);

const PROPERTY_MATCH_GUARD = objectGuard<IndexedSearchPropertyMatch>({
  key: STRING_GUARD,
  range: optionalGuard(RANGE_GUARD)
}, { description: 'a matched property' });

const MATCH_GUARD = objectGuard<IndexedSearchMatch>({
  canvasNodes: optionalGuard(CANVAS_NODES_GUARD),
  content: optionalGuard(RANGES_GUARD),
  filename: optionalGuard(RANGES_GUARD),
  filepath: optionalGuard(RANGES_GUARD),
  properties: optionalGuard(arrayGuard(PROPERTY_MATCH_GUARD))
}, { description: 'where the query matched' });

const HIT_GUARD = objectGuard<IndexedSearchHit>({
  file: instanceOfGuard(TFile),
  match: MATCH_GUARD
}, { description: 'a search hit' });

const SEARCH_OPTIONS_GUARD = optionsGuard<IndexedSearchOptions>({
  abortSignal: instanceOfGuard(AbortSignal),
  isCaseSensitive: BOOLEAN_GUARD
}, { description: 'search options' });

/**
 * The contract this plugin publishes with {@link IndexedSearchApi}, for a consumer to pass as the `contract`
 * when it looks the API up.
 */
export const INDEXED_SEARCH_API_CONTRACT = defineApiContract<IndexedSearchApi>({
  search: {
    input: createArgumentsSchema([
      { ...STRING_GUARD, expected: 'a core Search query' },
      optionalGuard(SEARCH_OPTIONS_GUARD)
    ]),
    output: createTypeGuardSchema({ ...arrayGuard(HIT_GUARD), expected: 'a list of search hits' })
  }
});
