# Transient Missing and physical-copy evidence integration

These bounded source changes use the existing Missing, Collection and Discography Strata
surfaces under [ADR 0019](https://github.com/groovemap-music/design/blob/6303d58e89be71b651ea55d4d9c9588641b82475/docs/adr/0019-metadata-and-collection-prototype-boundaries.md).
They do not establish real-user usefulness, source completeness, production exposure approval,
or a release/deployment result. Browser examples are synthetic route responses.

## Producer contract and source proof

The promoted [source record](../contracts/catalog-api/graph-explorer/v1/source.json) pins
`catalog-api` commit `573cb02881b9910e30624c1f727071b7200c69a4`, with routes SHA-256
`76fefc73281f42d9995de15a081480b32d969e53edf16e75db4e9020dba5653e`.
That pin moves from `ecb6408` without changing the routes bytes. `catalog-api` 573cb02 (gm-catalog-api-ntnw)
adds the `id` query parameter to `/api/explore` and `/api/expand` for type=label, and the promoted
route contract does not yet list it. The consumer sends `id` only for label explore and expand, and keeps
sending the name for older APIs. `/api/path` has no id parameter at this pin.
That immutable producer commit is on integrated producer main. The Missing and owner-copy
operations are unchanged from the earlier pin `fab7e993384f032a0ea78817cbdcba798a2e97f8`;
the later pins add only the `node_label` operation, and the `longevity_rank` and `longevity_rank_of` response fields (`842e6cd` then `a378a88`). No consumer source import or runtime dependency
on the producer checkout is introduced. With sibling source checkouts, reproduce the proof:

```sh
git -C ../catalog-api merge-base --is-ancestor 573cb02881b9910e30624c1f727071b7200c69a4 main
uv run python scripts/check-contracts.py --producer-repo ../catalog-api
just check
just e2e
```

`just e2e` runs Firefox, Chromium, WebKit, iPhone and iPad projects, instruments browser
JavaScript for coverage, and restores source files on exit. Focused evidence is in
`explore/__tests__/missing-preview.test.js`, `explore/__tests__/copy-evidence.test.js`,
`explore/__tests__/strata-explore.test.js` and `tests/e2e/test_missing_copy_views.py`.
The source checks use fake stores and browser responses; no real-store completeness or
real-user quality evaluation is claimed.

## Missing preview

`ApiClient.previewMissing` posts only `target_kind`, Discogs provider `target_id` and a
bounded `limit` to the authenticated `/api/user/missing/preview` route. Artist and label
contexts are supported. Master contexts keep the existing list and show unsupported preview.
There is no saved scope or owner/fact/mapping input.

The preview shows known eligible **native editions**, owned/missing counts, ownership review,
eligibility review and exclusions. Multiple physical copies count once. Catalog, alias and
ownership read windows and unknown source versions are displayed independently; they are
not a shared snapshot. Missing identity, failed reads and reverse-lookup truncation remain
unknown/review evidence. A bounded Neo4j projection never proves the provider universe:
the real adapter always returns `denominator_complete=false` and a null completion fraction.
No percentage is shown for incomplete, unavailable, unknown-version or truncated sources,
review counts, zero/contradictory denominators, or a completion fraction inconsistent with the supplied owned count. Complete examples exist only in tests.

The existing gap list retains media filters, pagination and Hide wantlisted, including on
empty results. Its summary is explicitly scoped to its list projection. These controls do
not filter preview counts: the producer supports no media, year, country, label-ancestry or
work-unit preview controls. Wantlist hiding is not catalog eligibility.

## Copy selection and timeline

Collection's Physical copies button uses the row's native `gm_item_id` with
`ApiClient.getOwnedCopies` (`GET /api/user/items/{native_item_id}/copies`, default 50).
It never falls back to the old singular `owned_copy_id`. Multiple returned copies require
an explicit choice. A single copy can preselect only when the response explicitly reports
an untruncated list; identity remains visible. Empty, unavailable, unknown and truncated
reads are named honestly.

Strata already carries owner-scoped `ownedCopyIds`; its release IDs (`r:`/`mb:`) are not
native item UUIDs. It uses only those returned copy IDs, never an identifier lookup, Fit
request or collection scan. Its synced-copy projection cannot prove a full native-copy
list, so completeness remains unknown and even a single returned copy requires selection.
The displayed copy list is capped at 50 and excess IDs are marked truncated.

Both homes use `CopyEvidence` to GET observations and append a new observation against the
same explicitly selected physical copy. Timeline entries retain kind, source and confidence;
Observed at and Recorded at are separate labels. Timeline GET remains all recorded history,
including when Strata's historical view is selected. Historical view keeps its write lock.
Unknown and foreign-copy 404 responses have the same unavailable presentation. Appends do
not edit, delete, retract, supersede or correct evidence, catalog facts or collector state.

Scope, release, copy, principal and logout changes clear transient selection/evidence and
invalidate late GET/POST successes and errors. These private views are not added to URLs,
history, local storage, exported or shared state. Existing authentication storage remains
owned by AuthManager. Saved pursuit persistence, observation correction, production matching,
release and deployment require their separate owner gates.
