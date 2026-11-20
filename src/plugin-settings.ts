export class PluginSettings {
  /**
   * Whether core Search and the API match an `Excalidraw` note as if the data block under its `Drawing` heading were
   * blank, so a term found only in the drawing's JSON or base64 is no match. Off, they match it as core does.
   */
  public shouldIgnoreExcalidrawDrawings = false;

  /**
   * Whether core Search and the API read only the files the trigram index cannot rule out. Off, they read every
   * file, as without the plugin, while the index stays current.
   */
  public shouldNarrowSearch = true;
}
