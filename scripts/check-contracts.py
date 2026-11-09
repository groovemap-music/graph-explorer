"""Verify the promoted Catalog API route contract and consumer route usage."""

import argparse
import json
import re
import subprocess
from hashlib import sha256
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def route_pattern(path: str) -> re.Pattern[str]:
    """Convert a producer path template into a full-match expression."""
    pieces = re.split(r"(\{[^}]+\})", path)
    return re.compile("^" + "".join("[^/]+" if piece.startswith("{") else re.escape(piece) for piece in pieces) + "$")


def check(producer_repo: Path | None = None) -> None:
    contract_root = ROOT / "contracts/catalog-api/graph-explorer/v1"
    source = json.loads((contract_root / "source.json").read_text())
    contract_path = contract_root / "routes.json"
    contract = json.loads(contract_path.read_text())
    contract_bytes = contract_path.read_bytes()
    assert sha256(contract_bytes).hexdigest() == source["contract_sha256"]
    assert source["version"] == contract["version"] == 1
    assert len(source["producer_commit"]) == 40

    if producer_repo:
        producer_path = "api/contracts/graph-explorer/v1/routes.json"
        expected = subprocess.run(  # noqa: S603
            ["git", "-C", str(producer_repo), "show", f"{source['producer_commit']}:{producer_path}"],  # noqa: S607
            check=True,
            capture_output=True,
        ).stdout
        assert expected == contract_bytes, "promoted bytes differ from the pinned producer revision"
        assert sha256(expected).hexdigest() == source["contract_sha256"]
        print(f"verified {producer_path} at {source['producer_commit']} ({source['contract_sha256']})")

    # An operation carries its method and path, and may carry the query parameters the producer
    # promised this consumer. The key set is checked rather than ignored so a producer that
    # starts publishing a field this checker does not understand is a loud failure here rather
    # than a silently unverified promise.
    operation_keys = {"method", "path", "parameters"}
    for name, operation in contract["operations"].items():
        assert set(operation) <= operation_keys, f"unknown keys in operation {name}: {sorted(set(operation) - operation_keys)}"
        assert {"method", "path"} <= set(operation), f"operation {name} is missing method or path"
        assert all(isinstance(parameter, str) for parameter in operation.get("parameters", ()))

    patterns = [route_pattern(operation["path"]) for operation in contract["operations"].values()]
    literal_pattern = re.compile(r"['\"`](/api/[^'\"`? ]+)")
    for javascript in sorted((ROOT / "explore/static/js").glob("*.js")):
        for literal in literal_pattern.findall(javascript.read_text()):
            concrete = literal.replace("${entityType}", "artist")
            concrete = re.sub(r"\$\{[^}]+\}", "value", concrete)
            assert any(pattern.fullmatch(concrete) for pattern in patterns), f"uncontracted Catalog API route in {javascript.name}: {literal}"

    architecture = (ROOT / "docs/architecture.md").read_text()
    for component in (
        "ApplicationLifecycle",
        "GraphSessionState",
        "UserPaneState",
        "SettingsState",
        "ApiTransport",
        "proxy_transport",
    ):
        assert component in architecture
    contract_source = json.loads((contract_root / "source.json").read_text())
    for revision in (contract_source["producer_commit"],):
        assert revision in architecture

    configuration = (ROOT / "docs/configuration.md").read_text()
    for setting in ("API_BASE_URL", "CORS_ORIGINS", "LOG_LEVEL"):
        assert setting in configuration
    for entry_point in ("explore.explore:main", "GET /health", "/api/{path:path}", "GET :8007/health"):
        assert entry_point in configuration

    user_guide = (ROOT / "docs/user-guide.md").read_text()
    for workflow in ("Explore", "Trends", "Find Path", "Search", "Insights", "Genres", "Credits", "Ask"):
        assert workflow in user_guide


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--producer-repo",
        type=Path,
        help="optionally verify the promoted bytes with git show from this local producer checkout",
    )
    args = parser.parse_args()
    check(args.producer_repo)


if __name__ == "__main__":
    main()
