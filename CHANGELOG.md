# Changelog

All notable changes to this repository will be recorded here by Commitizen from
Conventional Commits.

## v0.2.0 (2026-09-15)

### Feat

- **search**: look a record up by barcode, catalogue number, or matrix
- **contracts**: promote the catalog-api routes contract with the lookup route
- **fit**: add the fit pane with the release picker, profile card, and landing point
- **api-client**: add the fit profile client method
- **contracts**: promote the catalog-api routes contract with the fit route
- **settings**: add privacy, export, and delete-account cards
- **ui**: emit recommendation outcome events from the recommendation and search views
- **client**: add activity, consent, export, and erasure client methods
- **telemetry**: adopt wave-2 tracing and runtime metrics
- **ui**: family-grouped media filter, grouped media badges, and a search media facet
- **telemetry**: instrument the proxy with OpenTelemetry metrics

### Fix

- **checks**: read the contract revision from its promoted provenance
- **settings**: show the erasure receipt on the signed-out view
- **ci**: accept commitizen's no-eligible-commits bump-preview state
- **gap-view**: keep filter bar on empty results and fix media select a11y/sizing
- **search**: clear stale facet chips on error and mark genre chips aria-pressed
- **ci**: use public python libraries

### Refactor

- **ci**: normalize explorer validation recipes
- **transport**: clarify proxy and browser boundaries
- **ui**: separate graph and settings state
- **app**: centralize browser lifecycle state

## v0.1.1 (2026-08-31)

### Fix

- **release**: synchronize backend and web package versions
- **ci**: accept release-boundary bump states and use Commitizen's supported files-only option

## v0.1.0 (2026-08-31)

The v0.1.0 workflow failed before publishing artifacts or images. The tag is
retained as an immutable record of that release attempt.
