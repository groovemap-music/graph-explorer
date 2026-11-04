# Changelog

All notable changes to this repository will be recorded here by Commitizen from
Conventional Commits.

## v0.3.1 (2026-11-04)

### Fix

- **explore**: stop Explore hanging on a graph node with no name

## v0.3.0 (2026-10-31)

### Feat

- **brand**: verify brand assets against design provenance and the built image
- **brand**: move off-palette components onto the Brass tokens in both themes
- **brand**: default the theme to the OS with a persisted light/dark toggle
- **brand**: move background and text scales to the warm vinyl palette
- **brand**: re-promote brand assets from design 41be7cbe and move UI to brass/oxblood
- **brand**: re-promote brand assets from design 7abe13ad and move UI to mint/lagoon
- **explore**: add a Yours column to the atlas table and cover Taste Strata and the Fit landing point end to end
- **fit**: draw the Fit landing point on the Genre Atlas with drawn and listed components
- **atlas**: add the Taste Strata layer with deterministic L2 master slots
- **atlas**: draw a selected style's co-tag edges from the cotags route
- **contracts**: promote the catalog-api graph-explorer contract at d52c7f9
- **atlas**: place landmark masters in deterministic slots of their style cell
- **atlas**: add the Genre Atlas table, e2e journeys, and user docs
- **atlas**: draw the Genre Atlas on the Strata engine in Genres and Insights
- **contracts**: promote the catalog-api graph-explorer contract at 28e422e
- **strata**: open pressings from search and record observations on the named copy
- **contracts**: promote the catalog-api graph-explorer contract at 28e422e
- **explore**: ship the strata table as a first-class accessible view
- **explore**: open Discography Strata from Explore with both clocks and search-to-focus
- **strata**: ring MusicBrainz-only releases as blocked pressings
- **contracts**: promote the catalog-api routes contract with the strata route
- **strata**: read the route's pages, providers, and collector states in the layout
- **strata**: add the webgl-inst strata renderer with resolve picking, labels, and LoD
- **explore**: add the Strata collector state machine with token-driven state colors
- **strata**: add a pure strata layout module with property-tested invariants
- **explore**: vendor three.js 0.186.1 with license, importmap, and digest check

### Fix

- **image**: install runtime deps from uv.lock and check them inside the image
- **logging**: adopt runtime LOG_FILE and console fallback
- **explore**: report package version in FastAPI app metadata
- **deps**: upgrade msgpack past CVE-2026-114613
- **deps**: sync vendor license manifest with alpinejs 3.17.5 (#35)
- **deps**: sync vendor license manifest with alpinejs 3.17.5
- **brand**: move --accent-secondary off the Strata state palette
- **brand**: keep a distinct secondary data color after the single-accent move
- **e2e**: run the browser projects concurrently in e2e-run
- **e2e**: give headless Linux Firefox an X display so WebGL2 works
- **strata**: expose a settled-frame readiness signal and degrade without WebGL
- **strata**: keep labels and chips from overlapping and count repeated titles
- **deps**: raise undici override to 8.12.2 for GHSA-4qv8-2p9j-2685
- **explore**: stack the strata panel under the view on a phone
- **deps**: upgrade filelock to 4.2.1 past CVE-2026-112940
- **deps**: upgrade certifi and opentelemetry past audit advisories
- **deps**: synchronize upgraded vendor license metadata
- **deps**: integrate reviewed Python audit dependency repair

### Refactor

- **share**: build the shareable snapshot body in GraphVisualization

## v0.2.2 (2026-10-03)

### Fix

- **logging**: pin thread-safe runtime
- **licenses**: sync vendor asset manifest with the bumped javascript group

## v0.2.1 (2026-09-15)

### Fix

- **fit**: post fit outcome events with the fit surface terms
- **build**: use uv run python for all Justfile recipes
- **e2e**: retire the browser before WebKit's context budget runs out
- **auth**: keep the session on a wrong credential re-check password

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
