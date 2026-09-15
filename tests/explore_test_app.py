"""Test application factory for graph-explorer E2E tests."""

import json
from collections.abc import AsyncGenerator  # noqa: TC003  # Required for runtime annotation evaluation.
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles


# Mock Neo4j data
MOCK_AUTOCOMPLETE_RESULTS: dict[str, list[dict[str, Any]]] = {
    "artist": [
        {"id": "1", "name": "Radiohead", "score": 9.5},
        {"id": "2", "name": "Radio Dept.", "score": 7.2},
    ],
    "genre": [
        {"id": "Rock", "name": "Rock", "score": 1.0},
        {"id": "Rockabilly", "name": "Rockabilly", "score": 1.0},
    ],
    "label": [
        {"id": "100", "name": "Warp Records", "score": 9.0},
        {"id": "101", "name": "Warp", "score": 7.0},
    ],
}

MOCK_EXPLORE_RESULTS: dict[str, dict[str, Any]] = {
    "artist": {
        "id": "1",
        "name": "Radiohead",
        "release_count": 42,
        "label_count": 5,
        "alias_count": 2,
    },
    "genre": {
        "id": "Rock",
        "name": "Rock",
        "artist_count": 1000,
        "label_count": 200,
        "style_count": 50,
    },
    "label": {
        "id": "100",
        "name": "Warp Records",
        "release_count": 500,
        "artist_count": 120,
    },
}

# Mock auth data
MOCK_USER: dict[str, Any] = {
    "id": "00000000-0000-0000-0000-000000000001",
    "email": "test@example.com",
    "is_active": True,
    "created_at": "2026-01-01T00:00:00",
}

MOCK_TOKEN = "mock-test-access-token-abc123"  # nosec B105

MOCK_COLLECTION: dict[str, Any] = {
    "releases": [
        {"id": "10", "title": "OK Computer", "artist": "Radiohead", "label": "Parlophone", "year": 1997},
        {"id": "11", "title": "Kid A", "artist": "Radiohead", "label": "Parlophone", "year": 2000},
    ],
    "total": 2,
    "offset": 0,
    "limit": 50,
    "has_more": False,
}

MOCK_WANTLIST: dict[str, Any] = {
    "releases": [
        {"id": "20", "title": "In Rainbows", "artist": "Radiohead", "label": "Self-released", "year": 2007},
    ],
    "total": 1,
    "offset": 0,
    "limit": 50,
    "has_more": False,
}

# Recommendations carry the impression and native identifiers the API issues with
# them. An outcome event is attributed to impression_id, and gm_id says what was
# recommended, so a row without both renders no outcome controls at all.
MOCK_RECOMMENDATIONS: dict[str, Any] = {
    "recommendations": [
        {
            "id": "30",
            "title": "Pablo Honey",
            "artist": "Radiohead",
            "year": 1993,
            "score": 0.85,
            "impression_id": "11111111-1111-1111-1111-111111111111",
            "gm_id": "gm:release:30",
        },
        {
            "id": "31",
            "title": "The Bends",
            "artist": "Radiohead",
            "year": 1995,
            "score": 0.72,
            "impression_id": "22222222-2222-2222-2222-222222222222",
            "gm_id": "gm:release:31",
        },
    ],
    "total": 2,
}

# One candidate release the fit picker can find, and the profile the fit route
# answers for it. The profile is a full one — five components, every one with
# evidence, a native id and an impression — because the browser test walks the
# whole card and then reports an outcome against the impression it carries.
MOCK_RELEASE_SEARCH: dict[str, Any] = {
    "results": [
        {
            "id": "249504",
            "name": "Never Gonna Give You Up",
            "type": "release",
            "relevance": 0.91,
            "metadata": {"artist": "Rick Astley", "year": 1987, "media_families": ["vinyl"], "genres": ["Electronic"]},
        },
    ],
    "total": 1,
    "facets": {"type": {"release": 1}},
    "pagination": {"limit": 20, "offset": 0},
}

