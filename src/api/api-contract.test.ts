import type {
  ApiMethodCases,
  PayloadCases
} from '@mnaoumov/typescript-lib/api-contract-verifier';
import type { TFile } from 'obsidian';

import {
  validateSync,
  verifyApiContract
} from '@mnaoumov/typescript-lib/api-contract-verifier';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it
} from 'vitest';

import type { IndexedSearchApi } from '../../api.d.ts';

import { INDEXED_SEARCH_API_CONTRACT } from '../../api-contract.ts';

describe('INDEXED_SEARCH_API_CONTRACT', () => {
  let file: TFile;

  beforeEach(() => {
    const app = App.createConfigured__();
    file = castTo<TFile>(app.vault.createSync__('Alpha.md', ''));
  });

  function getCases(): Record<keyof IndexedSearchApi, ApiMethodCases> {
    const searchInput: PayloadCases = {
      invalid: [[], [1], ['alpha', { isCaseSensitive: 'yes' }], ['alpha', { abortSignal: {} }], ['alpha', {}, 'extra'], 'alpha'],
      valid: [['alpha'], ['alpha', {}], ['alpha', { abortSignal: new AbortController().signal, isCaseSensitive: true }]]
    };
    const searchOutput: PayloadCases = {
      invalid: [
        null,
        [{ file: { path: 'Alpha.md' }, match: {} }],
        [{ file, match: { content: [[0]] } }],
        [{ file, match: { canvasNodes: { n1: [['a', 1]] } } }],
        [{ file, match: { properties: [{ range: [0, 1] }] } }]
      ],
      valid: [
        [],
        [{ file, match: {} }],
        [{
          file,
          match: {
            canvasNodes: { n1: [[0, 3]] },
            content: [[0, 5]],
            filename: [[0, 5]],
            filepath: [[0, 5]],
            properties: [{ key: 'status' }, { key: 'tags', range: [0, 4] }]
          }
        }]
      ]
    };
    return {
      search: { input: searchInput, output: searchOutput }
    };
  }

  it('should pass the contract verification', async () => {
    expect(await verifyApiContract(INDEXED_SEARCH_API_CONTRACT, { cases: getCases(), vendor: 'indexed-search' })).toEqual([]);
  });

  it('should name the failing argument and what it expected', () => {
    expect(validateSync(INDEXED_SEARCH_API_CONTRACT.search.input, [1])).toEqual({
      issues: [{ message: 'Expected a core Search query.', path: [0] }]
    });
  });
});
