# Architecture decisions

These are the durable conclusions retained from private migration planning. The raw working plans
remain in the private `planning-archive` repository and are not part of this public-intent source
tree.

## ADR-001: Keep the application static and proxy only its API boundary

The browser UI remains framework-light static JavaScript built with Tailwind, Alpine, D3, and
Plotly. A small FastAPI service serves those assets and proxies `/api/*` to `catalog-api`. This
preserves one same-origin browser boundary without transferring catalog behavior into this
repository.

## ADR-002: Promote producer contracts instead of importing service source

The Catalog API route contract is copied with source provenance and checked locally. This keeps
`graph-explorer` independently buildable and makes producer changes explicit at review time.

## ADR-003: Treat natural-language results as untrusted structured input

Natural-language responses may propose browser actions, but only allowlisted, schema-validated
actions can mutate UI state. Unsupported or malformed actions remain visible as failures and are
never reported as applied.

## ADR-004: Run one complete pull-request graph

Ordinary and Dependabot pull requests use the same required shared workflow. Python, JavaScript,
browser, audit, legal, secret-scan, package, install, and image checks fail closed; there is no
actor-specific fallback.

## ADR-005: Test every supported browser surface with recoverable instrumentation

Chromium, Firefox, WebKit, iPhone, and iPad execute the same browser tests. Instrumented sources
are restored even after failures, coverage is retained per project, and screenshots, traces, and
videos are captured for failed or crashed pages.
