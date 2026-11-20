import type { PluginApiDeclaration } from '@mnaoumov/obsidian-lib/plugin/plugin-api';
import type { PluginManifest } from 'obsidian';

import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { getObsidianSearchQueryConstructor } from '@obsidian-typings/obsidian-public-latest/implementations';
import { Plugin as ObsidianPlugin } from 'obsidian';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type { IndexedSearchApi } from '../api.d.ts';

import {
  PLUGIN_API_CONTRACT,
  PLUGIN_API_VERSION
} from './api/indexed-search-api.ts';
import { Plugin } from './plugin.ts';
import { TrigramIndexComponent } from './trigram-index/trigram-index-component.ts';

vi.mock('@obsidian-typings/obsidian-public-latest/implementations', async (importOriginal) => ({
  ...await importOriginal<object>(),
  getObsidianSearchQueryConstructor: vi.fn(),
  // No node is recognized, so every query narrows nothing.
  getSearchMatcherGuards: vi.fn(() => new Proxy({}, { get: () => (): boolean => false }))
}));

const manifest = castTo<PluginManifest>({
  author: 'test',
  description: 'test',
  // eslint-disable-next-line unicorn/name-replacements -- `dir` is an Obsidian `PluginManifest` member name.
  dir: 'plugins/indexed-search',
  id: 'indexed-search',
  minAppVersion: '1.0.0',
  name: 'Indexed Search',
  version: '1.0.0'
});

interface PluginApis {
  readonly getPluginApis: () => PluginApiDeclaration[];
}

describe('IndexedSearch', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    app = App.createConfigured__();
  });

  it('extends the Obsidian Plugin class', () => {
    expect(Plugin.prototype).toBeInstanceOf(ObsidianPlugin);
  });

  it('has no index and publishes no API before it loads', () => {
    const plugin = new Plugin(app.asOriginalType__(), manifest);

    expect(() => plugin.trigramIndexComponent).toThrow('The plugin is not loaded');
    expect(castTo<PluginApis>(plugin).getPluginApis()).toEqual([]);
  });

  it('builds the index and publishes the search API once loaded', async () => {
    const plugin = new Plugin(app.asOriginalType__(), manifest);
    await plugin.onload();

    expect(plugin.trigramIndexComponent).toBeInstanceOf(TrigramIndexComponent);
    const [declaration] = castTo<PluginApis>(plugin).getPluginApis();
    expect(declaration).toMatchObject({ apiVersion: PLUGIN_API_VERSION, contract: PLUGIN_API_CONTRACT });
    plugin.unload();
  });

  it('compiles API queries with core Search\'s own query class, found once', async () => {
    const queryConstructor = vi.fn(function FakeQuery(this: object, _app: unknown, query: string, _isCaseSensitive: boolean) {
      Object.assign(this, { match: () => null, matcher: query ? {} : null, query, requiredInputs: { content: true } });
    });
    vi.mocked(getObsidianSearchQueryConstructor).mockReturnValue(castTo(queryConstructor));
    app.vault.createSync__('a.md', 'quillwort');
    // The mock does not implement core's ignore list, which the scan consults for every file.
    Object.assign(app.metadataCache, { isUserIgnored: (): boolean => false });
    const plugin = new Plugin(app.asOriginalType__(), manifest);
    await plugin.onload();
    const [declaration] = castTo<PluginApis>(plugin).getPluginApis();
    const api = castTo<IndexedSearchApi>(declaration?.api);

    expect(await api.search('quillwort')).toEqual([]);
    expect(await api.search('', { isCaseSensitive: true })).toEqual([]);

    expect(getObsidianSearchQueryConstructor).toHaveBeenCalledOnce();
    expect(queryConstructor.mock.calls.map(([, query, isCaseSensitive]) => [query, isCaseSensitive])).toEqual([
      ['quillwort', false],
      ['', true]
    ]);
    plugin.unload();
  });

  it('compiles API queries that ignore Excalidraw drawing data once the setting is on', async () => {
    const queryConstructor = vi.fn(function FakeQuery(this: object, _app: unknown, query: string) {
      Object.assign(this, {
        match: (_file: unknown, content: string) => content.includes(query) ? {} : null,
        matcher: {},
        query,
        requiredInputs: { content: true }
      });
    });
    vi.mocked(getObsidianSearchQueryConstructor).mockReturnValue(castTo(queryConstructor));
    app.vault.createSync__('drawing.md', '---\nexcalidraw-plugin: parsed\n---\n## Drawing\n```compressed-json\n+cat+\n```\n');
    Object.assign(app.metadataCache, { isUserIgnored: (): boolean => false });
    const plugin = new Plugin(app.asOriginalType__(), manifest);
    vi.spyOn(plugin, 'loadData').mockResolvedValue({ shouldIgnoreExcalidrawDrawings: true });
    await plugin.onload();
    const [declaration] = castTo<PluginApis>(plugin).getPluginApis();
    const api = castTo<IndexedSearchApi>(declaration?.api);

    expect(await api.search('cat')).toEqual([]);
    expect(await api.search('compressed')).toHaveLength(1);
    plugin.unload();
  });
});
