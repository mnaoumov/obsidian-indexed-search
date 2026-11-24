# CHANGELOG

## 1.1.1

This release has 1 fix, 1 improvement and 1 documentation change. 3 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### Fixed

- Query is only filtered on ENTER (#2)

### Improved

- **search:** narrow attachments, cache postings and check paths by folder

### Documentation

- **readme:** use the plugin badge line with Obsidian downloads, minimum version, CI and coverage

## 1.1.0

This release has 1 new feature, 1 fix and 3 documentation changes. 3 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- Filter out data from excalidraw compressed section (#1)

### Fixed

- load again after an update or Hot Reload instead of failing on an already published API

### Documentation

- **readme:** show the Buy Me a Coffee button in the Support section
- point the installation section at the community directory listing
- link the changelog from the README

## 1.0.0

This release has 6 new features, 2 fixes, 3 improvements and 5 documentation changes. 10 maintenance commits (tests, build, CI, refactoring, dependencies) are not listed.

### New

- add the Narrow core Search setting, the demo vault, README and screenshots
- **search:** narrow core Search to the trigram index's candidates
- add a search(query) API that answers with core Search's own results
- add a Report a bug command
- **trigram-index:** persistent trigram index with batched builds and crash-safe recheck
- scaffold `Indexed Search`

### Fixed

- **deps:** clear the glob cancellation advisory with a glob 14 override
- **deps:** clear development dependency audit findings

### Improved

- **trigram-index:** bound the build's peak memory and measure it honestly
- **trigram-index:** restart the index from packed per-segment file records
- pick the trigram index engine on a 37,000-note benchmark

### Documentation

- make issue attachments optional and strongly encouraged
- link to the Obsidian resources page
- add issue-filing instructions and the Report a bug command
- document core Search candidate hook and typing gaps
- record the design in AGENTS.md
