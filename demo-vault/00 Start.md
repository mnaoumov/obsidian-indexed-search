# Start here

This is an [Obsidian](https://obsidian.md/) vault that documents the [Indexed Search](https://github.com/mnaoumov/obsidian-indexed-search/) plugin by demonstrating it. Every feature has a note that says what it does and why you would want it, and a button you can press to watch it happen.

On a large vault, core Search reads every note for every query, so a search takes a second or more. `Indexed Search` keeps a trigram index of your notes in IndexedDB and hands core Search only the notes a query can match. Core Search keeps its pane, its query syntax and its own matcher, so the results are exactly the ones it gives without the plugin.

## Your first minute

Below this paragraph is a **code button** — a captioned rectangle. It is not a picture of a button: **clicking it runs the code**, and the result appears underneath it. The `</>` toggle beside the caption reveals the code it runs, so nothing here is a black box.

```code-button
---
caption: Search for "lantern" in the Search pane
---
require('/demoSetup.ts').searchInPane(app, 'lantern');
```

The Search pane should have opened in the left sidebar with the notes that mention a lantern. That is core Search, answering the query you would type into it yourself; the plugin only chose which notes it had to read.

Every button in this vault also states its **manual equivalent**, so you learn the real steps rather than depending on the buttons. Here: open the Search pane (`Ctrl+Shift+F` / `Cmd+Shift+F`) and type `lantern`.

## Features

| Note | What it covers |
| --- | --- |
| [01 Core Search, narrowed](<./01 Core Search, narrowed.md>) | What the index narrows, what it leaves to core Search, and why the results never change. |
| [02 Settings](<./02 Settings.md>) | Every setting, by the key it is stored under in `data.json`. |
| [03 For plugin developers](<./03 For plugin developers.md>) | The `search(query)` API: core Search's own results, for other plugins and scripts. |

## Materials

`Materials/` holds the notes the walkthroughs operate on, so you never have to build a fixture to see a feature working.
