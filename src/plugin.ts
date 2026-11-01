import type { PluginApiDeclaration } from '@mnaoumov/obsidian-lib/plugin/plugin-api';
import type { ObsidianSearchQuery } from '@obsidian-typings/obsidian-public-latest';
import type { Editor } from 'obsidian';

import { OpenBugReportCommandHandler } from '@mnaoumov/obsidian-lib/command-handlers/open-bug-report-command-handler';
import { OpenDemoVaultCommandHandler } from '@mnaoumov/obsidian-lib/command-handlers/open-demo-vault-command-handler';
import { PluginSettingsTabComponent } from '@mnaoumov/obsidian-lib/components/plugin-settings-tab-component';
import { PluginDataHandler } from '@mnaoumov/obsidian-lib/data-handler';
import { PluginBase } from '@mnaoumov/obsidian-lib/plugin/plugin';
import { PluginEventSourceImpl } from '@mnaoumov/obsidian-lib/plugin/plugin-event-source';
import { getObsidianSearchQueryConstructor } from '@obsidian-typings/obsidian-public-latest/implementations';
import { Notice } from 'obsidian';

import { IndexedSearchApiImpl } from './api/indexed-search-api-impl.ts';
import {
  PLUGIN_API_CONTRACT,
  PLUGIN_API_VERSION
} from './api/indexed-search-api.ts';
import { PluginSettingsComponent } from './plugin-settings-component.ts';
import { PluginSettingsTab } from './plugin-settings-tab.ts';
import { TrigramIndexComponent } from './trigram-index/trigram-index-component.ts';

export class Plugin extends PluginBase {
  /**
   * The vault's trigram index, which narrows core Search to the files a query can match.
   *
   * @returns The index component.
   * @throws If the plugin is not loaded.
   */
  public get trigramIndexComponent(): TrigramIndexComponent {
    if (!this.trigramIndexComponentValue) {
      throw new Error('The plugin is not loaded');
    }
    return this.trigramIndexComponentValue;
  }

  private indexedSearchApi: IndexedSearchApiImpl | null = null;
  private searchQueryConstructor: null | ReturnType<typeof getObsidianSearchQueryConstructor> = null;
  private trigramIndexComponentValue: null | TrigramIndexComponent = null;

  /**
   * Declares the API for the base to publish, once `onloadImpl` has built it.
   *
   * Published by the base rather than by hand: the `plugin-loaded` broadcast's `apiVersions` is derived from this
   * method alone, so a hand `publishPluginApi` call would announce this plugin as publishing no API at all.
   *
   * @returns The declaration, or none before the plugin has loaded.
   */
  protected override getPluginApis(): PluginApiDeclaration[] {
    return this.indexedSearchApi
      ? [
        {
          api: this.indexedSearchApi,
          apiVersion: PLUGIN_API_VERSION,
          contract: PLUGIN_API_CONTRACT
        }
      ]
      : [];
  }

  protected override async onloadImpl(): Promise<void> {
    this.indexedSearchApi = new IndexedSearchApiImpl({
      app: this.app,
      createQuery: this.createSearchQuery.bind(this)
    });

    this.trigramIndexComponentValue = this.addChild(
      new TrigramIndexComponent({
        app: this.app,
        pluginId: this.manifest.id
      })
    );

    const pluginSettingsComponent = this.addChild(
      new PluginSettingsComponent({
        dataHandler: new PluginDataHandler(this),
        pluginEventSource: new PluginEventSourceImpl(this)
      })
    );
    this.pluginSettingsComponent = pluginSettingsComponent;

    this.addChild(
      new PluginSettingsTabComponent({
        plugin: this,
        pluginSettingsTab: new PluginSettingsTab({
          plugin: this,
          pluginSettingsComponent
        })
      })
    );

    this.addCommand({
      callback: this.runSampleCommand.bind(this),
      id: 'sample',
      name: 'Sample'
    });

    this.addCommand({
      editorCallback: this.runSampleEditorCommand.bind(this),
      id: 'sample-editor',
      name: 'Sample editor'
    });

    // `OpenDemoVaultCommandHandler` is what makes the README's first demo-vault route real: it downloads
    // The `<plugin-id>-demo-vault.zip` attached to the GitHub release and opens it as a vault in
    // A new window. It is not registered automatically -- a demo vault without this command can only be
    // Reached by downloading the asset by hand. It hides itself on mobile, so no platform guard is needed.
    await this.commandHandlerComponent.registerCommandHandlers(() => [
      new OpenBugReportCommandHandler({
        app: this.app,
        gitHubRepo: 'mnaoumov/obsidian-indexed-search',
        pluginId: this.manifest.id
      }),
      new OpenDemoVaultCommandHandler({
        app: this.app,
        pluginId: this.manifest.id,
        pluginNoticeComponent: this.pluginNoticeComponent,
        pluginVersion: this.manifest.version
      })
    ]);
  }

  /**
   * Compiles a query with core Search's own query class, found once, on the first search: finding it opens and
   * closes a probe view, which is not worth doing at load for a plugin nobody may ask.
   *
   * @param query - The raw query.
   * @param isCaseSensitive - Whether the query matches case-sensitively.
   * @returns The compiled query.
   */
  private createSearchQuery(query: string, isCaseSensitive: boolean): ObsidianSearchQuery {
    this.searchQueryConstructor ??= getObsidianSearchQueryConstructor(this.app);
    return new this.searchQueryConstructor(this.app, query, isCaseSensitive);
  }

  private runSampleCommand(): void {
    new Notice('Sample command');
  }

  private runSampleEditorCommand(editor: Editor): void {
    editor.replaceSelection('Sample Editor Command');
  }
}
