import { wrapCliTask } from '@mnaoumov/typescript-dev-toolkit/cli-utils';
import { testCoverage } from '@mnaoumov/typescript-dev-toolkit/test-runners/vitest';

/**
 * Every line, branch, function and statement of `src` is covered, or excluded inline with its reason.
 */
const MIN_COVERAGE_IN_PERCENTS = 100;

await wrapCliTask(() =>
  testCoverage({
    minCoverageInPercents: MIN_COVERAGE_IN_PERCENTS,
    projects: ['unit-tests']
  })
);