MOCK_FIT_PROFILE: dict[str, Any] = {
    "release": {
        "id": "249504",
        "gm_id": "gm:release:249504",
        "title": "Never Gonna Give You Up",
        "artist": "Rick Astley",
        "year": 1987,
        "media_families": ["vinyl"],
        "rarity": {"score": 0.31, "tier": "common"},
    },
    "fit": 0.62,
    "components": {
        "affinity": {"score": 0.55, "evidence": ["shares artist Rick Astley with 2 releases you hold"]},
        "novelty": {"score": 0.4, "evidence": ["Stock Aitken Waterman is a label your collection has never held"]},
        "bridge": {
            "score": 1.0,
            "evidence": [
                "bridges Electronic and Rock, which share no artist or label in your collection",
                "region boundaries are the v0 genre heuristic, not a computed community",
            ],
        },
        "depth": {"score": 0.4, "evidence": ["deepens artist Rick Astley (2 held)"]},
        "redundancy": {"score": 0.0, "evidence": []},
    },
    "confidence": "exact",
    "policy_id": "cratefit_v0",
    "fit_version": "cratefit_v0",
    "impression_id": "33333333-3333-3333-3333-333333333333",
}

MOCK_COLLECTION_STATS: dict[str, Any] = {
    "total_releases": 42,
    "unique_artists": 15,
    "unique_labels": 8,
    "average_rating": 4.2,
}


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
    """Manage test app lifecycle."""
    yield


