import {
  describe,
  expect,
  it
} from 'vitest';

import {
  PLUGIN_API_CONTRACT,
  PLUGIN_API_VERSION
} from './indexed-search-api.ts';

/*
 * These values are a WIRE CONTRACT: a consumer negotiates against the version and validates against the contract.
 * So the test asserts the literals themselves.
 */
describe('the published contract', () => {
  it('should declare every member of the api in the contract', () => {
    expect(Object.keys(PLUGIN_API_CONTRACT).sort()).toEqual(['search']);
  });

  it('should publish a contract version independent of the plugin version', () => {
    expect(PLUGIN_API_VERSION).toBe('1.0.0');
  });
});
