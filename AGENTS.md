# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## Overview

`Indexed Search` makes Obsidian's core Search fast on large vaults, with exactly the results core gives. Core keeps its UI, its query syntax and its own matcher. The plugin only hands core the **candidate files** a query can possibly match, so core checks those instead of reading every file in the vault.

The candidates come from a **trigram index**, the technique of Google Code Search (Russ Cox, *Regular Expression Matching with a Trigram Index*, 2012). The index lives in IndexedDB, outside the JS heap, and survives restarts, crashes and forced quits without a full rebuild.

What already exists, so the plugin does not rebuild it:

- **`Omnisearch`** (`omnisearch`) keeps a persistent full-text index too, but behind its own fuzzy, ranked search box on MiniSearch, an in-memory inverted index. It does not change what core Search does, and its results are not core's.
- **`CFR Find`** (`cfr-find`), **`Power Explorer`** (`powerexplorer`), **`Lean Search`** (`lean-search`), **`VaultDex`** (`vaultdex`) and **`Vault Finder`** (`vault-finder`) are other separate search UIs with their own index or ranking.
- **`Native Search`** (`native-search`) answers from the operating system's own index (macOS Spotlight) in a separate UI.
- **`Core Search Assistant`** (`obsidian-core-search-assistant-plugin`), **`Better Search Views`** (`better-search-views`), **`Advanced search`** (`advanced-search`), **`Native Search Replace`** (`native-search-replace`), **`Better Search Result Views`** (`better-search-result-views`) and **`CJK Search`** (`cjk-search-probe`) extend core Search's interface or matching, but none makes it faster.

None of them speeds up core Search itself while keeping its results. That is this plugin's whole scope.

## Current state

The repo was generated on 2026-10-26 with `create-obsidian-plugin` (preset `all-in-one`, CSS, desktop and mobile, the unofficial API subset, no editor extensions). Its answers are in `.create-obsidian-plugin.json`, so re-running the generator in this folder updates every file not edited by hand. `src/` is still the generated sample; nothing below is built yet.

## Design

### Identical results, by construction

**The index only ever narrows; core always decides.** For each query the plugin computes a set of candidate files that is a SUPERSET of the files that match, and core's own matcher runs on those. A file the index wrongly includes costs time and nothing else. A file it wrongly excludes is a wrong result, so every rule below errs towards including.

- Find core Search's scan in `app.js` first (`obsidian-typings` may already declare it), and patch the step that lists the files to check. Do not reimplement the matcher, the query parser or the result rendering.
- Parse the query the way core does, from the same source text and flags. Any query part the plugin does not fully understand is "every file". That includes `line:`, `block:` and `section:` until each is shown to be safe to narrow, and anything new in a later Obsidian version.
- `file:`, `path:` and `tag:` narrow through the caches Obsidian already keeps, with no index of their own.
- An operator combines candidate sets the way the query combines matches: `AND` intersects, `OR` unites, and a negated term narrows nothing.

### The trigram index

- **Each file's set of 3-character sequences**, after the same case folding core Search applies (find it in `app.js`; do not assume `toLowerCase`), goes into a posting list per trigram.
- **Plain terms and quoted phrases** need every trigram of the term. Core matches SUBSTRINGS (`foo` finds `foobar` and `xfoo`), which a word index cannot narrow and a trigram index can.
- **A regex** is parsed with an existing parser (`regexp-tree` or `regjsparser`), not a hand-written one, and walked to derive the trigrams every match must contain, as an AND/OR expression: `/foo(bar|baz)\d+/` needs `foo` AND (`oba` AND `bar` OR `oba` AND `baz`). A regex with no required trigram, such as `/.*/`, `/\d+/` or a one- or two-character literal, falls back to core's full scan and writes one log line saying so, so a slow query is explainable.
- **A trigram present in almost every file** is stored as "every file", with no list.

### Memory is a hard budget

The target is a vault of 37,000 notes and 110 MB of text, and a search plugin that runs out of memory on it has failed. So:

- **Postings are compact:** files as integer ids, sorted and delta-encoded in typed arrays. No token positions, because core's matcher re-reads the candidates anyway. No copies of note text, no stored excerpts, no JS array of strings or `Map` per trigram.
- **The index is kept in IndexedDB, not in the heap:** one record per trigram (or per block of trigrams). A query reads only the records its own trigrams need.
- **Building never holds every file's text at once:** files are read, indexed and released in batches.
- **A budget is set up front** for peak and steady heap, and the performance tests fail when it is exceeded.

### Crash-safe persistence

The index must survive a crash or a forced quit with no full rebuild:

- Writes go in small transactions, so a kill loses at most the last batch.
- Each file's indexed `mtime` and `size` are stored with it. At startup only files whose `mtime` or `size` changed, or which are new or gone, are re-indexed.
- A damaged record is detected and only its part is rebuilt, with a log line.
- Until the index has caught up, a query falls back to core's full scan for the files not yet indexed, so results are never missing.

### Measured, not assumed

Every claim above is measured on a generated vault of the target size (37,000 notes, 110 MB of text, a share of it Cyrillic):

- heap at peak and at rest, build time, database size on disk;
- cold start after a kill mid-build and after a kill mid-update;
- query latency against core Search without the plugin, for plain terms, phrases and regex.

**The alternative is measured beside it:** keep every note's text in memory as UTF-8 in one shared buffer (about 110 MB) and brute-scan it in workers per query, the way `Everything`'s `content:` search answers instantly. It is exact by construction and its memory is predictable, but it holds all the text in the heap and has to fold non-Latin case over UTF-8 bytes. If it wins on the numbers, the plugin is built on it instead.

### Shared code

Obsidian's word class and case folding, the file-change pipeline (re-reading only files whose `mtime` or `size` changed, debounced saves) and the performance-vault generator already exist in `Advanced Metadata Cache` (`advanced-metadata-cache`). They are moved into `@mnaoumov/obsidian-lib` and consumed from there, never copied.
