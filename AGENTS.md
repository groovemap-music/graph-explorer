# Repository instructions

- Run `just check` before proposing a change; run `just e2e` for browser-visible changes.
- Treat `contracts/catalog-api/graph-explorer/v1` as a promoted producer contract. Update provenance and checks together.
- Canonical editable branding belongs to `groovemap-music/infra`. Only promote verified generated assets through `scripts/promote-brand.sh`.
- Never add a source import or Docker build-context dependency on another GrooveMap repository.
- Do not commit credentials, local state, build output, Playwright recordings, or decrypted secret material.
- Releases use Commitizen and approved `v$version` tags. Migration work must not publish artifacts.
