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
- The floating **Ask** control streams natural-language answers and applies only allowlisted,
  schema-validated browser actions. Unsupported actions remain visible as failures.

After login, the personal navigation exposes **Collection**, **Wantlist**, **Discover**, and the
contextual **Missing** analysis. Connect Discogs and start a collection sync from the account menu.
Account Settings owns password changes, two-factor authentication, application-token management,
and the **Privacy**, **Export Your Data**, and **Delete Account** cards. Authentication, OAuth,
sync, snapshots, and catalog data are all performed by `catalog-api` through the same-origin proxy.

Each recommendation in **Discover** carries **Save**, **Dismiss**, and **Hide** controls; opening
one, and opening a search hit, is recorded too. Dismissed and hidden recommendations collapse and
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
