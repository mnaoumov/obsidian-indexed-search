/**
 * @file
 *
 * Lets core Search ignore the drawing data of `Excalidraw` notes.
 *
 * An `Excalidraw` note keeps its whole scene as JSON, by default compressed to base64, in a fenced block under its
 * `Drawing` heading. Core Search matches that block like any other text, so a short term such as `cat` matches
 * every drawing whose base64 happens to hold it. The text of the drawing's elements is repeated as prose under
 * `Text Elements`, so the block holds nothing a person searches for.
 *
 * The mask replaces every character of the block's body except line breaks with a space. The text keeps its length
 * and its lines, so core's result ranges still point into the note as written, and `line:` sees the same lines.
 */

import type { ObsidianSearchQuery } from '@obsidian-typings/obsidian-public-latest';
import type {
  App,
  TFile
} from 'obsidian';

import { ensureNonNullable } from '@mnaoumov/typescript-lib/type-guards';

/**
 * The frontmatter key every `Excalidraw` note carries.
 */
const EXCALIDRAW_FRONTMATTER_KEY = 'excalidraw-plugin';

const FRONTMATTER_REGEX = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---(?:\r?\n|$)/;
const EXCALIDRAW_KEY_REGEX = /^excalidraw-plugin[ \t]*:/m;
const DRAWING_BLOCK_REGEX = /(?<head>^#{1,6}[ \t]+Drawing[ \t]*\r?\n```(?:compressed-json|json)[ \t]*\r?\n)(?<body>[\s\S]*?)\r?\n```/m;

/**
 * Tells whether a file may be an `Excalidraw` drawing, from the metadata cache. A note with no cache yet may be one.
 *
 * @param app - The application.
 * @param file - The file.
 * @returns Whether the file is a Markdown note that is, or may be, a drawing.
 */
export function canBeExcalidrawNote(app: App, file: TFile): boolean {
  if (file.extension !== 'md') {
    return false;
  }
  const cache = app.metadataCache.getFileCache(file);
  return !cache || cache.frontmatter?.[EXCALIDRAW_FRONTMATTER_KEY] !== undefined;
}

/**
 * Makes a compiled query match every note with its `Excalidraw` drawing data blanked. Core's scan calls the query's
 * own `match`, so the change reaches the Search pane as well as the API.
 *
 * @param searchQuery - The compiled query, changed in place.
 */
export function ignoreExcalidrawDrawings(searchQuery: ObsidianSearchQuery): void {
  const match = searchQuery.match.bind(searchQuery);
  searchQuery.match = (file, content): ReturnType<ObsidianSearchQuery['match']> => match(file, maskExcalidrawDrawing(content));
}

/**
 * Tells whether a note's text is an `Excalidraw` drawing, from its frontmatter.
 *
 * @param content - The note's text.
 * @returns Whether its frontmatter holds the `excalidraw-plugin` key.
 */
export function isExcalidrawContent(content: string): boolean {
  const frontmatter = FRONTMATTER_REGEX.exec(content)?.groups?.['frontmatter'];
  return frontmatter !== undefined && EXCALIDRAW_KEY_REGEX.test(frontmatter);
}

/**
 * Blanks the drawing data of an `Excalidraw` note, keeping the text's length and line breaks.
 *
 * @param content - The note's text.
 * @returns The text with the drawing block's body blanked, or the text unchanged when it is not a drawing.
 */
export function maskExcalidrawDrawing(content: string): string {
  if (!isExcalidrawContent(content)) {
    return content;
  }
  const block = DRAWING_BLOCK_REGEX.exec(content);
  if (!block) {
    return content;
  }
  const groups = ensureNonNullable(block.groups);
  const bodyStart = block.index + ensureNonNullable(groups['head']).length;
  const body = ensureNonNullable(groups['body']);
  return content.slice(0, bodyStart) + body.replaceAll(/[^\r\n]/g, ' ') + content.slice(bodyStart + body.length);
}
