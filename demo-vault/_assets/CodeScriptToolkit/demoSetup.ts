import type {
  App,
  TFile
} from 'obsidian';

import { configureCommunityPlugin } from '@mnaoumov/obsidian-lib/community-plugins';
import { findPluginApi } from '@mnaoumov/obsidian-lib/plugin/plugin-api';
import { Notice } from 'obsidian';

// Shared code for every `code-button` in this vault, so each note's button stays a one-liner instead of a
// Block copy-pasted across notes.
//
// The plugin id has to match `manifest.json` exactly: commands are keyed by it, and so is `data.json`.
const PLUGIN_ID = 'indexed-search';

// A copy of the part of the plugin's `api.d.ts` these buttons use, as a consumer would copy it.
interface IndexedSearchApi {
  search(query: string, options?: { readonly isCaseSensitive?: boolean }): Promise<{ readonly file: TFile }[]>;
}

/**
 * Opens the Search pane and runs the query in it, as if typed there.
 *
 * Manual equivalent: open the Search pane (`Ctrl+Shift+F` / `Cmd+Shift+F`) and type the query.
 */
export function searchInPane(app: App, query: string): void {
  const globalSearch = app.internalPlugins.getEnabledPluginById('global-search');
  if (!globalSearch) {
    new Notice('The Search pane is not available. Is the core Search plugin enabled?');
    return;
  }
  globalSearch.openGlobalSearch(query);
}

/**
 * Turns the plugin's `shouldNarrowSearch` on or off.
 *
 * `configureCommunityPlugin` routes through the plugin's own settings component while it is loaded, so the
 * change applies to the next search -- no window reload, and no writing `data.json` behind a running plugin's
 * back, which it would overwrite from memory as it unloads.
 *
 * Manual equivalent: switch **Narrow core Search** in **Settings -> Community plugins -> Indexed Search**.
 */
export async function setShouldNarrowSearch(app: App, shouldNarrowSearch: boolean): Promise<void> {
  await configureCommunityPlugin({ app, pluginId: PLUGIN_ID, settings: { shouldNarrowSearch } });
  new Notice(`shouldNarrowSearch is now ${String(shouldNarrowSearch)}. It applies to the next search.`);
}

/**
 * Runs a core Search query through the plugin's API and lists the matching files in a notice.
 *
 * Manual equivalent: type the same query into the Search pane.
 */
export async function showSearchHits(app: App, query: string, options?: { readonly isCaseSensitive?: boolean }): Promise<void> {
  const indexedSearchApi = findPluginApi<IndexedSearchApi>({
    apiVersionRange: '^1.0.0',
    pluginId: PLUGIN_ID
  });
  if (!indexedSearchApi) {
    new Notice('The Indexed Search API is not available. Is the plugin enabled?');
    return;
  }
  const hits = await indexedSearchApi.search(query, options);
  new Notice(hits.length === 0 ? `No file matches ${query}` : `${query} matches:\n${hits.map((hit) => hit.file.basename).join('\n')}`);
}
