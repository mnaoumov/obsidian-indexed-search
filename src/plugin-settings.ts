export class PluginSettings {
  /**
   * Whether core Search and the API read only the files the trigram index cannot rule out. Off, they read every
   * file, as without the plugin, while the index stays current.
   */
  public shouldNarrowSearch = true;
}
