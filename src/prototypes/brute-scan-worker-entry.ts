/**
 * @file
 *
 * The bundle entry of the brute-scan worker.
 */

/* v8 ignore file -- Not unit tested: the worker bundle entry, which only exposes the worker's handlers on its global scope. */

import { exposeWorkerApi } from '@mnaoumov/obsidian-lib/worker-protocol';

import type { BruteScanWorkerApi } from './brute-scan-protocol.ts';

import { createBruteScanHandlers } from './brute-scan-worker.ts';

exposeWorkerApi<BruteScanWorkerApi>(createBruteScanHandlers());
