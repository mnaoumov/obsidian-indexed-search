import { generatePerformanceVault } from '@mnaoumov/obsidian-dev-toolkit/test-runners/performance-vault';

import { generatePerformanceAttachments } from './helpers/performance-vault-shape.ts';

const { createSetup } = await import('obsidian-integration-testing/vitest-global-setup-plugin');

/**
Populates the benchmark corpus before Obsidian opens it: the shared 37,000-note, 110 MB performance vault, with varied
filler prose so a trigram index sees a realistic spread of trigrams, and 36,530 empty attachments, so the vault has as
many files as a large real one.
*/
export const { setup, teardown } = createSetup({
  populate: () => ({ ...generatePerformanceVault({ prose: 'varied' }), ...generatePerformanceAttachments() })
});
