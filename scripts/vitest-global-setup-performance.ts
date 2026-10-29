import { generatePerformanceVault } from '@mnaoumov/obsidian-dev-toolkit/test-runners/performance-vault';

const { createSetup } = await import('obsidian-integration-testing/vitest-global-setup-plugin');

/**
Populates the benchmark corpus before Obsidian opens it: the shared 37,000-note, 110 MB performance vault, with varied
filler prose so a trigram index sees a realistic spread of trigrams.
*/
export const { setup, teardown } = createSetup({
  populate: () => generatePerformanceVault({ prose: 'varied' })
});
