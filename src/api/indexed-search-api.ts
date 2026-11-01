/**
 * @file
 *
 * The runtime half of this plugin's published contract: the registry contract and its version.
 *
 * The TYPES are not declared here. They live in the repo-root `api.d.ts`, which is the file a consumer reads, and
 * are re-exported from it so there is exactly one declaration of each and nothing to drift.
 */

import type { ApiContract } from '@mnaoumov/typescript-lib/api-contract';

import { INDEXED_SEARCH_API_CONTRACT } from '../../api-contract.ts';

export type {
  IndexedSearchApi,
  IndexedSearchHit,
  IndexedSearchMatch,
  IndexedSearchOptions,
  IndexedSearchPropertyMatch,
  IndexedSearchRange
} from '../../api.d.ts';

/**
 * The contract this plugin publishes: the repo-root `api-contract.ts` constant a consumer copies, so the provider
 * and its consumers validate against one definition. Assigning it here is also what checks that its schemas are
 * Standard Schemas the registry accepts.
 */
export const PLUGIN_API_CONTRACT: ApiContract = INDEXED_SEARCH_API_CONTRACT;

/**
 * The version of the contract above — independent of the plugin's own version, so a consumer asks for `'^1'` and
 * keeps working across releases that change nothing it depends on.
 *
 * `1.0.0` is `search`, which answers a core Search query with core's own results.
 */
export const PLUGIN_API_VERSION = '1.0.0';
