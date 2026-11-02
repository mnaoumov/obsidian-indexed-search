/**
 * @file
 *
 * The staging closures the desktop and the Android capture suites share. Each frame is staged by `startStage`,
 * which sets it up and returns at once, and is read by `pollStage` until it shows what the frame needs, both
 * through `pollInObsidian`, so every wait happens in Node and no closure comes near the transport's per-eval cap.
 *
 * Both functions are serialized into Obsidian, so neither may reach anything outside its own body: every constant
 * and helper they use is declared inside them.
 */

import type { SearchView } from '@obsidian-typings/obsidian-public-latest/implementations';
import type { CommonArguments } from 'obsidian-integration-testing';

/**
 * What {@link reserveCaptionBand} is given.
 */
export interface ReserveCaptionBandInput {
  /**
   * The height of the caption band `labelScreenshot` draws over the bottom of the frame.
   */
  readonly bandHeightInPixels: number;
}

/**
 * A frame the capture suites can stage.
 */
export type ScreenshotStage = 'operators' | 'search' | 'settings';

/**
 * What a stage closure is given.
 */
export interface StageInput {
  /**
   * The frame to stage.
   */
  readonly stage: ScreenshotStage;
}

/**
 * Reads whether the trigram index has caught up with every note, so the frames show a narrowed search.
 *
 * @param params - The closure arguments.
 * @returns Whether every note is indexed with its current stats.
 */
export function isIndexReady({ app }: CommonArguments): boolean {
  interface TrigramIndex {
    readonly isVouched: (file: unknown) => boolean;
  }
  interface IndexedSearchPlugin {
    readonly trigramIndexComponent: TrigramIndex;
  }
  const plugin = app.plugins.getPlugin('indexed-search') as IndexedSearchPlugin | null;
  return plugin !== null && app.vault.getMarkdownFiles().every((file) => plugin.trigramIndexComponent.isVouched(file));
}

/**
 * Reads whether the staged frame is ready, and what it shows.
 *
 * @param params - The closure arguments.
 * @returns What the frame shows, or an empty string while it is not ready.
 */
export function pollStage({ app, stage }: CommonArguments & StageInput): string {
  const PLUGIN_ID = 'indexed-search';
  // Of the whole vault, only the sample notes hold these words: `lantern light` matches two of them, and
  // `/light(house|ship)/ OR thyme` all three.
  const RESULT_COUNTS: Record<'operators' | 'search', number> = { operators: 3, search: 2 };

  if (stage === 'settings') {
    return app.setting.activeTab?.id === PLUGIN_ID && app.setting.activeTab.containerEl.querySelector('.setting-item-name') ? 'settings' : '';
  }
  const view = app.workspace.getLeavesOfType('search')[0]?.view as SearchView | undefined;
  // The pane must be on screen too: a phone's drawer can hold the finished results while it is still closed.
  return view?.dom.resultDomLookup.size === RESULT_COUNTS[stage] && view.containerEl.querySelector('.search-result-file-match')
      && !app.workspace.leftSplit.collapsed && view.containerEl.isShown()
    ? stage
    : '';
}

/**
 * Lays the app out above the caption band rather than under it.
 *
 * `labelScreenshot` draws its band over the bottom of the frame, on the grounds that the bottom is chrome. Here the
 * band is kept clear of everything the app draws, so no frame loses its status bar or a phone its navigation bar.
 *
 * @param params - The closure arguments.
 */
export function reserveCaptionBand({ bandHeightInPixels, obsidianModule }: CommonArguments & ReserveCaptionBandInput): void {
  /*
   * The band is measured in the frame's pixels. A desktop frame is shot at one CSS pixel per pixel, but a phone's is
   * its framebuffer, at the device's pixel ratio.
   */
  const pixelRatio = obsidianModule.Platform.isMobile ? activeWindow.devicePixelRatio : 1;
  const band = `${String(bandHeightInPixels / pixelRatio)}px`;
  activeDocument.querySelector<HTMLElement>(':scope .app-container')?.setCssStyles({ height: `calc(100% - ${band})` });
  // The status bar and a phone's navigation bar are fixed to the viewport rather than laid out in the app, so they are
  // Lifted on their own.
  for (const el of activeDocument.querySelectorAll<HTMLElement>(':scope :is(.status-bar, .mobile-navbar)')) {
    el.setCssStyles({ bottom: band });
  }
}

/**
 * Stages a frame: dismisses whatever the last frame left open, then opens what the frame is about.
 *
 * @param params - The closure arguments.
 */
export async function startStage({ app, lib, obsidianModule, stage }: CommonArguments & StageInput): Promise<void> {
  const PLUGIN_ID = 'indexed-search';
  const MATERIALS_FOLDER = 'Materials/01 Core Search';
  const WAIT_TIMEOUT_IN_MILLISECONDS = 10_000;
  const DRAWER_SETTLE_DELAY_IN_MILLISECONDS = 1000;
  const { isMobile } = obsidianModule.Platform;

  await dismissLeftovers();

  switch (stage) {
    case 'operators': {
      await search('/light(house|ship)/ OR thyme', `${MATERIALS_FOLDER}/Meadow notes.md`);
      break;
    }
    case 'search': {
      await search('lantern light', `${MATERIALS_FOLDER}/Harbour lantern.md`);
      break;
    }
    case 'settings': {
      // On mobile the settings modal is not in the document until something attaches it.
      const { containerEl } = app.setting;
      if (!activeDocument.body.contains(containerEl)) {
        activeDocument.body.append(containerEl);
      }
      app.setting.open();
      app.setting.openTabById(PLUGIN_ID);
      // The tab keeps the scroll it had when it was last open, which differs between runs.
      app.setting.activeTab?.containerEl.scrollTo({ top: 0 });
      break;
    }
    default: {
      break;
    }
  }

  async function dismissLeftovers(): Promise<void> {
    if (activeDocument.body.contains(app.setting.containerEl)) {
      app.setting.close();
    }
    await lib.waitUntil({
      message: 'the last frame\'s modal to close',
      predicate: () => activeDocument.querySelector(':scope .modal-container') === null,
      timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
    });
    for (const el of activeDocument.querySelectorAll(':scope .menu, :scope .notice, :scope .tooltip')) {
      el.detach();
    }
  }

  /**
   * Opens a note in Reading view and runs the query in the Search pane, which core opens in the left sidebar, or on a
   * phone in its drawer over the note.
   */
  async function search(query: string, notePath: string): Promise<void> {
    /*
     * A phone's drawer left open by the last frame closes as the note opens, and a reopen issued while it is still
     * closing leaves the drawer showing nothing, so it is closed first and given time to finish.
     */
    if (isMobile && !app.workspace.leftSplit.collapsed) {
      app.workspace.leftSplit.collapse();
      await lib.waitUntil({
        message: 'the drawer to close',
        predicate: () => app.workspace.leftSplit.collapsed,
        timeoutInMilliseconds: WAIT_TIMEOUT_IN_MILLISECONDS
      });
      await sleep(DRAWER_SETTLE_DELAY_IN_MILLISECONDS);
    }
    await app.workspace.getLeaf(false).setViewState({ active: true, state: { file: notePath, mode: 'preview', source: false }, type: 'markdown' });
    const globalSearch = app.internalPlugins.getEnabledPluginById('global-search');
    if (!globalSearch) {
      throw new Error('Core Search is not enabled.');
    }
    globalSearch.openGlobalSearch(query);
    if (!isMobile) {
      app.workspace.leftSplit.expand();
    }
  }
}
