# Strata renderer

`explore/static/js/strata-renderer.js` is Discography Strata's 3D renderer: the `webgl-inst` engine
that [ADR 0016](https://github.com/groovemap-music/design/blob/main/docs/adr/0016-strata-graph-view.md)
section 1 chose, on three.js 0.186.1. It draws a `layoutStrata()` result
(`explore/static/js/strata-layout.js`) on three stacked planes and handles picking. It does not
fetch, lay out, or decide what a click opens. The Explore integration does that: it builds the
layout, calls `setLayout`, and listens for `hover`, `select`, and `solo`.

The design comes from the design spike `gm-design-on0x` (Recommendations 1, 3, and 4). Its
harness's `webgl-inst` mode is the source of the port.

| File | Role |
| --- | --- |
| `explore/static/js/strata-renderer.js` | `StrataRenderer`: the three.js scene, pointer input, and DOM labels |
| `explore/static/js/strata-scene.js` | The decisions that need no GPU: resolve picking, label candidates and placement, level of detail, camera tweens and reduced motion, vertical links |
| `explore/static/css/strata.css` | The `--strata-*` color properties, the label classes, and the Explore view's chrome. `index.html` links it |
| `explore/static/js/strata-explore.js` | The Explore integration: fetching, drill-down, both clocks, the filter, search-to-focus, keyboard, and the panel (below) |
| `explore/static/js/strata-table.js` | The strata table: every credit, lane, master, and pressing as a sortable, keyboard-navigable table (below) |

## API

```js
import { StrataRenderer } from './strata-renderer.js';

const renderer = new StrataRenderer(stageElement);
renderer.setLayout(layoutStrata(graph, { focus, selected, edges }));
renderer.start();
renderer.addEventListener('select', (event) => openPanel(event.detail.node));
```

| Member | What it does |
| --- | --- |
| `new StrataRenderer(stage, options)` | Adds a canvas and a label layer to `stage`. Every option is a seam for tests: `createRenderer(canvas)` (the WebGL context), `readToken`, `theme`, `matchMedia`, `requestFrame`/`cancelFrame`, `now`, `measure` (the stage rectangle), `labelOf(node)` (label text), and `pixelRatio`. If `createRenderer` throws (the browser gives no WebGL context), it leaves `stage` as it was and rethrows |
| `setLayout(layout)` | Draws a layout. The selection survives if its node is still drawn |
| `pick(clientX, clientY)` | The node a pointer means, by resolve picking, or `null` |
| `hitsAt(clientX, clientY)` | `{ node, candidates }`: every node under the pointer, best first |
| `hover(id)` / `select(id)` / `solo(level)` | Set the hover, the selection, or the soloed plane (0 credits, 1 masters, 2 releases). `null` clears. Each dispatches a `hover`, `select`, or `solo` event once per change. `detail` is `{ id, node }`, or `{ level }` for `solo` |
| `orbit(radians)`, `tilt(radians)`, `zoom('in' \| 'out' \| 'reset')`, `resetCamera()` | Camera moves for keyboard bindings. Zoom and reset are tweened unless reduced motion is on |
| `refreshColors()` | Re-reads the tokens after a theme change |
| `start()` / `stop()` / `tick(t)` / `render()` | The animation loop. A frame renders only when something changed |
| `stage.dataset.strataFrame`, `settled` event | The readiness signal. `settled` once a frame has drawn the current layout at a measurable size with its labels placed and no camera tween running; `pending` from the moment anything that frame showed changes (a layout, selection, hover, solo, camera move, or resize). Each change to `settled` dispatches a `settled` event, `detail` `{ frame, labels }` |
| `screenPosition(node)`, `drawCounts()`, `stats` | Readouts for tests and the performance smoke test |
| `dispose()` | Releases the GPU objects, listeners, and DOM |

Pointer input is built in. A drag orbits and tilts. A click selects through `pick`. A pointer move
hovers, picked at most once a frame. The wheel zooms.

## Scene

- **One `InstancedMesh` per plane and render kind.** An entity, a count node, and a no-master lane
  are separate kinds: an icosahedron, sphere, or disc for entities (credit, master, release), an
  octahedron or a stack of discs for count nodes, and a box for the lane. Each plane adds one
  instanced halo. A 20,000-node layout is 6 instanced meshes.
- **Merged edge ribbons.** Lateral edges become one mesh per plane, edge kind, and dimming. Rules
  that pick which edges to draw stay in the layout's planar edge rule.
- **Credit hulls** are merged per plane, color, and dimming. They are rebuilt for a new layout or
  selection, not for camera moves.
- **Vertical links** run from each node to its parent on the plane above. They are rebuilt only
  when the layout, the soloed plane, or the selection changes (`verticalLinksKey`), never on a
  camera move.
- **Colors** are the promoted collector-state tokens (`stateColor` in `strata-collector.js`) for
  the active theme. A count node takes the roll-up of the states it holds. A node with no state
  uses `--strata-node-stateless`. Outside the selection's lineage, nodes dim toward the canvas.
- **Blocked pressings.** A MusicBrainz-only release (`provider: 'musicbrainz'`, `isBlocked` in
  `strata-scene.js`) is drawn state-less inside the spike's ring, one instanced ring mesh per plane
  in `--strata-blocked`. It exists only in MusicBrainz, so GrooveMap has no collector state for it.
  The ring is not pickable.

## Resolve picking

Nearest-hit picking lets a node nearer the camera win even when the pointer is on the centre of
the node behind it. In `gm-design-on0x`, 3 of 153 drill-down targets could not be clicked that
way. `resolvePick` collects every hit along the ray (three.js raycasting against the instanced
meshes of visible planes), then:

1. projects each hit node's centre to the screen, and the nearest centre to the pointer wins;
2. if several centres are within `TIE_TOLERANCE_PX` (2 CSS px) of the nearest, they are tied, and
   a node on the soloed plane wins, then a node on the selected node's plane;
3. a remaining tie goes to the nearer centre, then to the hit nearer the camera.

Soloing a plane hides the others, so they are not hit at all. The solo rule still applies to the
pure function, for a caller that dims other planes instead of hiding them.

## Labels and level of detail

Only label candidates get a label element, and only a candidate that projects on screen. The
hovered and selected nodes are never dropped for a neighbour. With a selection, only its lineage is
labelled. Otherwise nodes on planes down to the level of detail's `labelDepth` are candidates,
credits first.

`collapseRepeats` then makes one candidate of the pressings of one master that share a title: its
text is the title and a count ("Willow Orbit ×6"), anchored over the middle of those pressings. The
hovered and selected nodes keep their own labels, and are not counted in the group.

`labelBoxes` turns the candidates and the outlined credit chips (the hull tags) into boxes in CSS
pixels, with the heights `strata.css` gives them (`LABEL_HEIGHT`, `CREDIT_LABEL_HEIGHT`,
`TAG_HEIGHT`), and `placeLabels` places them all in one greedy pass (priority order, skip overlaps)
over a uniform grid, so a chip is a box like any label. No two boxes that come back overlap, and each
keeps `LABEL_GAP` (2 px) from the next. A label that would leave the stage is dropped rather than
clipped. Priority 0 (hovered or selected) is not dropped for a neighbour: it moves up or down to the
nearest free slot instead, and is hidden only when the column around it is full. At most
`MAX_NODE_LABELS` (400) node labels are placed in a frame. Labels are positioned through CSSOM
transforms and hidden with the `hidden` attribute. The chip elements are pooled across layouts, so a
new layout hides every chip the last frame showed before the next frame places its own.

Labels are placed by the frame loop, not by `setLayout`, so they appear a frame after the DOM the
Explore view writes for the same page. Anything that reads them, the browser tests included, waits
for `data-strata-frame="settled"` on the stage (and `aria-busy="false"` on `#strataView`, which the
Explore view sets while a strata request is in flight) rather than for a fixed time.

`levelOfDetail` takes the camera distance and the drawn node count:

| Camera distance (home is 210) | `labelDepth` |
| --- | --- |
| over 1.25 × home | 0: credits |
| home | 1: credits and masters (the mockup's default) |
| under 0.85 × home | 2: every plane |
| under 0.62 × home, or a soloed plane | every plane |

Above `LOD_NODE_LIMIT` (1,500) drawn nodes, the shapes switch to low-detail geometry (fewer
segments per sphere and disc) and the halos are hidden, unless the camera is within 0.62 × home.
The default 3, 12, 16 view never reaches that limit.

## Reduced motion and CSP

Every camera tween goes through `animateTo`. When `prefers-reduced-motion: reduce` matches, the
move is a jump with no tween frames. That covers zoom, reset, solo, and leaving solo. A tween already
running when the preference turns on lands at once.

The renderer has no `eval`, no `new Function`, no string timers, no HTML parsing, and no style
attribute written as markup or through `setAttribute`. Neither do the three.js files the importmap
loads. A future `style-src 'self'` policy without `'unsafe-inline'` holds.

## Explore integration

`strata-explore.js` opens the view from the Explore pane's toggle (graph, strata, and table) on the
artist Explore centers. The last view chosen is kept in `localStorage` under `explore.view` (every
access is in a try/catch, so denied or full storage only loses the preference) and opens once an
artist is centered after a reload. It reads `GET
/api/explore/strata` (promoted in `contracts/catalog-api/graph-explorer/v1`) at the default 3, 12,
16 budget, with the caller's token when signed in.

- **Drill-down is the route's.** An aggregate carries counts, not members, so opening one (or a
  master, whose cursor pages its pressings) is a new request, `focus=<cursor>&page=<n>`. The layout
  reads the page from the payload's `focus` and pins its members. The panel shows the trail, the
  page, and Previous and Next. Pages wrap.
- **Valid time** is the Explore pane's year scrubber (`before_year`): entries released after the
  year are hidden with everything under them. **Transaction time** ("Recorded as of") replays the
  collector's own Discogs `date_added`. The view is laid out with today's states and repainted, so
  scrubbing it moves no node. Aggregate counts are today's, so in the past an aggregate is drawn
  without a state.
- **"Only what I collect"** keeps entries holding a wanted or owned release, with their ancestors.
- **Search-to-focus** selects a drawn match, or opens the view on what a `/api/search` hit names,
  in hit order: a master through the route's `m:<id>` cursor, a Discogs pressing through `r:<id>`,
  and a MusicBrainz-only one through `mb:<mbid>`. A pressing cursor resolves to the page that holds
  it (`focus.id` is `ra:m:<master>` or `ra:nm:<credit>`, and the request's page is ignored), so any
  pressing opens and is selected at any depth. A hit that is another artist's pressing is a 404 and
  the next hit is tried. The view left goes on the trail before the new one is drawn, so the trail's
  first button reads "Back" from the first drill.
- **Keyboard** (on the focused stage): arrows orbit and tilt, `+` and `-` zoom, `0` resets, `1` to
  `3` solo a plane, PageUp and PageDown move to the parent or first child, `[` and `]` move along a
  plane, Enter opens a count node, and Escape clears the selection. Each binds to the renderer's
  `orbit`, `tilt`, `zoom`, `resetCamera`, `solo`, and `select`.
- **Actions** follow `strata-collector.js`: "Open on Discogs", and for a signed-in collector on a
  Discogs release "Sync now" and, on an owned copy only, "Record an observation". The observation
  posts to `/api/user/copies/{copy_id}/observations` for `owned_copy_ids[0]`, the earliest-acquired
  copy, which the route puts on each signed-in release node (a list, `[]` when the sync has minted
  no copy, absent for an anonymous caller or when the copy-id read degraded). With no copy id the
  action is disabled and says why. `/api/user/collection` is never read to find a copy. Nothing
  writes a wantlist or a collection.
- **Errors**: a 422 (a root above 134,051 releases) and a 504 (a read past its bound) get their own
  words. A theme change calls `refreshColors()`.

### The table

The table is a peer of the 3D view, not a fallback (ADR 0016 section 1). It is the only view that
answers "which items cannot change state, and why" at every scale, and it needs no WebGL: choosing
it builds no renderer. It reads the same clock-applied graph and layout the 3D view draws from, so
it shows the same planes, lanes, aggregates, and server page, and drilling an aggregate or a master
(its **Open** button, or Enter on its row) issues the same `focus=<cursor>&page=<n>` request. The
trail and Previous and Next in the panel page it, as they do in 3D.

- **Every entry the route sent is a row**, folded into a count node in the 3D view or not. A row
  says which in "In the 3D view" (`drawn`, or the count node that holds it), so
  `buildTableRows(view, layout)` is conserved against the layout: one row per entry, each held by
  exactly one layout node, and the blocked counts add up to the route's totals the way the
  layout's releases do.
- **Columns**: kind, name, under (the path of ancestors), year, state, "Cannot change because",
  releases, in the 3D view, and open. A MusicBrainz-only pressing carries the full reason (it exists only in MusicBrainz, so
  GrooveMap has no collector state for it); a credit, master, or group says how many such pressings it holds and that opening it lists
  them, with the count pluralised ("1 pressing here exists only in MusicBrainz", "3 pressings here
  exist only in MusicBrainz"). "Only what cannot change state" filters to those rows. The Open
  column takes the width its button needs and wraps the label, so it is never cut off by the scroll
  region.
- **Sorting**: each column header is a button. Ascending, descending, then the outline order again,
  with `aria-sort` and a live sentence ("5 rows, sorted by year, descending."). Empty years and
  reasons sort last either way.
- **Keyboard**: one row is the tab stop. Up, Down, Home, and End move between rows; PageUp moves to
  the row's parent and PageDown to its first child, as in 3D; Space selects a row and describes it
  in the panel; Enter opens a group or master (a folded pressing opens through its parent's cursor)
  and otherwise selects; Escape clears the selection. Focus stays in the table across a redraw.
- **Screen readers**: a native table with a caption, `scope` on every header, row headers, a
  description of the keys, and `aria-current` on the selected row.
- **Search** in the table also finds an entry the 3D view folded away.

`tests/explore_test_app.py` serves `/api/explore/strata` from `tests/fixtures/strata-route.json`,
bodies recorded from catalog-api's fold over an invented catalog, so the view runs locally without
a database. Artist ids `too-large` and `timeout` answer with the 422 and 504.

## Tests

- `explore/__tests__/strata-scene.test.js` covers the GPU-free logic: resolve picking on stacked
  nodes and the plane tie-break, label candidates, repeated-title collapsing, label boxes and
  placement (a property over generated layouts: no two label boxes overlap, chips included), level of
  detail, and reduced motion.
- `explore/__tests__/strata-renderer.test.js` builds the real three.js scene in jsdom with a stub
  for the WebGL context. It covers instancing, edge merging, colors, picking through the scene
  (occlusion and an exact tie), events, labels, reduced motion for every camera move, vertical link
  rebuilds, and level of detail.
- `explore/__tests__/strata-explore.test.js` covers the integration: both clocks, the filter,
  actions against the collector machine, keyboard commands, search-to-focus, errors, and the view
  over recorded route bodies with a stand-in renderer and the real `index.html` markup.
- `explore/__tests__/strata-table.test.js` holds the table's conservation against the layout (the
  recorded bodies, 200 generated discographies, and every server page of 100 more), its sorting and
  filter, and the DOM table's roving focus, keys, and markup.
- `explore/__tests__/strata-layout.test.js` holds the layout's properties over payloads from the
  route's fold, ported in `strata-fixtures.js`; `strata-route-recorded.test.js` checks the port
  against bodies the Python wrote.
- `explore/__tests__/strata-csp.test.js` scans the strata modules and the vendored three.js for
  the forbidden constructs, and checks at run time that the renderer never writes a style
  attribute or sets `innerHTML`.
- `tests/e2e/test_discography_strata.py` walks the feature in a real browser on every project in the
  E2E matrix, against the mock route above: search to the strata, drill and page a group, a
  MusicBrainz-only pressing and its reason, both clocks, the table (filter, sort, keyboard), "Only what
  I collect", a signed-out visitor, and the 422 and 504 messages. It drives the 3D view from the
  keyboard. It also searches to pressings the page does not draw (a masterless EP and a
  MusicBrainz-only pressing, two pages deep, and a hit the route answers with a 404), records an
  observation against the copy the route named without reading the collection, checks that no two
  labels or chips overlap in the browser, and that the table's Open column keeps its labels whole.
  The user-facing description is [Discography Strata](discography-strata.md).
- `tests/perf/test_strata_renderer_perf.py` is the performance smoke test below. `just test` and the
  E2E matrix skip it (marker `benchmark`).

## Performance smoke test

`just strata-perf` builds the web assets, serves the app, and drives the renderer in Chromium on a
20,000-node synthetic layout (`explore/__tests__/strata-synthetic.js`). The layout has the shape of
`gm-design-on0x`'s 20,000-node Discogs band: 71 credits, 1,480 master-plane nodes, and 18,449
pressings, unaggregated. The page is served under the spike's strict policy
(`script-src 'self'` plus the importmap hash, `style-src 'self'`). The test fails on any
`securitypolicyviolation`, page error, or missing node. The figures are written to
`test-results/strata-renderer-perf.json`.

The method follows the spike. Time to first frame runs from the layout in memory to the second
animation frame after the first render, which includes creating the WebGL context. Frame time is
taken while orbiting at one turn per 8 s for 4 s, on a 1440 × 900 viewport at device pixel ratio 2.
"Renderer work" is the renderer's own JavaScript per frame: level of detail, links, the draw
submission, and labels.

Headless Chromium paces animation frames by its own throttles. A 50-node scene ran at 15 to 60 fps
headless on the measuring machine, so headless frame rate is not a measure of the renderer. A
headless run (the default) therefore lifts the vsync cap, and its frame interval is what a frame
costs. `STRATA_PERF_HEADED=1` runs headed against the display's cap, as the spike did. On macOS the
test uses ANGLE's Metal backend so the GPU renders, not SwiftShader.

### Measured result

Measured on 2026-10-23 on an Apple M1 Pro (10 cores, 32 GiB) with Playwright's Chromium (build
1248) on ANGLE Metal. Other work was running: the 1-minute load average was 3.7 to 6.4.

| Run | Time to first frame | Frame time, median / p95 | fps, median / 5th percentile | Renderer work per frame, median / p95 | Resolve pick, median / p95 | Draw calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 20,000 nodes, headed (120 Hz cap) | 296 ms | 8.3 / 8.9 ms | 120 / 112 | 1.0 / 1.2 ms | 1.6 / 2.6 ms | 62 |
| 50 nodes, headed (control) | 133 ms | 8.3 / 9.7 ms | 120 / 103 | 0.7 / 2.1 ms | 0.0 / 0.2 ms | 58 |
| 20,000 nodes, headless, uncapped | 282 ms | 1.7 / 9.2 ms | 588 / 109 | 0.8 / 8.0 ms | 1.6 / 2.7 ms | 62 |

- At 20,000 unaggregated nodes the renderer holds the 120 Hz display cap, with a 5th percentile
  of 112 fps. The spike measured `webgl-inst` at 120 / 104 fps and 403 ms to first frame there, in
  Chromium on the same machine.
- A frame costs about 1 ms of JavaScript. Uncapped, a whole frame takes a median of 1.7 ms. The
  headless run had one 841 ms stall, so its p95 and the worst frame are less reliable than its
  median.
- The level of detail was `low` at the home view, as designed. 91 to 93 labels were placed from
  1,551 node candidates and the hull tags.
- These are one machine's figures. No mid-range laptop or phone was measured.
