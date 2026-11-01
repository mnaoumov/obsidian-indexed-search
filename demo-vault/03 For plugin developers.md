# For plugin developers

Core Search has no API: a plugin or a script that wants Search's answer has had to scrape the result pane. `Indexed Search` publishes one, through the `@mnaoumov/obsidian-lib` plugin registry: `search(query)` takes a query written exactly as you would type it into the Search pane and answers the files the pane would list.

It does not reimplement Search. The query is compiled by core Search's own parser, and every file the trigram index cannot rule out is checked by core Search's own matcher, so `file:`, `path:`, `tag:`, `line:`, `section:`, `[property:value]`, regular expressions, `match-case:` and every other operator mean exactly what they mean in the pane. The plugin's test suite runs a corpus of such queries through both and fails on any difference.

Everything a consumer needs is declared in the plugin's repo-root `api.d.ts`, which imports nothing but `obsidian`, with its contract in `api-contract.ts`. Copy them, or copy the few lines you use. The buttons below run exactly the calls a consumer makes, with a copy of those declarations in this vault's `demoSetup.ts`.

## Run a query

The three notes in [Materials/03 Search API](<./Materials/03 Search API/Harbour walk.md>) plant a few words. Ask for the notes that mention the lantern but not quillwort:

```code-button
---
caption: Search "lantern -quillwort"
---
await require('/demoSetup.ts').showSearchHits(app, 'path:"Materials/03 Search API" lantern -quillwort');
```

Manual equivalent: type the same query into the Search pane (`Ctrl+Shift+F` / `Cmd+Shift+F`).

The notice names [Meadow walk](<./Materials/03 Search API/Meadow walk.md>), the one note the pane lists too.

## Case and operators

By default a query ignores case, as the pane does. Pass `{ isCaseSensitive: true }` for the pane's **Match case** toggle; `match-case:` and `ignore-case:` in the query override it, as they do there.

```code-button
---
caption: Search "QUILLWORT", matching case
---
await require('/demoSetup.ts').showSearchHits(app, 'path:"Materials/03 Search API" QUILLWORT', { isCaseSensitive: true });
```

Manual equivalent: turn on **Match case** in the Search pane and type the same query.

Only [Quillwort survey](<./Materials/03 Search API/Quillwort survey.md>) matches: [Harbour walk](<./Materials/03 Search API/Harbour walk.md>) writes the word in lower case.

Operators work the same way. This one asks for open tasks that mention quillwort:

```code-button
---
caption: Search "task-todo:quillwort"
---
await require('/demoSetup.ts').showSearchHits(app, 'path:"Materials/03 Search API" task-todo:quillwort');
```

Manual equivalent: type the same query into the Search pane.

## What comes back

`search` resolves to the matching files, ordered by path. Each hit carries the `file` and a `match` saying where the query matched: `content`, `filename` and `filepath` ranges as `[start, end]` offsets, matched `properties`, and for a canvas the ranges inside each text card under `canvasNodes`. An empty query answers nothing. A query the pane rejects, such as an unknown operator, rejects with the same error, and an `abortSignal` option stops a long search.
