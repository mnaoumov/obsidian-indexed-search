import type {
  ObsidianSearchQuery,
  SearchMatchResult
} from '@obsidian-typings/obsidian-public-latest';
import type { TFile } from 'obsidian';

import { noopAsync } from '@mnaoumov/typescript-lib/function';
import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  beforeEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import type {
  SearchFileSelector,
  SearchQueryFactory
} from './indexed-search-api-impl.ts';

import { IndexedSearchApiImpl } from './indexed-search-api-impl.ts';

interface FakeQueryOptions {
  readonly isEmpty?: boolean;
  readonly match: (file: TFile, content: string) => null | SearchMatchResult;
  readonly needsContent?: boolean;
}

function fakeQuery(options: FakeQueryOptions): ObsidianSearchQuery {
  return castTo<ObsidianSearchQuery>({
    match: options.match,
    matcher: options.isEmpty ? null : {},
    requiredInputs: options.isEmpty ? null : { content: options.needsContent ?? true }
  });
}

describe('IndexedSearchApiImpl', () => {
  let app: App;
  let ignoredPaths: Set<string>;

  beforeEach(() => {
    app = App.createConfigured__();
    ignoredPaths = new Set();
    // The mock does not implement core's ignore list, which the scan consults for every file.
    Object.assign(app.metadataCache, { isUserIgnored: (path: string): boolean => ignoredPaths.has(path) });
  });

  function createApi(createQuery: SearchQueryFactory, selectFiles: SearchFileSelector = async (_searchQuery, files) => {
    await noopAsync();
    return [...files];
  }): IndexedSearchApiImpl {
    return new IndexedSearchApiImpl({ app: castTo(app), createQuery, selectFiles });
  }

  function contentMatcher(term: string): (file: TFile, content: string) => null | SearchMatchResult {
    return (_file, content) => {
      const index = content.indexOf(term);
      return index === -1 ? null : { content: [[index, index + term.length]] };
    };
  }

  it('should answer the files core\'s matcher accepts, ordered by path', async () => {
    app.vault.createSync__('b.md', 'alpha beta');
    app.vault.createSync__('a.md', 'say alpha');
    app.vault.createSync__('c.md', 'gamma');

    const hits = await createApi(() => fakeQuery({ match: contentMatcher('alpha') })).search('alpha');

    expect(hits.map((hit) => [hit.file.path, hit.match])).toEqual([
      ['a.md', { content: [[4, 9]] }],
      ['b.md', { content: [[0, 5]] }]
    ]);
  });

  it('should check only the files the selector keeps, handing it the compiled query', async () => {
    app.vault.createSync__('a.md', 'alpha');
    app.vault.createSync__('b.md', 'alpha too');
    const searchQuery = fakeQuery({ match: contentMatcher('alpha') });
    const selectFiles = vi.fn<SearchFileSelector>(async (_searchQuery, files) => {
      await noopAsync();
      return files.filter((file) => file.path !== 'b.md');
    });

    const hits = await createApi(() => searchQuery, selectFiles).search('alpha');

    expect(hits.map((hit) => hit.file.path)).toEqual(['a.md']);
    expect(selectFiles.mock.calls[0]?.[0]).toBe(searchQuery);
  });

  it('should pass the query and the case setting to core\'s query class', async () => {
    const createQuery = vi.fn<SearchQueryFactory>(() => fakeQuery({ isEmpty: true, match: () => null }));
    const api = createApi(createQuery);

    await api.search('alpha');
    await api.search('Beta', { isCaseSensitive: true });

    expect(createQuery.mock.calls).toEqual([['alpha', false], ['Beta', true]]);
  });

  it('should answer nothing for a query core compiles to no matcher', async () => {
    app.vault.createSync__('a.md', 'alpha');
    const match = vi.fn(() => ({}));

    expect(await createApi(() => fakeQuery({ isEmpty: true, match })).search('  ')).toEqual([]);
    expect(match).not.toHaveBeenCalled();
  });

  it('should reject with core\'s error for a query core rejects', async () => {
    const api = createApi(() => {
      throw new Error('Operator "nope" not recognized');
    });

    await expect(api.search('nope:alpha')).rejects.toThrow('Operator "nope" not recognized');
  });

  it('should skip the files core ignores and read text only when the query needs it', async () => {
    app.vault.createSync__('kept.md', 'alpha');
    app.vault.createSync__('ignored.md', 'alpha');
    app.vault.createSync__('image.png', 'alpha');
    ignoredPaths.add('ignored.md');
    const contents: [string, string][] = [];
    function match(file: TFile, content: string): SearchMatchResult {
      contents.push([file.path, content]);
      return {};
    }

    await createApi(() => fakeQuery({ match, needsContent: false })).search('file:alpha');
    expect(contents).toEqual([['kept.md', '']]);

    contents.length = 0;
    await createApi(() => fakeQuery({ match })).search('alpha');
    expect(contents).toEqual([['kept.md', 'alpha']]);
  });

  it('should match an unreadable file as empty text, as core does', async () => {
    app.vault.createSync__('a.md', 'alpha');
    const error = new Error('read failed');
    vi.spyOn(app.vault, 'cachedRead').mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const contents: string[] = [];

    await createApi(() =>
      fakeQuery({
        match: (_file, content) => {
          contents.push(content);
          return null;
        }
      })
    ).search('alpha');

    expect(contents).toEqual(['']);
    expect(consoleError).toHaveBeenCalledWith(error);
  });

  it('should copy every kind of range core reports into the published shape', async () => {
    app.vault.createSync__('a.md', 'alpha');
    const result = castTo<SearchMatchResult>({
      'canvas-n1': [[0, 3]],
      'canvas-n2': undefined,
      'content': [[1, 2]],
      'filename': [[0, 5]],
      'filepath': [[2, 4]],
      'properties': [{ key: 'status' }, { key: 'tags', pos: [0, 4], subkey: [0] }],
      'tag': [[0, 1]]
    });

    const [hit] = await createApi(() => fakeQuery({ match: () => result })).search('alpha');

    expect(hit?.match).toEqual({
      canvasNodes: { n1: [[0, 3]] },
      content: [[1, 2]],
      filename: [[0, 5]],
      filepath: [[2, 4]],
      properties: [{ key: 'status' }, { key: 'tags', range: [0, 4] }]
    });
  });

  it('should stop when its signal is aborted', async () => {
    app.vault.createSync__('a.md', 'alpha');
    const controller = new AbortController();
    const reason = new Error('stopped');
    controller.abort(reason);

    await expect(createApi(() => fakeQuery({ match: () => ({}) })).search('alpha', { abortSignal: controller.signal })).rejects.toBe(reason);
  });

  it('should stop between files when its signal is aborted mid-scan', async () => {
    app.vault.createSync__('a.md', 'alpha');
    app.vault.createSync__('b.md', 'alpha');
    const controller = new AbortController();
    const reason = new Error('stopped');
    const seen: string[] = [];

    const search = createApi(() =>
      fakeQuery({
        match: (file) => {
          seen.push(file.path);
          controller.abort(reason);
          return {};
        }
      })
    ).search('alpha', { abortSignal: controller.signal });

    await expect(search).rejects.toBe(reason);
    expect(seen).toHaveLength(1);
  });

  it('should let the UI breathe during a long scan', async () => {
    app.vault.createSync__('a.md', 'alpha');
    app.vault.createSync__('b.md', 'alpha');
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const sleepSpy = vi.spyOn(window, 'sleep');

    await createApi(() =>
      fakeQuery({
        match: () => {
          now += 1000;
          return null;
        }
      })
    ).search('alpha');

    expect(sleepSpy).toHaveBeenCalledWith(0);
  });
});
