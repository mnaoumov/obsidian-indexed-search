import {
  generateVariedPerformanceVault,
  VARIED_PERFORMANCE_VAULT_OPTIONS
} from './helpers/varied-performance-vault.ts';

const { createSetup } = await import('obsidian-integration-testing/vitest-global-setup-plugin');

/**
Populates the varied benchmark corpus before Obsidian opens it.
*/
export const { setup, teardown } = createSetup({
  populate: () => Object.fromEntries(generateVariedPerformanceVault(VARIED_PERFORMANCE_VAULT_OPTIONS))
});
