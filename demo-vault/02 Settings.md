# Settings

Every setting `Indexed Search` stores, listed by the **key it is written under in `data.json`** rather than by its display label — that is what you see when you open the file, hit a sync conflict, or read a support thread.

Find them in Obsidian under **Settings → Community plugins → `Indexed Search`**.

## General

- `shouldNarrowSearch`
  - on or off, shown in the settings tab as **Narrow core Search**; on by default. On, core Search and the [search API](<./03 For plugin developers.md>) read only the notes the index cannot rule out. Off, they read every note, exactly as without the plugin, so you can compare the speed of core Search alone, or rule the plugin out when a result surprises you. The index stays current either way, so turning it back on is instant.

## Try it

Turn narrowing off without leaving this note. The change applies to the next search, with no reload.

```code-button
---
caption: Turn shouldNarrowSearch off
---
await require('/demoSetup.ts').setShouldNarrowSearch(app, false);
```

Manual equivalent: turn off **Narrow core Search** in the settings tab.

Search now, and core Search reads every note:

```code-button
---
caption: Search for "lantern" with narrowing off
---
require('/demoSetup.ts').searchInPane(app, 'path:"Materials/01 Core Search" lantern');
```

Manual equivalent: type the same query into the Search pane (`Ctrl+Shift+F` / `Cmd+Shift+F`).

The results are the same as with narrowing on. When you are done, turn it back on:

```code-button
---
caption: Turn shouldNarrowSearch back on
---
await require('/demoSetup.ts').setShouldNarrowSearch(app, true);
```

Manual equivalent: turn **Narrow core Search** back on.
