# Discography Strata

Discography Strata shows one artist's whole discography at once: their credits, the masters under
them, and every pressing, as three stacked planes. It sits in the **Explore** pane beside the graph,
and it has a **table** that lists the same things as rows. This page is for the person using it. How
it is built is in [Strata renderer](strata-renderer.md).

## Opening it

Search for an **Artist** in the Explore box and submit a result. Once an artist is centered, the
**Graph**, **Strata**, and **Table** buttons above the view are all available. They stay disabled for
a genre, label, or style, because the strata draw one artist. The view you chose last is remembered
and opens again the next time an artist is centered.

You do not need to sign in to look. Signing in adds what you want and own, described below.

## The two views

Both views show the same entries from the same request, so a page you open in one is the page you
see in the other.

### The 3D view

- **Credits** are the top plane: the artist, and the credits they share with others.
- **Masters** are the middle plane.
- **Releases** are the bottom plane, one disc for each pressing.
- A **count node** stands in for a group that did not fit, such as "8 masters, 1993–2015" or "+15
  pressings". **Releases without a master** is a lane of its own on the masters plane.

Labels never overlap one another or the outlined credit chips: when they would, the lower-priority one
is left out until you zoom in or select something. Pressings of one master that share a title are one
label with a count, such as "Willow Orbit ×6", over the middle of those pressings. The pressing you
select or hover keeps a label of its own.

Drag to orbit and tilt, scroll to zoom, and click a node to describe it in the panel. Opening a count
node, a lane, or a master requests it as a page of its own, and the panel's trail shows where you are,
with **Previous page**, **Next page**, and **Back**, which returns to where you came from. **Back** is
there from the first time you open something, not only after you turn a page. Pages wrap around.

The 3D view has a keyboard path for everything the pointer does. Focus the view, then use:

| Key | Does |
| --- | --- |
| Arrow keys | Orbit and tilt |
| `+` and `-` | Zoom; `0` resets the camera |
| `1`, `2`, `3` | Show only the credits, masters, or releases plane; press it again to show all |
| `[` and `]` | Move to the previous or next node on the plane |
| PageUp and PageDown | Move to the parent, or to the first child |
| Enter | Open a count node, lane, or master |
| Escape | Clear the selection, then the single plane |

### The table

The table is a view of its own, not a fallback: it needs no 3D graphics, so it opens where WebGL does
not. Where your browser cannot start WebGL, the **Strata** view still loads the artist's summary and
says that it cannot draw the planes, and the **Table** shows the same discography. It lists **every** credit, group, master, and pressing the request returned, including those the
3D view folded into a count node. The "In the 3D view" column says which. The columns are the kind, the
name, what it sits under, its year, its collector state, why it cannot change state, how many releases it
holds, where the 3D view drew it, and a button to open it.

- **Sort** by any column with its header button: ascending, then descending, then the outline order
  again. The result is announced to a screen reader.
- **Only what cannot change state** shows only the rows that carry a reason in "Cannot change
  because": the MusicBrainz-only pressings, and the credits, masters, and groups that hold some.
- **Keyboard**: one row is the tab stop. Up and Down move between rows, Home and End go to the first
  and last, PageUp goes to the row's parent and PageDown to its first child, Space selects a row and
  describes it in the panel, Enter opens a group or master (and otherwise selects), and Escape clears the
  selection.

On a narrow screen the panel moves under the view instead of beside it.

## The two clocks

Strata has two separate time controls, because "when was this released" and "when did I have it" are
different questions.

- **Released** is valid time: the year the music came out. It is the year scrubber the Explore pane
  already has. Choose the **Released** button to show it, and drag it: entries released after that year
  are hidden, with everything under them. Entries with no year stay, and so does the artist's own
  credit. The button reads *Released to 1995* while it is set, and the scrubber's reset puts it back to
  *All*.
- **Recorded as of** is transaction time: a date on which to see your wantlist and collection as Discogs
  recorded them. It uses the date Discogs gives each item as the day it was added, so moving the slider
  back shows a pressing as *wanted* before the day it became *owned*. It is available once you are
  signed in and some of your items carry a date, and *now* is the right-hand end.

Moving either clock changes the colors and the rows. It does not move the nodes. In the past, a count
node's own totals are today's and say nothing about then, so they are drawn without a state, and a
master or credit takes its state only from the pressings drawn under it. The summary says so while you
are looking at the past, and **Record an observation** is off there, because history is read-only.

## What you want and own

When you are signed in, each pressing carries one of four states from your Discogs wantlist and
collection: **none**, **wanted**, **owned**, or **wanted + owned**. A master or credit shows the states
of what it holds. **Only what I collect** keeps the entries that hold something you want or own,
together with what they sit under.

These states are **observed only**. GrooveMap never writes to your Discogs wantlist or collection and
has no control that does. A state changes when Discogs reports a change at your next sync, and not
before. A selected pressing offers at most these actions:

- **Open on Discogs** opens its Discogs page in a new tab, for a pressing, a master, or an artist.
- **Sync now** asks GrooveMap to start a Discogs sync. It reads your wantlist and collection from
  Discogs; it does not change them. It is offered on any Discogs pressing when you are signed in. A
  second request within a minute is declined, and the panel says so. When it finishes, reopen the view
  to see what changed.
- **Record an observation** is offered on a pressing you own, and only while **Recorded as of** is *now*.
  It saves a note about your copy: a matrix or run-out inscription, a grading, a purchase price, or a free
  note. It is recorded against your earliest-acquired copy of that pressing, which GrooveMap already
  knows from the view, so nothing reads your collection to find it. If the copy has no GrooveMap identity
  yet, the button is off and the panel asks you to run **Sync now** and reload the view. If GrooveMap
  could not read your copy's identity just now, the button is off and says so. An observation is a note
  about the copy. It does not add or remove anything from Discogs.

A signed-out visitor sees the discography with no states: **Only what I collect** and **Recorded as
of** are disabled, and the summary says that signing in shows what you want and own.

## Pressings that exist only in MusicBrainz

Some pressings are known to MusicBrainz and have no Discogs release. They are drawn with a **red ring**
in the 3D view and a **no state** chip in the table. They have no collector state at all, which is
different from *none*, because no wantlist or collection entry at Discogs can refer to them. Selecting
one says that it exists only in MusicBrainz, so GrooveMap has no collector state for it, and it offers no actions: no Discogs page, no sync, and no observation. The summary
counts them ("13 MusicBrainz-only"), and the table lists them with **Only what cannot change state**.

## Finding something

**Find a master or pressing** selects a match that is drawn in the current view, best match first. In the
table it also finds entries the 3D view folded into a count node. If nothing drawn matches and you typed
at least three characters, it searches the catalog and opens the view on the best hit that belongs to this
artist: a master opens on its pressings, and a pressing opens on the page that holds it, however deep in
a large master or in the releases without a master, and is selected. A MusicBrainz-only pressing opens the
same way. A hit that belongs to another artist is skipped. If no hit does, the view says nothing by that
name is in this discography and stays where it was. **Back** returns to the view you searched from.

## Large artists, and slow reads

Strata draws artists with up to **134,051** releases. For an artist above that, the view says how many
releases they have and the ceiling, and that it cannot open this one. The **Graph** view still works
for them. If the catalog takes too long to answer, the read is stopped and the view says so; trying
again a moment later usually works. A discography part that has since gone away asks you to go back
to the overview.
