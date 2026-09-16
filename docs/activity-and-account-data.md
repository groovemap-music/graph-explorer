# Activity events and account data controls

The explorer records what a signed-in collector does with a recommendation or a fit profile, and
gives that collector three controls over the resulting data: consent per purpose, a full export, and
account deletion. Both halves are decided together in
[ADR 0010](https://github.com/groovemap-music/design/blob/main/docs/adr/0010-first-party-events-consent-and-deletion.md),
which owns the event vocabulary, the consent purposes, and the erasure procedure. This
document describes only what the browser application does with them.

Nothing here is computed or stored in `graph-explorer`. The browser posts to `catalog-api`
through the same-origin `/api` proxy, and `catalog-api` decides what is written, whether
consent permits it, and what erasure removes.

## What the browser records

Every event is posted to `POST /api/activity/events` carrying an event type, the
`impression_id` the API issued with the item, and the item's native `gm_id`. An outcome is
attributed to the impression, which is why an item the API issued no impression for records
nothing at all.

| Surface | User action | Event type |
| --- | --- | --- |
| Discover | Opening a recommendation (the title click-through) | `recommendation.opened` |
| Discover | Save | `recommendation.saved` |
| Discover | Dismiss | `recommendation.dismissed` |
| Discover | Hide | `recommendation.hidden` |
| Search | Opening a hit that carries an impression | `recommendation.opened` |
| Will it fit? | Save | `fit.saved` |
| Will it fit? | Dismiss | `fit.dismissed` |
| Will it fit? | Hide | `fit.hidden` |

The fit pane posts against the `fit` surface, not the `recommendation` one: `catalog-api`
records a fit impression against the literal fit surface, under the `cratefit_v0` policy id,
and an outcome has to name the same surface the impression it is attributed to was shown
under. The two surfaces mirror each other term for term — `fit.saved`, `fit.dismissed`, and
`fit.hidden` behave exactly as `recommendation.saved`, `recommendation.dismissed`, and
`recommendation.hidden` do — so what tells a fit row apart from a Discover row in the stored
data is the surface the event names, not any difference in behaviour.

Reading a profile records nothing from the browser. The showing is written server side as a
`fit.shown` impression when `catalog-api` composes the response, exactly as a recommendation
impression is, and the `impression_id` it returns is what the three controls attribute an
outcome to. There is no fit equivalent of the Discover click-through: the pane is where the
release is read, so there is nothing to open.

Search records only the open. Hits are already logged server side as
`search.result_impression` when the API returns them, and the version 1 vocabulary has no
search-specific open term, so an opened hit is attributed to the impression the hit carries
and nothing further is recorded from the search pane. Search hits render no Save, Dismiss,
or Hide affordance.

`recommendation.shown` and `fit.shown` are in the vocabulary but neither is a browser event:
each impression is written by `catalog-api` when it composes the response, not by the page
that renders it.

### What is never recorded

- **An anonymous session records nothing.** With no token the outcome controls are not
  rendered, and the click-through emits no event. This is not a consent question — an
  anonymous visitor has no subject to attribute an event to.
- **An item with no `impression_id` records nothing**, and renders no outcome controls,
  because there is nothing for an outcome to attach to. A fit profile for a release the alias
  table carries no native id for comes back with a null `impression_id` for exactly this reason,
  and its card renders no Save, Dismiss, or Hide.
- **Consent is enforced upstream.** The browser posts the same events whatever the consent
  state; `catalog-api` decides what is durably written. Revoking a purpose in the Privacy
  card is not a client-side mute.

### Events are fire-and-forget

An outcome post is telemetry, never a step in the interaction it accompanies. It is not
awaited, a rejection is swallowed, and a client that throws synchronously is caught. A failed
or slow post therefore cannot stall a click-through, block navigation, or leave an unhandled
rejection. Nothing in the interface reports whether an event was recorded, because nothing in
the interface depends on it.

### Save, Dismiss, and Hide in the interface

The three controls are real buttons on each recommendation row and on a fit profile card,
reachable by Tab and activated by Enter and Space with no key handling of the application's own.
The glyph is `aria-hidden` and the accessible name comes from an `aria-label` naming the release.

- **Save** marks the row and is terminal. The vocabulary has no un-save verb, so a repeat
  click records nothing.
- **Dismiss** and **Hide** collapse the row — or, in the fit pane, the whole profile card — and
  remove it. There is no undo: the outcome is already recorded upstream, so an undo affordance
  would promise a retraction the browser cannot perform.

## Account data controls

Three cards in Account Settings, all visible only to a signed-in collector.

### Privacy

Renders both published consent purposes, in vocabulary order, whether or not the server has
ever recorded a decision for either:

| Purpose | What it permits |
| --- | --- |
| `product_analytics` | Counting what happens in the app to see what works |
| `model_training` | Using recorded activity to improve the recommendation models |

A toggle writes through `PUT /api/user/consent/{purpose}` and the card re-renders from the
server's answer rather than from the click, so a refused change shows what was actually
stored. Both toggles go inert while a write is in flight, so a second click cannot race the
first.

### Export Your Data

Downloads the body of `GET /api/user/export` as `groovemap-export.ndjson`. The export is a
finite NDJSON body, not a stream, so the proxy needs no streaming allowance for it.

### Delete Account

Opens an in-card confirm panel in the style of the two-factor disable confirm. It requires
the current password, and a six-digit authenticator code as well when the profile reports
two-factor enabled. On confirmation it calls `POST /api/user/erasure`, which answers `202
Accepted`.

### The erasure receipt

The `202` carries an erasure id and, when a store did not finish, a list of what remains.
That id is the only durable handle the collector has on a partially completed erasure, so it
has to survive the sign-out the erasure itself causes.

It does, but only in memory. The receipt is held in module state in the settings module,
outside the pane state the session clear empties, and rendered once onto the signed-out view
in a region that sits outside every pane, with a dismiss control. It is deliberately **not**
written to `localStorage`: the erasure has just emptied that key space for this account, and
a receipt persisted there would outlive the session on a shared machine. The consequence is
that reloading the page loses the receipt. That is the intended trade for a one-time notice
rather than a record the browser is responsible for keeping.

### A wrong erasure password keeps the session

`catalog-api` answers an incorrect erasure password with `401`, the same status an expired or
revoked bearer token produces. `requestErasure` declares itself a credential re-check on the
request, and the shared `ApiTransport.checkAuthResponse` only ends the session for that kind
of call when the response's `WWW-Authenticate` header shows the rejection is about the bearer
token rather than the password — every token-validation failure sets it, and a route's own
credential check does not. A wrong password therefore leaves the confirm panel open with the
detail inline and the collector signed in; an actually expired session on the same endpoint
still signs out. The two-factor disable card and change-password form re-authenticate the
same way and carry the same declaration.
