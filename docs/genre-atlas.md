# Genre Atlas

The Genre Atlas draws the catalogue's genres and styles as a map you can scrub through time. Each
genre has a region, each style sits under its main genre, and every style is colored by where it is
in its life: not yet started, emerging, established, declining, or reviving. It opens in the
**Genres** pane, beside the flat genre tree, and below the other summaries in the **Insights** pane.
It has a **table** that lists the same genres and styles as rows. This page is for the person using
it. How it is built is in [Strata renderer](strata-renderer.md#the-genre-atlas-on-the-same-engine).

## Opening it

Choose **Genres** in the navigation. The pane opens on the **Atlas**; **Tree** shows the flat genre
tree instead. The Insights pane shows the same atlas, with the same year and selection.

The atlas is computed once a month. The heading line says which month the map is laid out for.
Positions are that month's pinned map: scrubbing time repaints stages and moves nothing. Before the
first monthly run there is nothing to draw, and the view says so. The stage rule is still shown.

## The three planes

- **Genres** are the top plane, round a ring.
- **Styles** are the middle plane. A style is drawn once, under its main (dominant) genre. A style
  that belongs to several genres also appears as a hollow **ghost copy** under each of the others, so
  a genre's region shows everything that belongs to it. A ghost is the same style: selecting one
  describes the style, and its panel says where the real node is.
- **Masters** are the bottom plane for landmark masters. None are served yet, so the plane is empty
  and says "none served". Soloing it, or opening the table, shows why.

A thin line joins a style to each parent genre it **emerged after**: an *emergence edge*. A style's
panel lists every parent with its share of the style's releases, which one is dominant, and whether
that parent's emergence edge is drawn.

Selecting a style also draws lines to its **co-tagged styles**: the styles most often tagged
together with it (up to 25, by the number of releases they share). They are fetched when you select
the style, and cleared when you select something else or clear the selection. A line is drawn only
when both styles are in the atlas. Any co-tagged style the atlas does not draw is listed in the
panel under "Also co-tagged, not drawn in this atlas", so nothing is dropped silently. If the
co-tags cannot be loaded, the panel says so and the rest of the atlas keeps working; select the
style again to retry.

## The stages

Every style has one stage in every year of the timeline. The stage is computed from how many
releases the style has per year, by a fixed rule:

| Stage | A style is in it when |
| --- | --- |
| **Absent** | It has not yet reached 25 cumulative releases. |
| **Emerging** | Its recent releases per year are still at least half of its best years, and it reached 25 releases less than 10 years ago. |
| **Established** | The same, but it reached 25 releases 10 or more years ago. |
| **Reviving** | Its recent releases per year have fallen below half of its best years, but have come back to at least 1.5 times its worst years and a quarter of its best years. |
| **Declining** | None of the above: its recent releases per year are below half of its best years. |

"Recent" is a trailing average over 3 years. **Emergence** is the first year a style reaches 25
cumulative releases, not the year of its first release.

The numbers above are the rule's values today. The atlas shows the rule it was actually computed
with, under **Stage rule** in the panel: every stage with its condition, every threshold by name,
and the revision, such as "Stage rule (version 1)". If the rule changes, the panel changes with it.
The full identifier the server reported is on a small "Rule id" line, for reporting a problem.

Color is never the only cue. Every stage is also a word, in the legend, the panel, and the table.

## Why the recent years are provisional

The catalogue is still catching up on the newest years: releases are added after they come out, so
the counts for the latest years only grow. A stage computed from them can change. The atlas therefore
marks the **latest 2 years** of the timeline as *provisional*:

- on the year slider they are hatched, and the year shown beside it is marked "provisional" while
  you are on one;
- in the 3D view a provisional year draws every node with a dashed outline;
- in a style's panel the stage in the scrubbed year carries a "provisional" badge, and the
  **latest** stage is shown beside its **settled** stage: the stage in the last year that is not
  provisional. If they differ, the settled stage is the one to trust until the catalogue catches up;
- in the table, the Provisional column says "provisional" or "settled".

## Scrubbing time

The **Music as of** slider moves through the timeline one year at a time; **Play** runs it from the
start (or from where you are) to the end. Stages repaint, the legend counts follow, and a selected
style's panel gives its stage in that year. The slider is shared by the 3D view and the table.

## The 3D view

Drag to orbit and tilt, scroll to zoom, and click a node to describe it. The view has a keyboard
path for everything the pointer does. Focus the view, then use:

| Key | Does |
| --- | --- |
| Arrow keys | Orbit and tilt |
| `+` and `-` | Zoom; `0` resets the camera |
| `1`, `2`, `3` | Show only the genres, styles, or masters plane; press it again to show all |
| `[` and `]` | Move to the previous or next node on the plane |
| PageUp and PageDown | Move to the genre a style is drawn under, or to a genre's first style |
| Escape | Clear the selection, then the single plane |

## The table

Choose **Table** in the view toggle above the map. The table needs no 3D graphics, so it opens where
WebGL does not. It lists every genre, each followed by the styles drawn under it. Ghost copies are not
rows; the Parents column says where a style is also drawn. The columns are:

| Column | Says |
| --- | --- |
| Kind | Genre or style |
| Name | The genre or style |
| Stage in *year* | The stage in the year on the slider. A genre has none |
| Provisional | Whether that year is provisional |
| Latest stage | The stage in the last year of the timeline (provisional) |
| Settled stage | The stage in the last year that is not provisional |
| Emerged | The year it reached 25 cumulative releases, or "not yet" |
| Dominant parent | The genre the style is drawn under |
| Parents (share of releases) | Every parent genre with its share |
| Emergence edges drawn | For each parent, whether its emergence edge is drawn |

- **Sort** by any column with its header button: ascending, then descending, then the outline order
  again. The result is announced to a screen reader. Rows with nothing in the column go last.
- **Keyboard**: one row is the tab stop. Up and Down move between rows, Home and End go to the first
  and last, PageUp goes to a style's dominant parent genre and PageDown to a genre's first style,
  Space or Enter selects a row and describes it in the panel, and Escape clears the selection.
- The selection, the slider, and the panel are shared with the 3D view: select a row and the 3D view
  shows the same node when you switch back, and the reverse.

On a narrow screen the panel moves under the view instead of beside it, and the table scrolls
sideways.
