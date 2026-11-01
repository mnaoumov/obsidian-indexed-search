# AGENTS.md

This file provides guidance to AI coding agents working with code in this repository.

## Filing an issue (for AI agents and humans)

Open issues through the [issue forms](https://github.com/mnaoumov/obsidian-indexed-search/issues/new/choose), not as blank issues.

Filing from the CLI or the API (`gh issue create --body`, or an AI agent filing for you) skips the form, and `gh issue create --template` cannot load an issue form. In that case, open the matching form in [`.github/ISSUE_TEMPLATE/`](https://github.com/mnaoumov/obsidian-indexed-search/tree/HEAD/.github/ISSUE_TEMPLATE), copy every field as a `### <label>` heading in the form's order, and fill in each one. Always state the plugin version, the Obsidian version and your operating system.

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

The repo was generated on 2026-10-26 with `create-obsidian-plugin` (preset `all-in-one`, CSS, desktop and mobile, the unofficial API subset, no editor extensions). Its answers are in `.create-obsidian-plugin.json`, so re-running the generator in this folder updates every file not edited by hand. Apart from the index, the plugin (`src/main.ts`, `src/plugin*.ts`) is still the generated sample. `src/prototypes/` holds the two measured engine prototypes and their benchmark; the engine is chosen, and the numbers are in "Engine decision" below.

**Built:** the persistent trigram index, in `src/trigram-index/` (see "The index as built" below). The plugin opens it at layout ready and keeps it current. The public API, in `src/api/` (see "The search API" below). **Not built yet:** the core-Search hook and the query translation that feed it, so the index narrows nothing a user sees yet.

## Design

### Identical results, by construction

**The index only ever narrows; core always decides.** For each query the plugin computes a set of candidate files that is a SUPERSET of the files that match, and core's own matcher runs on those. A file the index wrongly includes costs time and nothing else. A file it wrongly excludes is a wrong result, so every rule below errs towards including.

- Find core Search's scan in `app.js` first (`obsidian-typings` may already declare it), and patch the step that lists the files to check. Do not reimplement the matcher, the query parser or the result rendering.
- Parse the query the way core does, from the same source text and flags. Any query part the plugin does not fully understand is "every file". That includes `line:`, `block:` and `section:` until each is shown to be safe to narrow, and anything new in a later Obsidian version.
- `file:`, `path:` and `tag:` narrow through the caches Obsidian already keeps, with no index of their own.
- An operator combines candidate sets the way the query combines matches: `AND` intersects, `OR` unites, and a negated term narrows nothing.

### Core Search source map

Verified on 2026-10-26 against `obsidian-versions` tags `1.14.5` (`f0c295ba5d3f2de04d8322c65d139a3dfaf7988a`, public) and `catalyst/1.15.0` (`1842097e7affb46f287201499717b8f43513fc85`). The [official release manifest](https://github.com/obsidianmd/obsidian-releases/blob/master/desktop-releases.json) named those versions on that date. All line numbers below refer to `app.js` inside the extracted application at the named tag, not the moving checkout. Public uses transpiled prototype methods; catalyst uses classes. Symbol names are source landmarks, never runtime API names to hard-code.

1. **Entry point:** `SearchView.startSearch` (public line 157661, catalyst 127957) stops the old search, empties results, compiles the raw search input with the current `matchingCase`, stores `searchQuery`, calls `this.queue.start({ onStop })`, and hands its returned queue to the scan. Its callback calls the compiled query's `match(file, content)` and the existing result DOM's `addResult` / `removeResult`.
2. **File-list hook:** the component held by `SearchView.queue`, public `Gj` (117706), catalyst `tf` (99809). Its `start(options)` creates an `ItemQueue<TFile>` (public `GT`, catalyst `qn`), obtains `app.vault.getFiles()`, sorts by the result DOM's sort order, calls `queue.addList(files)`, and returns that queue synchronously. This is the exact candidate-list insertion point. It is also used by other core result panes: patch the specific search view's component instance, never the shared prototype or `Vault.getFiles` globally.
3. **Consumer:** public `VL` (84515), catalyst `_b` (72960) consumes `queue.generator()`, applies `metadataCache.isUserIgnored` and `isSupportedFile`, reads Markdown/canvas through `vault.cachedRead` only when `requiredInputs.content` is true, checks cancellation, then calls the original match/render callback. Preserve this path, including read errors and cooperative pauses; this closure-local function is not itself a reachable patch target.
4. **Live changes:** the queue component listens for vault create/modify/rename/delete and metadata-cache changed events. It adds changed files to its current queue and removes deleted files/results. The queue generator waits after exhaustion, and resumes when files arrive. Filtering its generator forever would hide later edits and leave stale results. Narrow only the initial batch; keep subsequent additions unfiltered so core can remove an old match as well as add a new one.

The proposed wrapper keeps core's `start` intact: temporarily intercept only that component's result queue's initial `addList`, filter its file argument, and restore the interception immediately in `finally` before any later event-driven additions. Since the result queue is created inside `start`, a practical alternative is a synchronous, tightly scoped wrapper of the `ItemQueue` prototype's `addList` during the original call, gated by identity (`this === component.queue`) and the first batch only, with unconditional restoration. Do not await while any shared method is intercepted. Preserve the queue, callbacks, sorting, generator, cancellation and return value. This is an implementation proposal derived from the traced call order; it still needs real-app lifecycle and multi-pane tests before shipping. An unsupported shape must run the original full scan.

IndexedDB reads cannot fit inside that synchronous hook. Resolve candidate postings before restarting Search, with a query/version token that discards stale completions. While candidates are unavailable, let core run normally. When they are ready, restart through the original `startSearch` and filter only if the raw query, case setting and index generation still match. Include every file not yet indexed or marked dirty; a concurrent edit must invalidate its exclusion before the index update completes. Do not replace core's parser or hold a temporary global patch across an asynchronous operation.

### Query tree and exact matching behavior

Core's query constructor is public `NL` (84406), catalyst `Sr` (72870). Its tokenizer is public `CL` (83849), catalyst `jO` (72469); parser entry is public `gL` (83697), catalyst `GO` (72315), with OR / implicit AND / primary parsing in public `mL` / `yL` / `bL`, catalyst `c4` / `RTe` / `a4`. Read the already compiled `searchQuery.matcher`; do not build a second query grammar. The exported `prepareQuery` (catalyst `qi`, 66044) is a different, accent-normalizing fuzzy-search helper and is **not** this parser or this search's case folding.

1. Bare text becomes an escaped substring regex (public `cL`, catalyst `xd`). Quoted text becomes public `lL`, catalyst `ug`: it stores `text`, `partialMatchRegex` and `wholeWordRegex`. In content it uses the latter, made by public `GI` / catalyst `Wb`, with core's custom letter/digit boundary class and a captured literal. In filenames it uses the partial regex. Thus quoted content has boundary semantics; treating it as a required substring is safe, but treating it as core's exact matcher is wrong.
2. Regex tokens become public `aL`, catalyst `l4`, storing the token's `regex` source. The tokenizer removes slash delimiters and unescapes `\/`; it preserves other regex escapes. It does not parse trailing JavaScript flags: `/foo/i` is a regex followed by a plain `i` term. Validation calls `new RegExp(source)`; matching uses the flags below. Derive regex trigrams from that stored source, never from a hand-sliced query string.
3. Adjacent terms are AND (public `hL`, catalyst `FO`); uppercase `OR` unites AND groups (public `pL`, catalyst `RO`); parentheses group; `-` wraps negation (public `vL`, catalyst `HO`). `AND` is ordinary text, not a reserved token. Composite nodes expose `matchers`; unary nodes expose `matcher`. Core distinguishes `null` (no match), `undefined` (cannot decide in this context), and a result object (including `{}`). Candidate logic must preserve conservative unknown behavior, not apply ordinary JavaScript truthiness to those three values.
4. Operator names are lowercased for lookup. The operator table (public `BL`, catalyst `$O`, 72847) contains `match-case`, `ignore-case`, `path`, `file`, `content`, `line`, `block`, `section`, `task`, `task-todo`, `task-done`, and `tag`. Scope wrappers clone the match context and change its keys; case wrappers override its case setting for their subtree. Exclusive scope nesting is checked by core; `section` permits self nesting. Unknown operators throw, and the view displays the error. Preserve this behavior; an unrecognized compiled node means every file to the accelerator.
5. Square brackets compile a property matcher (`key`, optional `value`); boolean `TRUE`, `FALSE`, `EMPTY` and property comparisons also have nodes. Keep properties, task filters and all scoped content operators conservative until separately proven. `line` splits on LF; `block` uses cached sections/list items; `section` uses cached heading offsets. None is a plain whole-file conjunction.
6. `file:` selects the full file name including its extension, `path:` the vault-relative path. `tag:` accepts only an unquoted text node, ensures a leading `#`, and matches cached frontmatter and inline tags with `^<escaped-tag>($|\/)` and `i` (also matching descendants). It ignores the query's case setting. Use core-equivalent cache predicates; generic string equality is insufficient.

### Case folding and the candidate universe

Core does **not** lowercase note text for ordinary Search. Regex construction is public `rL` (83348), catalyst `goe` (72057): `new RegExp(source, caseSensitive ? 'gm' : 'gmi')`. No `u` or `s` flag is added. Each scan resets `lastIndex`; empty regex matches are skipped. `match-case:` and `ignore-case:` override the view setting in nested contexts. Property-name equality is a separate `toLowerCase()` comparison, and tag matching always uses `i`.

Consequently the trigram fold must model ECMAScript **non-Unicode ignore-case canonicalization over UTF-16 code units**, not whole-string `toLowerCase`, locale folding, Unicode normalization or fuzzy `prepareQuery`. Lowercasing falsely separates Greek final sigma from sigma, whereas `/σ/i` matches `ς`. Conversely `/k/i` does not match Kelvin sign `K`, while lowercasing it yields `k`. Whole-string lowercasing can also change length or depend on context. A conservative fold may introduce extra collisions, but must never split characters core equates; if the shared library cannot prove this, fall back for those terms. Case-sensitive and case-insensitive subtrees need their own safe candidate treatment, including regex character classes/ranges and unsupported constructs.

The initial universe is **all core-supported files**, not only `vault.getMarkdownFiles()`. For Markdown, the default match context has both `filename` and `content`; a bare term may match the name even when absent from the body. Each positive term's candidates therefore include filename matches as well as content postings before AND/OR combination. Canvas matching parses text nodes, uses their metadata caches, and also checks the filename; a regex can match decoded node text absent from raw JSON. Keep canvas files and supported attachments not yet indexed in the candidate set until a dedicated safe strategy exists. Retain core's support/ignore checks downstream. An all-Markdown, body-only candidate set is unsafe even for a simple plain query.

### Typings integration

Checked both latest maintained typings branches, `release/obsidian-public/1.14.4` and `release/obsidian-catalyst/1.14.4`, before tracing the sources. `main` intentionally carries tooling/docs rather than the type sources. Already available: `SearchView.startSearch`, `stopSearch`, `searchQuery`, `dom`, `getQuery`, `getSearchViewConstructor`; `ObsidianSearchQuery` with its constructor helper, `query`, `caseSensitive`, `matcher`, `requiredInputs` and match methods; `SearchMatcher`, match context/result/property types; and `ItemQueue<T>` including `addList`, `clear`, `generator`, `runnable` and cancellation.

Missing on both checked branches: `SearchView.queue`, `matchingCase`, `searchComponent`; the queue component's `app`, `dom`, nullable active `queue`, `start(options)`, `stop` and change handlers; concrete matcher identities/fields (`matchers`, `matcher`, `text`, `regex`, quoted regex fields, case override, tag child and property-comparison kind); and useful token typing (`matchedTokens` is `unknown[]`). The typing addition must provide a verified runtime identification strategy rather than comparing translated `getInfo()` strings or minified constructor names. Reported in `obsidian-typings`' `AGENTS.md`; implementation stays there, with no local internal interfaces or casts here. Target both latest maintained release branches, and verify against their own shipped build; repeat for a newer release branch when created.

### The trigram index

- **Each file's set of 3-character sequences**, after the same case folding core Search applies (find it in `app.js`; do not assume `toLowerCase`), goes into a posting list per trigram.
- **Plain terms and quoted phrases** need every trigram of the term. Core matches SUBSTRINGS (`foo` finds `foobar` and `xfoo`), which a word index cannot narrow and a trigram index can.
- **A regex** is parsed with an existing parser (`regexp-tree` or `regjsparser`), not a hand-written one, and walked to derive the trigrams every match must contain, as an AND/OR expression: `/foo(bar|baz)\d+/` needs `foo` AND (`oba` AND `bar` OR `oba` AND `baz`). A regex with no required trigram, such as `/.*/`, `/\d+/` or a one- or two-character literal, falls back to core's full scan and writes one log line saying so, so a slow query is explainable.
- **A trigram present in almost every file** is stored as "every file", with no list.

### Memory is a hard budget

The target is a vault of 37,000 notes and 110 MB of text, and a search plugin that runs out of memory on it has failed. So:

- **Postings are compact:** files as integer ids, sorted and delta-encoded in typed arrays. No token positions, because core's matcher re-reads the candidates anyway. No copies of note text, no stored excerpts, no JS array of strings or `Map` per trigram.
- **The index is kept in IndexedDB, not in the heap:** one record per trigram and segment of files, so a query reads only the records its own trigrams need, one per segment whose trigram list names it.
- **Building never holds every file's text at once:** files are read, indexed and released in batches.
- **A budget is set up front** for peak and steady heap, and the performance tests fail when it is exceeded. Set on 2026-10-28, before the first measurement, for the 37,000-note, 110 MB target vault. Each figure is what the engine ADDS to Obsidian's renderer over the same moment without it:
  - **Steady (at rest, after a forced GC): at most 64 MB**, counting the main isolate's JS heap, its `ArrayBuffer`s and every worker it keeps (process RSS). That is under 60% of the text size, so an engine that keeps the corpus resident cannot meet it.
  - **Peak (during a full build): at most 256 MB** over the pre-build reading, on the same three counters. A baseline the process is still giving memory back from reads high, so the test also takes the build's largest rise over its own lowest reading, and asserts on the larger of the two.
  - **On disk: at most 220 MB**, twice the text.

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

### Engine decision: the trigram index (measured 2026-10-28)

**The plugin is built on the trigram index in IndexedDB, not the in-memory brute scan.** The brute scan's resident text is about twice the steady budget, and the index fits it with room to spare. They tie on query speed, and both beat core Search by 5 to 30 times.

`npm run test:integration:desktop:performance` re-measures both engines. It runs `src/prototypes/engine-benchmark.desktop-performance.integration.test.ts` in a real desktop Obsidian (1.14.5) against core Search with nothing patched. The prototypes live beside it in `src/prototypes/` and are loaded into the renderer as a bundled script, so the plugin build does not ship them. `INDEXED_SEARCH_TRIGRAM_SEGMENT_SIZE` overrides the trigram segment size, and `BULK_CORES` sets the brute scan's worker count (2 here).

**The corpus** is the shared generator's 37,000 notes and exactly 110,000,000 UTF-8 bytes, with a 25% Cyrillic share, generated with `prose: 'varied'` (`@mnaoumov/obsidian-dev-toolkit` 7.3.0 and later; `scripts/vitest-global-setup-performance.ts`). Its 34,000 filler notes draw seeded, Zipf-distributed words from a synthetic 20,000-word vocabulary per language, with a 2% tail of rare tokens (`rareTokenShare`: id-like tokens and frequency-weighted letter words), and filler note `i` holds the planted term `zq<n>x` for every power of ten `n` dividing `i`, as consecutive words of its first sentence. So every query's match count is known exactly: `zq100x`, the phrase `"zq10x zq100x"` and `/zq100?0x/` match 340 notes, and `q1000` matches 34. The planted terms are ASCII, so the other-case query is `ZQ100X`; Cyrillic case folding is covered by the unit tests, not the benchmark. The rare tokens carry digits, so `/[0-9]{5}/` matches 10,925 notes, a count the benchmark measures rather than predicts. The corpus holds 84,211 distinct trigrams. Without the rare-token tail (7.2.0, or `rareTokenShare: 0`) its consonant-vowel vocabulary gave only 6,959, so every trigram had long posting lists in every segment.

The engine decision below was measured on an earlier, local rewrite of the same corpus: random letters weighted by frequency, plus 2% id-like tokens, giving 90,136 distinct trigrams, with its own planted needles (`quillwort`, `silver harbour lantern`, `журавлина`). That rewrite was dropped once the shared generator had varied prose. "Re-measured on the shared varied prose" further down has the current numbers.

**What one query costs**, as medians: core Search over every file, against each engine's candidate computation plus core Search restricted to those candidates. Core's timings are from the 8,192-segment run, with the OS file cache warm and the result pane rendering.

| Query (core syntax) | Core matches | Core alone | Trigram, segment 8,192 | Trigram, segment 2,048 | Brute scan, 2 workers |
| --- | ---: | ---: | ---: | ---: | ---: |
| `quillwort` | 255 | 550 ms | 25 + 11 ms | 57 + 25 ms | 65 + 11 ms |
| `"silver harbour lantern"` | 85 | 730 ms | 28 + 6 ms | 100 + 6 ms | 52 + 6 ms |
| `llwor` (infix) | 255 | 584 ms | 24 + 10 ms | 63 + 10 ms | 83 + 27 ms |
| `/silver harbou?r lantern/` | 170 | 719 ms | 14 + 9 ms | 79 + 10 ms | 90 + 9 ms |
| `ЖУРАВЛИНА` (other case) | 85 | 416 ms | 25 + 5 ms | 61 + 7 ms | 47 + 6 ms |
| `/[0-9]{5}/` (no trigram) | 2,261 | 737 ms | falls back: 765 ms | falls back: 820 ms | 89 + 189 ms |

Every candidate set contained every file core matched, on every query and in every run.

**What each engine holds**, as deltas over the same moment without it. `process.memoryUsage().arrayBuffers` reads 0 in Obsidian's renderer, so typed arrays are visible only in RSS, which also includes the workers.

| | Trigram, segment 8,192 | Trigram, segment 2,048 | Brute scan | Budget |
| --- | ---: | ---: | ---: | ---: |
| Build time | 54 s | 201 s | 3.7 s, again on every start | |
| Peak during build: JS heap / RSS | +32 MB / +446 MB | +33 MB / +287 MB | +15 MB / +216 MB | 256 MB |
| At rest after GC: JS heap / RSS | ~0 / ~0 | ~0 / ~0 | ~0 / +126 to +166 MB | **64 MB** |
| On disk (`navigator.storage` usage delta) | 71 MB | 93 MB | none | 220 MB |
| IndexedDB records | 427,341 | 1,372,286 | | |
| Restart: open / first answer | 10 ms / 19 ms | 73 ms / 128 ms | full re-read of every note | |

The decision follows from those numbers:

1. **Steady memory rules out the brute scan.** Its corpus stays resident (+126 to +166 MB RSS), two to two-and-a-half times the 64 MB steady budget. The index adds nothing measurable at rest.
2. **Restart favours the index.** It is usable 19 ms after opening. The brute scan re-reads all 110 MB on every start: 3.7 s here with the OS cache warm. `Advanced Metadata Cache` measured 231 s for a first read after a copy, on a 78 MB vault.
3. **Query speed is a tie.** Both answer in 20 to 110 ms, end to end, where core takes 0.4 to 0.8 s.
4. **The index's weak spot is a regex with no required trigram.** It falls back to core's full scan (`/[0-9]{5}/`: about 0.77 s, the same as core). The brute scan answers that one in 278 ms. Such queries keep core's speed and lose nothing.

What the real index takes from these numbers:

1. **Use segments of 8,192 files.** Against 2,048, there are three times fewer records, the build is 3.7 times faster, the database is 24% smaller and candidates come back 2 to 5 times sooner.
2. **The build's peak RSS is over budget, and the JS heap is not the cause.** The heap rose by only 32 MB. The extra RSS follows the size of each segment's single write transaction: +287 MB at 2,048 files, +446 MB at 8,192. Writing each segment in bounded batches of puts, each awaited, is the first thing to measure. A larger segment must not buy speed back with peak memory.
3. **Delete common trigrams before they are written.** The prototype writes the posting lists and only then deletes the trigrams in 90% or more of the files. With document frequencies known only at the end, the real build needs a cheaper route: keep the counts, and drop or skip lists past the threshold as segments merge.

### Re-measured on the shared varied prose (2026-10-29)

The same benchmark, on the toolkit's `prose: 'varied'` corpus (7.3.0, with its rare-token tail). The trigram segment size is 8,192, the brute scan has 2 workers, and the machine had other bulk work running. The table gives the medians of two runs, with the candidate time first and the restricted core time second.

| Query (core syntax) | Core matches | Core alone | Trigram | Brute scan |
| --- | ---: | ---: | ---: | ---: |
| `zq100x` | 340 | 633 to 787 ms | 64 to 68 + 27 to 28 ms | 83 to 113 + 25 to 27 ms |
| `"zq10x zq100x"` | 340 | 647 to 653 ms | 56 to 95 + 23 to 27 ms | 51 to 58 + 26 to 30 ms |
| `q1000` (infix) | 34 | 556 to 564 ms | 62 to 106 + 5 to 6 ms | 87 to 136 + 4 ms |
| `/zq100?0x/` | 340 | 588 to 602 ms | 57 to 58 + 24 to 26 ms | 96 to 123 + 27 to 30 ms |
| `ZQ100X` (other case) | 340 | 530 to 854 ms | 63 to 68 + 21 to 28 ms | 79 to 96 + 24 to 27 ms |
| `/[0-9]{5}/` (no trigram) | 10,925 | 1.6 to 2.3 s | falls back: 1.7 to 2.6 s | 0.1 + 1.0 to 1.7 s |

Every candidate set again contained every file core matched. `q1000` gives the trigram index 46 candidates for 34 matches, because rare tokens hold its trigrams apart. The prototype's build took 56 to 63 s and wrote 289,740 records, 20 to 38 MiB on disk. Restart took 64 to 81 ms to open the index and 110 to 145 ms to the first answer. The brute scan built in 3.8 to 4.0 s, peaked at +212 to +225 MiB RSS and kept +120 to +123 MiB at rest. So the decision stands: the brute scan's resident text is still about twice the 64 MiB steady budget, and the two engines still tie on query speed.

**The real index's peak build RSS was unstable on this corpus.** `trigram-index-budget.desktop-performance.integration.test.ts` measured +300 MiB in one run, which failed the 256 MiB budget, and +86 MiB in the next, which passed every assertion. Its JS heap rose by 26 to 47 MiB, its build took 220 to 273 s, it used 47 to 49 MiB on disk, and its restart took 0.65 to 0.73 s with no note read. On 7.2.0's corpus, with no rare-token tail, the same test measured +311 and +254 MiB.

### Why the build's peak swung, and why it is slow (2026-10-29)

Profiled by running `TrigramIndex.sync` directly over the varied corpus in desktop Obsidian 1.14.5. RSS and heap were sampled every 20 ms into 2 s buckets, private bytes were read every 200 ms through Electron's `process.getProcessMemoryInfo()`, and every file read and store call was timed.

1. **The swing came from the build: every segment's buffers stayed resident.** Each segment allocated fresh postings buffers and grew them by doubling: the packed-pair array (tens of MiB per segment of 8,192 files), its frequency and last-seen arrays, plus one `Uint32Array` per trigram run. Garbage after the segment, they lived outside the JS heap, which grew only 30 to 90 MiB, so V8 rarely ran the major collection that frees them. RSS rose about 120 MiB per segment and fell back only at the end of the build. With the count fix below simulated, the peak reached +470 MiB RSS and +548 MiB private bytes. How much a run retained depended on when a collection happened to land. That is the +86 to +300 MiB swing.
2. **The fix: allocate the buffers once per build.** `SegmentPostings.reset` empties the collection for the next segment and keeps its buffers. `runs()` turns the sorted pairs into file ids in place and yields views, with no copy per run. `encodePostings` encodes into one shared scratch buffer and copies out only the bytes it wrote. On the same profile, the peak fell to +177 to +216 MiB RSS (+215 to +252 MiB private bytes) when commits are fast, and to +162 MiB on today's slow commits.
3. **The measurement also read low.** The test's baseline follows the vault scan and the plugin's own startup build. The process then gave memory back during the build: RSS ran 100 to 180 MiB below the baseline for most of it. So the peak minus the baseline read +7 to +57 MiB, while the build itself added about 100 MiB. Two changes make the reading honest. `withPeakMemory` now also reports the largest rise above the lowest reading taken before it (`peakRssRise`, `peakPrivateBytesRise`), and the test asserts on the larger of that and the baseline delta. `settleMemory` waits for RSS to stop falling before the baseline is taken. A 2 s timeline of the RSS, private-bytes and heap deltas goes into the test's results, so a climb across segments can be told from a single spike.
4. **With both fixes, two consecutive budget runs passed:** a peak rise of +79 and +102 MiB RSS (+96 and +104 MiB private bytes), a heap peak of +44 and +50 MiB, 43 MiB on disk, and a restart under 0.4 s with no note read.
5. **The build is slow because of obsidian-lib, not the index.** Reads cost nothing measurable, because `cachedRead` had every note in memory after the scan; read concurrency 64 changed nothing. Commits took 121 to 129 s of a 129 to 138 s build. `LocalDataStore.commit` ends every transaction with `store.count()` so that it has a request to resolve with, and Chromium counts a store with no key range by walking every record. So each of the build's 421 commits costs time in proportion to everything written so far. With a commit that issues no `count()`, the same build took 49 to 60 s, the prototype's 56 to 63 s. obsidian-lib 10.4.1 carries that fix; "The index as built" has the build time measured on it.

### The index as built

`src/trigram-index/trigram-index.ts` (`TrigramIndex`) is the engine, with no Obsidian dependency; `trigram-index-component.ts` (`TrigramIndexComponent`, the plugin's `trigramIndexComponent`) wires it to the vault. The query side calls `selectCandidates(files, query)`, which keeps every non-Markdown file, every file whose stats differ from its record, and every indexed file the postings do not rule out.

- **Storage** is two obsidian-lib `LocalDataStore`s per vault (`app.appId`): `trigram-files-v1` holds the metadata (`meta`: schema version, segment size, next id, common trigrams), one packed record per segment of its live files (`s:<segment>` → parallel `ids`, `mtimes`, `sizes` and `paths`), and a journal of per-path records written since the last fold (`f:<path>` → id, mtime, size, or `null` for a removed path); `trigram-postings-v1` holds one record per trigram and segment (`p:<trigram base 36>:<segment>` → delta varints from the segment's first id), each segment's sorted trigram list (`t:<segment>`) and its dead-id count at the last rebuild (`d:<segment>`). A query reads one `get` per trigram per segment whose list names it.
- **Ids are append-only.** A changed file is indexed again under a new id at the end, and its old id dies when its file record names the new one; a dead id maps to no path, so its stale postings add nothing. Every batch reserves its ids in `meta`, writes the segment's trigram list, then the postings, and the file records last. That order is the whole crash-safety argument: a kill at any write leaves only postings nobody names, or a list naming records that do not exist, never a file recorded as indexed without its postings. The unit suite cuts off every single write of a build and an update in turn and checks that nothing a term matches is ever missing.
- **The build** goes segment by segment, reading four files at a time, packing `(trigram, file)` pairs into a `Uint32Array` (a `Float64Array` only past 2^32 packed values) that one `SegmentPostings` keeps across every segment of the build, and committing posting records in batches of at most 1,024 records and 262,144 file ids. The id bound matters on dense lists: on the varied corpus, record-count batches alone put the build's peak RSS at +254 to +311 MiB, and with it the peak was +3 MiB (2026-10-29), a reading that the high baseline described above made low. A trigram in 90% of the files read so far (once at least 1,024 are) becomes "every file": its current list is never written, and its earlier segments' records are deleted.
- **Build time, on obsidian-lib 10.4.1** (its commits issue no whole-store `count()`), measured by `trigram-index-budget.desktop-performance.integration.test.ts` in two consecutive runs on 2026-10-29, on the 37,000-note varied corpus, with other bulk work running: the build took 79 and 86 s, against 220 to 273 s on 7.1.0. Its peak rise was +109 and +111 MiB RSS (+107 and +112 MiB private bytes), its heap peak +44 and +53 MiB, 22 and 24 MiB on disk, and the restart 0.33 and 0.36 s with no note read. In the same runs the prototype built in 43 and 47 s.
- **Damage:** a posting record that does not decode as ascending ids inside its segment, or a missing or unsorted trigram list, makes every file of that segment a candidate, deletes the list so a restart sees the same, and logs one line; `maintain` then rebuilds that segment from its files under the same ids. Damaged metadata clears both stores; a damaged file record is dropped and its file indexed again. `maintain` also rebuilds a segment once 25% of its ids died since its last rebuild.
- **Restart reads a handful of records, never one per file.** A restart reads the whole files store in one cursor: the metadata, one packed record per segment and at most 512 journal records (`journalLimit`). A single update, rename or delete writes only journal records. Once the journal would pass its bound, it is folded into the packed records of the segments it touched, and its keys are deleted in the same transaction. A bulk pass of a whole segment folds at once. Every journal record is newer than any packed one, so a load applies the journal last; a `null` record hides a removed path. A damaged packed record is dropped and its files indexed again. A duplicated path keeps its newest id. A journal past its bound is folded at load. With one record per path, the cursor alone took 11.7 s of a 12.1 s restart on the 37,000-note corpus, against 0.26 s for `getAll` over the same records. Packed, the restart took 0.66 s on a loaded machine (2026-10-29), and the budget test bounds it at 2 s. What is left is per-transaction IndexedDB latency, not data volume.
- **Live changes:** create and modify queue the path (debounced 500 ms); delete forgets the record; rename moves it without a read. A file is a candidate from the moment its stats change, so a query never waits for an update.
- **Not reused: `IncrementalFileIndexComponent`.** It keeps every file's projection in a heap map and persists the whole map per flush; here the per-file record must commit after that file's postings, in the same ordered batch, and nothing per file may stay in the heap beyond its id and stats. Case folding stays local too, because it models non-Unicode `RegExp` `i` canonicalization, which nothing in `Advanced Metadata Cache` does.

### The search API

Other plugins and scripts get core Search's answer through the `@mnaoumov/obsidian-lib` plugin registry (plugin id `indexed-search`, contract `1.0.0`): `search(query, { isCaseSensitive?, abortSignal? })` resolves to `{ file, match }` hits ordered by path. The consumer-facing declarations are the repo-root `api.d.ts` (imports only `obsidian`) and `api-contract.ts`; `src/api/indexed-search-api.ts` holds the version, and `src/api/indexed-search-api-impl.ts` the implementation.

- **Core decides, by construction.** The query is compiled by core's own query class (`getObsidianSearchQueryConstructor` from `obsidian-typings`, found once on the first search, because finding it opens and closes a probe view), and each file goes through the same loop as core's scan (public `VL`, 84515 in 1.14.5): skip `isUserIgnored` and unsupported files, read Markdown and canvas through `cachedRead` only when `requiredInputs.content`, match an unreadable file as `''` after logging it, then `query.match(file, content)`. An empty query (`matcher` null) answers `[]`; a query core rejects rejects with core's error. The scan yields after 100 ms of work, as core's does.
- **The match is copied** into the published shape (`content`, `filename`, `filepath` ranges, `properties`, and a canvas's `canvas-<id>` entries as `canvasNodes`), so a consumer never holds core's arrays.
- **Conformance:** `src/api/indexed-search-api.desktop.integration.test.ts` runs a corpus covering every operator, both case settings and a canvas through the Search pane and through the API on one vault, and asserts the same files. The desktop project seeds the integration-test harness plugin (`scripts/vitest-global-setup.ts`, `src/@types/obsidian-integration-testing.d.ts`) so a closure's `lib` has `findPluginApi`; the demo-vault project keeps the plain `vitest-setup`, because its vault does not seed the harness.
- **Not narrowed yet.** The API checks every supported file. Once the narrowing lands, it takes its file list from the same candidate translation, so its results stay core's.

### Shared code

Obsidian's word class and the performance-vault generator come from `@mnaoumov/obsidian-lib` and `@mnaoumov/obsidian-dev-toolkit`, never copied; the device-local store is obsidian-lib's `LocalDataStore`. The file-change pipeline and the case folding are this plugin's own, for the reasons in "The index as built".
