# Core Search, narrowed

Core Search has no index: for every query it reads every note in the vault and runs its matcher on each one. On a vault of 37,000 notes that is half a second to a second per query, and more on a slow disk. `Indexed Search` makes it 4 to 5 times faster there, measured against core Search alone, with the same results.

## How it narrows

The plugin keeps every note's **trigrams**, its three-character sequences, in an index in IndexedDB. A note can only contain `lantern` if it contains `lan`, `ant`, `nte`, `ter` and `ern`, so the index can rule out every note missing one of them without reading it. Core Search then reads and checks only the notes left.

```code-button
---
caption: Search for "harbour lantern"
---
require('/demoSetup.ts').searchInPane(app, 'path:"Materials/01 Core Search" harbour lantern');
```

Manual equivalent: type the same query into the Search pane (`Ctrl+Shift+F` / `Cmd+Shift+F`).

The pane lists [Harbour lantern](<./Materials/01 Core Search/Harbour lantern.md>) and [Lantern repair](<./Materials/01 Core Search/Lantern repair.md>), and not [Meadow notes](<./Materials/01 Core Search/Meadow notes.md>), which core Search never had to read.

## Same query language

Nothing about the query changes. Phrases, `OR`, `-` for negation, parentheses, regular expressions, `file:`, `path:`, `tag:`, `content:`, `match-case:` and `ignore-case:` all narrow; the index works out which notes each part can match and combines them the way the query does.

```code-button
---
caption: Search for (/lant(e|er)n/ OR meadow)
---
require('/demoSetup.ts').searchInPane(app, 'path:"Materials/01 Core Search" (/lant(e|er)n/ OR meadow)');
```

Manual equivalent: type the same query into the Search pane.

The parentheses matter, as they do in core Search: without them, `OR` would join only its left side to the folder filter, and `meadow` would be searched across the whole vault.

## When the index steps aside

Some queries give the index nothing to check: a term of one or two characters, a regular expression such as `/\d+/` that needs no particular three characters, a query made only of negations, properties such as `[status:done]`, and the `line:`, `block:`, `section:` and task operators. Core Search then reads every note, exactly as it does without the plugin, so such a query is as fast as before and never slower.

```code-button
---
caption: Search for /\d+/
---
require('/demoSetup.ts').searchInPane(app, 'path:"Materials/01 Core Search" /\\d+/');
```

Manual equivalent: type the same query into the Search pane.

## Why the results never change

The index only ever rules notes out; core Search always decides. A note the index wrongly keeps costs a little time, and nothing else. So everything the index is unsure about stays in: canvas files, attachments, a note edited since it was indexed, and a note not indexed yet. A note you edit while a search runs is checked again by core Search, whatever the index said.

The index lives in IndexedDB, outside memory, and survives a restart or a crash: on the next start the plugin reads only the notes that changed. The first build on a 37,000-note vault takes about a minute and a half, and searches stay correct while it runs.
