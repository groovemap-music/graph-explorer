# Changelog

All notable changes to this repository will be recorded here by Commitizen from
Conventional Commits.

## v0.8.1 (2026-11-10)

### Release notes

Accent colours now come from design's promoted brand tokens (design 46763e4, gm-graph-explorer-stsq) instead of hand-copied hex values. The brass and oxblood 700 shades are unchanged. The 900 tints differ slightly, but nothing renders them, so there is no visible change.

### Fix

- **brand**: take accent shades from design's promoted tokens

## v0.8.0 (2026-11-10)

### Release notes

Path finding sends `from_id` and `to_id` for label ends (gm-graph-explorer-zl42), so a path to or from a label that shares a name resolves to the label the visitor picked. catalog-api v0.14.2 and later serve these parameters. Also fixes a tablet layout bug: leaving a path field cancels its pending suggestion request and drops a late response, so a stale suggestion list can no longer cover the Connect button.

### Feat

- **path**: send label ids to /api/path so a path to a shared-name label resolves

### Fix

- **explore**: close a path suggestion list the visitor has left

## v0.7.0 (2026-11-10)

### Release notes

Label explore, expand and path send the label's node id along with its name (gm-graph-explorer-vag6). With catalog-api v0.14.1, which ignores the id there, they keep working by name. With catalog-api v0.14.2 (gm-catalog-api-ntnw), labels that share a name each resolve to the right label, and an ambiguous name lets the user pick from the candidates instead of failing. Deploy before or with catalog-api v0.14.2.

### Feat

- **explore**: send the label id so labels sharing a name resolve

## v0.6.0 (2026-11-10)

### Release notes

Label trends send the label's node id along with its name (gm-graph-explorer-toyc). With catalog-api v0.14.0, which ignores the id, trends keep working by name. With the catalog-api release carrying gm-catalog-api-1whr, labels that share a name each get their own trends, and an ambiguous name lists the candidate labels instead of a blank chart. The trends consumer contract is pinned to catalog-api ecb6408. Safe to deploy before or with that catalog-api release.

### Feat

- **trends**: send the label id so labels sharing a name chart their own trends

## v0.5.0 (2026-11-10)

### Release notes

Needs catalog-api v0.14.0 (label details' `longevity_rank` and `longevity_rank_of`). A label's detail panel shows its full-catalog longevity rank as "#N of M". The rank comes from discogs-graph-enricher v0.9.0's stored ranking, which matches the longest-running-labels order (gm-graph-explorer-ugpg, part of gm-graph-explorer-i51p). Placeholder labels show no rank. When the API returns no rank (an older API, or stats not yet at version 4), the panel falls back to the top-50 lookup as before. The node_label contract is promoted from catalog-api a378a88.

### Feat

- **explore**: show the full-catalog longevity rank as #N of M
- **contracts**: promote node_label longevity rank from catalog-api a378a88

## v0.4.0 (2026-11-09)

### Release notes

Needs catalog-api v0.13.0 (the label-details longevity fields, the label-longevity operation, and the Missing preview and copy listing routes); with an older API those panels show no data.

- **Label longevity:** a label's detail panel shows its first and last year, years active, dated releases and peak decade (gm-graph-explorer-uhnz), and Trends gains a longest-running-labels timeline that shares the placeholder-label toggle (gm-graph-explorer-oehx), built on the longest-running-labels insight (gm-graph-explorer-yulr).
- **Missing and collection** (gm-graph-explorer-qgzv, operator-authorized for release 2026-11-09): a transient, scoped Missing preview that shows its evidence limits and refuses contradictory or incomplete completeness, and physical-copy selection with independent copy timelines in Collection; owner state is invalidated on account changes.
- Contracts promoted from catalog-api: node_label, label-longevity, and the Missing and copy read routes.

### Feat

- **explore**: show a label's longevity on its detail panel
- **contracts**: promote node_label from catalog-api 842e6cd
- **trends**: add longest-running labels timeline sharing the placeholder toggle
- **collection**: select physical copies and read independent timelines
- **missing**: render transient scoped preview with evidence limits
- **api-client**: promote Missing and copy read contracts
- **contracts**: promote the label-longevity operation from catalog-api
- **insights**: list the longest-running labels, with placeholder labels opt-in

### Fix

- **trends**: escape label names in the timeline's tick and hover text
- **collection**: keep physical copy controls reachable on mobile
- **missing**: validate complete denominator evidence before percentage
- **missing**: reject contradictory completeness and verify account changes
- **auth**: invalidate owner state on account changes
- **contracts**: narrow route provenance checks
- **insights**: never send a label longevity limit outside 1..200
- **release**: keep breaking changes below 1.0 with major_version_zero

## v0.3.3 (2026-11-06)

### Release notes

No schema change. A null completeness_pct renders as n/a, which must be live before catalog-api returns nulls for it.

### Fix

- **insights**: render a null completeness_pct as n/a

## v0.3.2 (2026-11-05)

### Fix

- **credits**: render each panel as it settles and abort a superseded load
- **credits**: show the person-search dropdown with the class the stylesheet displays
- **credits**: page through every credit for a person and stop capping the list at 100

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