def create_test_app() -> FastAPI:
    """Create a test instance of the Explore FastAPI app."""
    app = FastAPI(
        title="GrooveMap Graph Explorer Test",
        version="0.1.0",
        default_response_class=JSONResponse,
        lifespan=lifespan,
    )

    @app.get("/health")
    async def health_check() -> JSONResponse:
        return JSONResponse(
            content={
                "status": "healthy",
                "service": "graph-explorer",
                "timestamp": datetime.now(UTC).isoformat(),
            }
        )

    # ------------------------------------------------------------------ #
    # Auth endpoints
    # ------------------------------------------------------------------ #

    @app.post("/api/auth/register", status_code=201)
    async def auth_register(request: Request) -> JSONResponse:
        """Accept any well-formed registration request."""
        body = await request.json()
        if not body.get("email") or not body.get("password"):
            return JSONResponse(content={"error": "Invalid request"}, status_code=422)
        return JSONResponse(content={"message": "Registration processed"}, status_code=201)

    @app.post("/api/auth/login")
    async def auth_login(request: Request) -> JSONResponse:
        """Accept test@example.com / testpassword; reject everything else."""
        body = await request.json()
        email = body.get("email", "")
        password = body.get("password", "")
        if email == "test@example.com" and password == "testpassword":
            return JSONResponse(
                content={
                    "access_token": MOCK_TOKEN,
                    "token_type": "bearer",
                    "expires_in": 3600,
                }
            )
        return JSONResponse(content={"detail": "Invalid credentials"}, status_code=401)

    @app.post("/api/auth/logout")
    async def auth_logout(authorization: str | None = Header(default=None)) -> JSONResponse:
        """Accept any Bearer token and confirm logout."""
        return JSONResponse(content={"logged_out": True})

    @app.get("/api/auth/me")
    async def auth_me(authorization: str | None = Header(default=None)) -> JSONResponse:
        """Return mock user for any Bearer token."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        return JSONResponse(content=MOCK_USER)

    # ------------------------------------------------------------------ #
    # Discogs OAuth endpoints
    # ------------------------------------------------------------------ #

    @app.get("/api/oauth/authorize/discogs")
    async def oauth_authorize_discogs(authorization: str | None = Header(default=None)) -> JSONResponse:
        """Return a mock Discogs authorization URL."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        return JSONResponse(
            content={
                "authorize_url": "https://www.discogs.com/oauth/authorize?oauth_token=mock_token",
                "state": "mock-oauth-state-abc123",
                "expires_in": 3600,
            }
        )

    @app.post("/api/oauth/verify/discogs")
    async def oauth_verify_discogs(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        """Accept verifier '12345678'; reject all others."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        body = await request.json()
        verifier = body.get("oauth_verifier", "")
        if verifier == "12345678":
            return JSONResponse(content={"connected": True, "discogs_username": "testuser", "discogs_user_id": "99999"})
        return JSONResponse(content={"detail": "Invalid verifier"}, status_code=400)

    @app.get("/api/oauth/status/discogs")
    async def oauth_status_discogs(authorization: str | None = Header(default=None)) -> JSONResponse:
        """Return disconnected status by default."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        return JSONResponse(content={"connected": False})

    @app.delete("/api/oauth/revoke/discogs")
    async def oauth_revoke_discogs(authorization: str | None = Header(default=None)) -> JSONResponse:
        """Confirm Discogs account disconnection."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        return JSONResponse(content={"revoked": True})

    # ------------------------------------------------------------------ #
    # User data endpoints
    # ------------------------------------------------------------------ #

    @app.get("/api/user/collection")
    async def user_collection(
        authorization: str | None = Header(default=None),
        limit: int = Query(50, ge=1, le=200),
        offset: int = Query(0, ge=0),
    ) -> JSONResponse:
        """Return mock collection for any authenticated user."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        return JSONResponse(content=MOCK_COLLECTION)

    @app.get("/api/user/wantlist")
    async def user_wantlist(
        authorization: str | None = Header(default=None),
        limit: int = Query(50, ge=1, le=200),
        offset: int = Query(0, ge=0),
    ) -> JSONResponse:
        """Return mock wantlist for any authenticated user."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        return JSONResponse(content=MOCK_WANTLIST)

    @app.get("/api/user/recommendations")
    async def user_recommendations(
        authorization: str | None = Header(default=None),
        limit: int = Query(20, ge=1, le=100),
    ) -> JSONResponse:
        """Return mock recommendations for any authenticated user."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        return JSONResponse(content=MOCK_RECOMMENDATIONS)

    @app.get("/api/user/collection/stats")
    async def user_collection_stats(authorization: str | None = Header(default=None)) -> JSONResponse:
        """Return mock collection stats for any authenticated user."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        return JSONResponse(content=MOCK_COLLECTION_STATS)

    @app.get("/api/user/status")
    async def user_release_status(
        ids: str = Query(...),
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        """Return empty ownership status (works for authenticated and anonymous users)."""
        release_ids = [rid.strip() for rid in ids.split(",") if rid.strip()]
        return JSONResponse(content={"status": {rid: {"in_collection": False, "in_wantlist": False} for rid in release_ids}})

    # ------------------------------------------------------------------ #
    # Search and the item-in-hand fit profile
    #
    # The fit route is authenticated the way the API authenticates it: the
    # profile is computed against the caller's own collection, so an anonymous
    # caller gets a 401 rather than somebody else's answer. Search is not.
    # ------------------------------------------------------------------ #

    @app.get("/api/search")
    async def search(
        q: str = Query(...),
        types: str = Query(""),
        limit: int = Query(20, ge=1, le=100),
        offset: int = Query(0, ge=0),
    ) -> JSONResponse:
        """Return the one stub release, or nothing when the query does not name it."""
        wanted = [t for t in types.split(",") if t]
        if wanted and "release" not in wanted:
            return JSONResponse(content={"results": [], "total": 0, "facets": {}, "pagination": {"limit": limit, "offset": offset}})
        matches = [r for r in MOCK_RELEASE_SEARCH["results"] if q.lower() in str(r["name"]).lower()]
        return JSONResponse(
            content={
                "results": matches,
                "total": len(matches),
                "facets": {"type": {"release": len(matches)}},
                "pagination": {"limit": limit, "offset": offset},
            }
        )

    @app.get("/api/fit/release/{release_id}")
    async def release_fit(
        release_id: str,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        """Return the stub fit profile, or the status the API would return."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        if release_id != MOCK_FIT_PROFILE["release"]["id"]:
            return JSONResponse(content={"error": f"Release '{release_id}' not found"}, status_code=404)
        return JSONResponse(content=MOCK_FIT_PROFILE)

    # ------------------------------------------------------------------ #
    # Activity events
    #
    # POST is the route the browser calls. GET and DELETE are test affordances
    # on the same path — the browser never issues either, so the contract check
    # (which matches the /api literals in the JavaScript) is unaffected — that
    # let a browser test read back what the page recorded and start from empty.
    # The server is session-scoped, so a test that asserts on the whole log
    # clears it first.
    # ------------------------------------------------------------------ #

    recorded_events: list[dict[str, Any]] = []

    @app.post("/api/activity/events", status_code=202)
    async def activity_events(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        """Record one outcome event; reject an anonymous caller the way the API does."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        body = await request.json()
        recorded_events.append(
            {
                "event_type": body.get("event_type"),
                "impression_id": body.get("impression_id"),
                "item_id": body.get("item_id"),
            }
        )
        return JSONResponse(content={"accepted": True}, status_code=202)

    @app.get("/api/activity/events")
    async def activity_events_recorded() -> JSONResponse:
        """Return what the page has recorded so far (test affordance)."""
        return JSONResponse(content={"events": list(recorded_events)})

    @app.delete("/api/activity/events")
    async def activity_events_reset() -> JSONResponse:
        """Drop the recorded log so one test does not read another's events."""
        recorded_events.clear()
        return JSONResponse(content={"events": []})

    # ------------------------------------------------------------------ #
    # Consent, export, and erasure endpoints
    # ------------------------------------------------------------------ #

    consent_state: dict[str, bool] = {"product_analytics": True, "model_training": False}

    @app.get("/api/user/consent")
    async def user_consent(authorization: str | None = Header(default=None)) -> JSONResponse:
        """Return both published purposes in vocabulary order."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        return JSONResponse(
            content={
                "purposes": [
                    {
                        "purpose": purpose,
                        "granted": granted,
                        "granted_at": "2026-01-01T00:00:00+00:00" if granted else None,
                        "revoked_at": None,
                    }
                    for purpose, granted in consent_state.items()
                ]
            }
        )

    @app.put("/api/user/consent/{purpose}")
    async def user_consent_set(
        purpose: str,
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        """Record the decision for one purpose and echo the stored state."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        if purpose not in consent_state:
            return JSONResponse(content={"detail": f"Unknown purpose {purpose!r}"}, status_code=422)
        body = await request.json()
        granted = bool(body.get("granted"))
        changed = consent_state[purpose] != granted
        consent_state[purpose] = granted
        return JSONResponse(content={"purpose": purpose, "granted": granted, "changed": changed})

    @app.get("/api/user/export")
    async def user_export(authorization: str | None = Header(default=None)) -> Response:
        """Return a short NDJSON body the browser downloads as a file."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        lines = [
            json.dumps({"kind": "user", "record": MOCK_USER}),
            json.dumps({"kind": "collection_item", "record": {"release_id": "10"}}),
        ]
        return Response(content="\n".join(lines) + "\n", media_type="application/x-ndjson")

    @app.post("/api/user/erasure", status_code=202)
    async def user_erasure(
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        """Accept the mock password; reject anything else the way the API does."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        body = await request.json()
        if body.get("password") != "testpassword":
            return JSONResponse(content={"detail": "Incorrect password"}, status_code=401)
        return JSONResponse(
            content={
                "erasure_id": "00000000-0000-0000-0000-0000000000ff",
                "events_deleted": 2,
                "impressions_deleted": 1,
                "incomplete": [],
            },
            status_code=202,
        )

    # ------------------------------------------------------------------ #
    # Sync endpoints
    # ------------------------------------------------------------------ #

    @app.post("/api/sync", status_code=202)
    async def trigger_sync(authorization: str | None = Header(default=None)) -> JSONResponse:
        """Acknowledge a sync request."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        return JSONResponse(content={"status": "started", "job_id": "mock-job-id-xyz"}, status_code=202)

    @app.get("/api/sync/status")
    async def sync_status(authorization: str | None = Header(default=None)) -> JSONResponse:
        """Return mock sync status."""
        if not authorization or not authorization.startswith("Bearer "):
            return JSONResponse(content={"detail": "Not authenticated"}, status_code=401)
        return JSONResponse(content={"status": "idle", "last_sync": None})

    # ------------------------------------------------------------------ #
    # Natural-language query endpoints
    # ------------------------------------------------------------------ #

    @app.get("/api/nlq/status")
    async def nlq_status() -> JSONResponse:
        return JSONResponse(content={"enabled": True})

    @app.get("/api/nlq/suggestions")
    async def nlq_suggestions() -> JSONResponse:
        return JSONResponse(content={"suggestions": []})

    @app.post("/api/nlq/query")
    async def nlq_query(request: Request) -> Response:
        query = (await request.json()).get("query", "")
        actions = [
            {
                "type": "seed_graph",
                "entities": [{"name": "Kraftwerk", "entity_type": "artist"}, {"name": "Kling Klang", "entity_type": "label"}],
                "replace": True,
            }
        ]
        if "biggest labels" in query.lower():
            actions.insert(0, {"type": "switch_pane", "pane": "insights"})
        payload = json.dumps({"actions": actions})
        result = json.dumps({"summary": "Mock graph answer", "entities": [], "actions": actions})
        body = f"event: actions\ndata: {payload}\n\nevent: result\ndata: {result}\n\n"
        return Response(content=body, media_type="text/event-stream")

    # ------------------------------------------------------------------ #
    # Existing explore/graph endpoints
    # ------------------------------------------------------------------ #

    @app.get("/api/autocomplete")
    async def autocomplete(
        q: str = Query(..., min_length=2),
        type: str = Query("artist"),
        limit: int = Query(10, ge=1, le=50),
    ) -> JSONResponse:
        entity_type = type.lower()
        results = MOCK_AUTOCOMPLETE_RESULTS.get(entity_type, [])
        filtered = [r for r in results if q.lower() in r["name"].lower()][:limit]
        return JSONResponse(content={"results": filtered})

    @app.get("/api/explore")
    async def explore(
        name: str = Query(...),
        type: str = Query("artist"),
    ) -> JSONResponse:
        entity_type = type.lower()
        result = MOCK_EXPLORE_RESULTS.get(entity_type)
        if not result:
            return JSONResponse(content={"error": "Not found"}, status_code=404)

        categories_by_type = {
            "artist": [
                ("releases", "Releases", "release_count"),
                ("labels", "Labels", "label_count"),
                ("aliases", "Aliases & Members", "alias_count"),
            ],
            "genre": [
                ("releases", "Releases", "release_count"),
                ("artists", "Artists", "artist_count"),
                ("labels", "Labels", "label_count"),
                ("styles", "Styles", "style_count"),
            ],
            "label": [("releases", "Releases", "release_count"), ("artists", "Artists", "artist_count"), ("genres", "Genres", "genre_count")],
        }
        categories = [
            {"id": f"cat-{category}", "name": label, "category": category, "count": result.get(count_key, 0)}
            for category, label, count_key in categories_by_type.get(entity_type, [])
        ]
        return JSONResponse(
            content={
                "center": {"id": str(result["id"]), "name": result["name"], "type": entity_type},
                "categories": categories,
            }
        )

    @app.get("/api/expand")
    async def expand(
        node_id: str = Query(...),
        type: str = Query(...),
        category: str = Query(...),
        limit: int = Query(50, ge=1, le=200),
    ) -> JSONResponse:
        return JSONResponse(
            content={
                "children": [
                    {"id": "10", "name": "OK Computer", "type": "release"},
                    {"id": "11", "name": "Kid A", "type": "release"},
                ]
            }
        )

    @app.get("/api/node/{node_id}")
    async def get_node_details(
        node_id: str,
        type: str = Query("artist"),
    ) -> JSONResponse:
        return JSONResponse(
            content={
                "id": node_id,
                "name": "Radiohead",
                "genres": ["Rock", "Electronic"],
                "styles": ["Alternative Rock", "Art Rock"],
                "release_count": 42,
                "groups": [],
            }
        )

    @app.get("/api/trends")
    async def get_trends(
        name: str = Query(...),
        type: str = Query("artist"),
    ) -> JSONResponse:
        return JSONResponse(
            content={
                "name": name,
                "type": type.lower(),
                "data": [
                    {"year": 1993, "count": 1},
                    {"year": 1995, "count": 2},
                    {"year": 1997, "count": 1},
                    {"year": 2000, "count": 1},
                    {"year": 2003, "count": 1},
                ],
            }
        )

    @app.get("/api/collaborators/{artist_id}")
    async def get_collaborators(
        artist_id: str,
        limit: int = Query(20, ge=1, le=100),
    ) -> JSONResponse:
        return JSONResponse(
            content={
                "artist_id": artist_id,
                "artist_name": "Radiohead",
                "collaborators": [
                    {
                        "artist_id": "456",
                        "artist_name": "Thom Yorke",
                        "release_count": 5,
                        "first_year": 1993,
                        "last_year": 2011,
                        "yearly_counts": [
                            {"year": 1993, "count": 1},
                            {"year": 1997, "count": 2},
                            {"year": 2011, "count": 2},
                        ],
                    },
                    {
                        "artist_id": "789",
                        "artist_name": "Jonny Greenwood",
                        "release_count": 3,
                        "first_year": 1995,
                        "last_year": 2007,
                        "yearly_counts": [
                            {"year": 1995, "count": 1},
                            {"year": 2007, "count": 2},
                        ],
                    },
                ],
                "total": 2,
            }
        )

    @app.get("/api/genre-tree")
    async def genre_tree() -> JSONResponse:
        return JSONResponse(
            content={
                "genres": [
                    {
                        "name": "Rock",
                        "release_count": 98000,
                        "styles": [
                            {"name": "Alternative Rock", "release_count": 15000},
                            {"name": "Punk", "release_count": 9500},
                        ],
                    },
                    {
                        "name": "Electronic",
                        "release_count": 75000,
                        "styles": [
                            {"name": "House", "release_count": 20000},
                            {"name": "Techno", "release_count": 18000},
                        ],
                    },
                ]
            }
        )

    # Serve static files from explore module (html=True serves index.html at root)
    static_dir = Path(__file__).parent.parent / "explore" / "static"
    app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")

    return app
