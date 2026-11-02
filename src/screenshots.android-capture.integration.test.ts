/**
 * @file
 *
 * Produces the mobile screenshots the community-directory listing needs, driving a real Obsidian Mobile on an
 * Android emulator and writing `images/screenshots/screenshot-mobile-N.png`.
 *
 * The mobile half of `screenshots.desktop-capture.integration.test.ts`, staged by the same closures. On a phone the
 * Search pane is a drawer over the note, so the search frames show the drawer.
 *
 * There is no mobile equivalent of the desktop viewport override, so the capture is always the device's own
 * framebuffer, and the AVD is built at exactly the 900x1600 the directory asks for: see `SCREENSHOT_AVD_NAME` in
 * `scripts/vitest-config.ts`.
 *
 * Excluded from `npm run test:integration` by its file name: see the `capture-screenshots:android` project in
 * `scripts/vitest-config.ts`. Capturing is an explicit operation (`npm run capture:screenshots`).
 */

import {
  mkdirSync,
  writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleepInNode } from 'node:timers/promises';
import {
  captureObsidianScreenshot,
  computeLabelBand,
  evalInObsidian,
  labelScreenshot,
  pollInObsidian,
  readPngDimensions
} from 'obsidian-integration-testing';
import { getTemporaryVault } from 'obsidian-integration-testing/vitest-global-setup-plugin';
import {
  beforeAll,
  describe,
  expect,
  it
} from 'vitest';

import type { ScreenshotStage } from './test-helpers/screenshot-stages.test.helper.ts';

import {
  isIndexReady,
  pollStage,
  reserveCaptionBand,
  startStage
} from './test-helpers/screenshot-stages.test.helper.ts';

const WIDTH_IN_PIXELS = 900;
const HEIGHT_IN_PIXELS = 1600;

/**
 * A cold-booted AVD renders its first view far more slowly than a warm desktop does.
 */
const RENDER_TIMEOUT_IN_MILLISECONDS = 120_000;

const TEST_TIMEOUT_IN_MILLISECONDS = 600_000;

const POLL_INTERVAL_IN_MILLISECONDS = 500;

/**
 * Time for a view or a modal to finish laying out after its content is ready.
 */
const SETTLE_DELAY_IN_MILLISECONDS = 1500;

const IMAGES_DIRECTORY = join(process.cwd(), 'images', 'screenshots');

beforeAll(async () => {
  await evalInObsidian({
    callback({ app }): void {
      app.changeTheme('obsidian');
      // Each note opens with its own `# H1`, so the inline title would print every name twice.
      app.vault.setConfig('showInlineTitle', false);
      // On a phone the drawers cover the note.
      app.workspace.leftSplit.collapse();
      app.workspace.rightSplit.collapse();
    },
    vaultPath: vaultPath()
  });
  await evalInObsidian({
    callback: reserveCaptionBand,
    input: { bandHeightInPixels: computeLabelBand({ imageHeightInPixels: HEIGHT_IN_PIXELS, imageWidthInPixels: WIDTH_IN_PIXELS }).heightInPixels },
    vaultPath: vaultPath()
  });
  await pollInObsidian({
    intervalInMilliseconds: POLL_INTERVAL_IN_MILLISECONDS,
    poll: isIndexReady,
    timeoutInMilliseconds: RENDER_TIMEOUT_IN_MILLISECONDS,
    timeoutMessage: 'the trigram index never caught up with every note',
    until: (isResolved: boolean): boolean => isResolved,
    vaultPath: vaultPath()
  });

  await sleepInNode(SETTLE_DELAY_IN_MILLISECONDS);
}, TEST_TIMEOUT_IN_MILLISECONDS);
describe('mobile store screenshots', () => {
  it('1 - a narrowed search in the Search pane', { timeout: TEST_TIMEOUT_IN_MILLISECONDS }, async () => {
    expect(await stage('search')).toBe('search');
    await shoot(1, 'Core Search reads only the notes that can match');
  });

  it('2 - operators and a regex', { timeout: TEST_TIMEOUT_IN_MILLISECONDS }, async () => {
    expect(await stage('operators')).toBe('operators');
    await shoot(2, 'Same query syntax, same results');
  });

  it('3 - the settings tab', { timeout: TEST_TIMEOUT_IN_MILLISECONDS }, async () => {
    expect(await stage('settings')).toBe('settings');
    await shoot(3, 'Turn narrowing off to compare');
  });
}); /**
 * Captures the device framebuffer, captions it, and writes it as `images/screenshots/screenshot-mobile-<index>.png`.
 *
 * The AVD is 900x1600, so the device frame IS the directory's size. Asserting it here keeps that true: run this
 * against any other AVD and it fails loudly instead of quietly shipping an off-spec image.
 *
 * @param index - The 1-based listing position.
 * @param caption - The caption drawn across the bottom of the frame.
 */

async function shoot(index: number, caption: string): Promise<void> {
  const bytes = await captureObsidianScreenshot({ vaultPath: vaultPath() });

  expect(readPngDimensions(bytes)).toStrictEqual({
    heightInPixels: HEIGHT_IN_PIXELS,
    widthInPixels: WIDTH_IN_PIXELS
  });

  // Captioned after capture, so the frame stays an untouched device screenshot and rewording a label needs no re-shoot.
  const labeled = await labelScreenshot(bytes, { text: caption });

  mkdirSync(IMAGES_DIRECTORY, { recursive: true });
  writeFileSync(join(IMAGES_DIRECTORY, `screenshot-mobile-${String(index)}.png`), labeled);
}

/**
 * Stages a frame and waits in Node until it shows what it is about.
 *
 * @param screenshotStage - The frame to stage.
 * @returns What the frame shows.
 */
async function stage(screenshotStage: ScreenshotStage): Promise<string> {
  const shown = await pollInObsidian({
    input: { stage: screenshotStage },
    intervalInMilliseconds: POLL_INTERVAL_IN_MILLISECONDS,
    poll: pollStage,
    start: startStage,
    timeoutInMilliseconds: RENDER_TIMEOUT_IN_MILLISECONDS,
    timeoutMessage: `the ${screenshotStage} frame never became ready`,
    until: (result: string): boolean => result === screenshotStage,
    vaultPath: vaultPath()
  });
  await sleepInNode(SETTLE_DELAY_IN_MILLISECONDS);
  return shown;
}

function vaultPath(): string {
  return getTemporaryVault().path;
}
