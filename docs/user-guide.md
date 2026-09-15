# Graph Explorer user guide

The public application opens on **Explore**. Choose Artist, Genre, Label, or Style in the top
search control, enter at least three characters for suggestions, and submit a result to center the
graph. Select nodes to inspect details and expand relationships; the graph controls zoom, reset,
full-screen view, timeline filtering, year comparison, and shareable snapshots.

The always-visible navigation provides these public workflows:

- **Explore** renders the interactive relationship graph and timeline.
- **Trends** compares time-series data for selected entities.
- **Find Path** finds a connection between two named entities.
- **Search** filters artists, labels, masters, and releases, including canonical media families.
- **Insights**, **Genres**, and **Credits** show catalog summaries, taxonomy, and contributor
  provenance.
- **Will it fit?** scores one candidate release against your own collection. It is reachable
  signed out, where it asks you to log in rather than disappearing from the navigation.
- The floating **Ask** control streams natural-language answers and applies only allowlisted,
  schema-validated browser actions. Unsupported actions remain visible as failures.

After login, the personal navigation exposes **Collection**, **Wantlist**, **Discover**, and the
contextual **Missing** analysis. Connect Discogs and start a collection sync from the account menu.
Account Settings owns password changes, two-factor authentication, application-token management,
and the **Privacy**, **Export Your Data**, and **Delete Account** cards. Authentication, OAuth,
sync, snapshots, and catalog data are all performed by `catalog-api` through the same-origin proxy.

## Will it fit?

**Will it fit?** answers the question a collector asks with a record in their hands: given
everything you already own, is this one for you? Find the release, pick it from the results, and
press **Will it fit?**. The profile is computed against your own collection, so the pane shows a
sign-in prompt and no picker until you are logged in.

The answer is a decomposition, not a verdict. A single number answers none of the five questions a
collector is actually asking at once, so the card shows all five, each with its own score bar and
the evidence behind it — facts stated in your own holdings, never in the catalog at large:

| Component | The question it answers |
| --- | --- |
| Affinity | How much of this you already collect |
| Novelty | How much of it is new to you |
| Bridge | Whether it joins two corners of your collection that do not touch |
| Depth | What it extends that you are already building |
| Redundancy | Whether you already have this record, in this form or another |

**Overall fit** is the combined score across the top of the card, and it is an arithmetic
consequence of the five: affinity, novelty, bridge and depth added, redundancy subtracted,
clipped to the 0–100% range. It is the summary; the five rows are the answer.

Three things sit beside the score rather than inside it:

- **The identity badge** reads *exact release* or *master only*. It says how sure the service is
  that it scored the record in your hand, which is a different question from how well that record
  fits. A component that turns on a pressing — media family, label, year — is answering about an
  edition you may not be holding when the badge reads *master only*.
- **The rarity tier**, when the catalog has one, is a fact about the record and is never an input
  to any component. A common record you obviously want should not read as a worse buy than a rare
  one you do not.
- **The scoring version** in small print names the procedure that produced the five scores. The
  components are a version's judgement, not a fact about the record, and a later version will
  score the same record differently.

A component with nothing to say shows no evidence. That is a real answer: a sparse collection, or
one with no overlap with the candidate, legitimately leaves components silent.

### The landing point

Scoring a release also draws its **landing point** — the candidate at the centre of the graph with
the artists, labels, genres, and styles its evidence named arranged around it. **See the landing
point** on the card takes you to the graph view with it drawn. It is a picture of where the record
would sit relative to what you already own.

### What version 0 cannot do yet

- **Discogs release ids only.** You pick a candidate by searching the catalog for a release. There
  is no barcode or catalogue-number lookup, so a record whose title you cannot read cannot be
  scored yet.
- **A release, not a master.** The picker searches releases because the underlying route takes a
  release id. Picking the wrong pressing of the right record is possible, and the identity badge is
  what tells you which one was scored.
- **The bridge score is a heuristic.** Version 0 stands genres in for the communities in your
  collection, because nobody has computed those communities. A high bridge score is a hint worth
  looking at, not a claim about your collection's structure, and the card says so in that
  component's own evidence.
- **The weights are not learned.** Nothing about version 0 is trained on what collectors do. The
  outcomes you report from this pane are what will eventually produce that evidence, which is why
  every profile names the version that scored it.

## Recording what you do

Each recommendation in **Discover** carries **Save**, **Dismiss**, and **Hide** controls; opening
one, and opening a search hit, is recorded too. A fit profile carries the same three controls,
bound to the showing you read. Dismissed and hidden recommendations collapse and
do not come back. A signed-out visitor sees none of these controls and has nothing recorded.
[Activity events and account data controls](activity-and-account-data.md) describes exactly what
each action records and what the three settings cards do.

## Keyboard and accessibility behavior

- Use Tab and Shift+Tab for native links, buttons, inputs, and selects. Main and personal
  navigation regions have accessible labels; loading indicators use status roles.
- In the main and Credits autocomplete lists, use Arrow Down/Arrow Up, Enter, and Escape.
- Open **Ask** with Control+K, Command+K, or `?`; Enter submits from its input and Escape collapses
  it. The Ask close and answer-clear controls expose accessible names.
- Escape closes the account and Discogs connection dialogs and exits graph full-screen mode.
- The Missing pane's media control is a native multi-select grouped by family. Its accessible name
  is “Media,” and its hint explains that no selection includes all media.

These behaviors are exercised across Chromium, Firefox, WebKit, iPhone, and iPad projects by
`just e2e`. Unit tests cover keyboard event handling and state transitions that do not require a
full browser.
