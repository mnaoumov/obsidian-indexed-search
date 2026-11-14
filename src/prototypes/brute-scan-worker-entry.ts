/**
 * @file
 *
 * The bundle entry of the brute-scan worker.
 */

/* v8 ignore file -- Not unit tested: the worker bundle entry, which only starts the worker on its global scope. */

import { startBruteScanWorker } from './brute-scan-worker.ts';

startBruteScanWorker(self);
