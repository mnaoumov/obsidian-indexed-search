import type { ObsidianSearchQuery } from '@obsidian-typings/obsidian-public-latest';
import type {
  CachedMetadata,
  TFile
} from 'obsidian';

import { castTo } from '@mnaoumov/typescript-lib/object-utils';
import { App } from 'obsidian-test-mocks/obsidian';
import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  canBeExcalidrawNote,
  ignoreExcalidrawDrawings,
  isExcalidrawContent,
  maskExcalidrawDrawing
} from './excalidraw-drawing.ts';

const DRAWING = '---\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n---\n# Excalidraw Data\n## Text Elements\nA cat on a key ^abc\n\n%%\n## Drawing\n```compressed-json\n'
  + 'N4KAkARALgngDgUwgLgAQQQDwMYEMA2AlgCYBOuA7hADTgQBuCpAzoQPYB2KqATLZMzYBXUtiRoIACyhQ4zZAHoFAc0JRJQgEYA6bGwC2\n'
  + 'catKEYmanXYZ\n```\n%%\n';

describe('isExcalidrawContent', () => {
  it('recognizes a note by the excalidraw-plugin key of its frontmatter', () => {
    expect(isExcalidrawContent(DRAWING)).toBe(true);
    expect(isExcalidrawContent('---\r\nexcalidraw-plugin : raw\r\n---\r\nbody')).toBe(true);
    expect(isExcalidrawContent('---\nexcalidraw-plugin: parsed\n---')).toBe(true);
  });

  it('rejects a note with no frontmatter, another key, or the key only in the body', () => {
    expect(isExcalidrawContent('excalidraw-plugin: parsed')).toBe(false);
    expect(isExcalidrawContent('---\ntitle: excalidraw-plugin\n---\nbody')).toBe(false);
    expect(isExcalidrawContent('---\ntitle: x\n---\nexcalidraw-plugin: parsed')).toBe(false);
  });
});

describe('maskExcalidrawDrawing', () => {
  it('blanks the drawing block body, keeping the length, the lines and the rest of the note', () => {
    const masked = maskExcalidrawDrawing(DRAWING);

    expect(masked).toHaveLength(DRAWING.length);
    expect(masked.split('\n')).toHaveLength(DRAWING.split('\n').length);
    expect(masked).toContain('A cat on a key ^abc');
    expect(masked).toContain('## Drawing\n```compressed-json\n ');
    expect(masked).not.toContain('catKEY');
    expect(masked).not.toContain('N4KA');
  });

  it('blanks an uncompressed json block and keeps CRLF line breaks', () => {
    const content = '---\r\nexcalidraw-plugin: parsed\r\n---\r\n# Drawing\r\n```json\r\n{"type":"cat"}\r\n{}\r\n```\r\n';

    expect(maskExcalidrawDrawing(content)).toBe('---\r\nexcalidraw-plugin: parsed\r\n---\r\n# Drawing\r\n```json\r\n              \r\n  \r\n```\r\n');
  });

  it('leaves a note that is not a drawing, or a drawing with no data block, unchanged', () => {
    const plain = '## Drawing\n```compressed-json\ncat\n```\n';
    expect(maskExcalidrawDrawing(plain)).toBe(plain);
    const empty = '---\nexcalidraw-plugin: parsed\n---\n## Text Elements\ncat\n';
    expect(maskExcalidrawDrawing(empty)).toBe(empty);
  });
});

describe('canBeExcalidrawNote', () => {
  it('reads the frontmatter from the metadata cache, and counts a note with no cache as maybe', () => {
    const app = App.createConfigured__();
    const caches: Record<string, CachedMetadata | null> = {
      'drawing.md': castTo<CachedMetadata>({ frontmatter: { 'excalidraw-plugin': 'parsed' } }),
      'note.md': castTo<CachedMetadata>({ frontmatter: { title: 'x' } }),
      'plain.md': castTo<CachedMetadata>({}),
      'unparsed.md': null
    };
    vi.spyOn(app.metadataCache, 'getFileCache').mockImplementation((file) => caches[file.path] ?? null);

    expect(['drawing.md', 'note.md', 'plain.md', 'unparsed.md', 'board.canvas'].map((path) => canBeExcalidrawNote(app.asOriginalType__(), fakeFile(path))))
      .toEqual([true, false, false, true, false]);
  });
});

describe('ignoreExcalidrawDrawings', () => {
  it('makes the query match the masked text, with the query as this', () => {
    const calls: [unknown, string][] = [];
    const searchQuery = castTo<ObsidianSearchQuery>({
      match(this: unknown, _file: TFile, content: string) {
        calls.push([this, content]);
        return content.includes('cat') ? {} : null;
      }
    });
    const note = castTo<TFile>({ extension: 'md', path: 'drawing.md' });

    ignoreExcalidrawDrawings(searchQuery);

    expect(searchQuery.match(note, DRAWING)).toEqual({});
    expect(searchQuery.match(note, DRAWING.replace('A cat on', 'A dog on'))).toBeNull();
    expect(calls.every(([self]) => self === searchQuery)).toBe(true);
    expect(calls[0]?.[1]).toBe(maskExcalidrawDrawing(DRAWING));
  });
});

function fakeFile(path: string): TFile {
  return castTo<TFile>({ extension: path.split('.').at(-1), path });
}
