"""The optional producer provenance proof works offline against local git fixtures."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts/check-contracts.py"
PRODUCER_ROUTES = Path("api/contracts/graph-explorer/v1/routes.json")


def producer_repo(tmp_path: Path, payload: bytes) -> tuple[Path, str]:
    repo = tmp_path / "producer"
    repo.mkdir()
    subprocess.run(["git", "-C", str(repo), "init", "--quiet"], check=True)  # noqa: S603, S607
    route = repo / PRODUCER_ROUTES
    route.parent.mkdir(parents=True)
    route.write_bytes(payload)
    subprocess.run(["git", "-C", str(repo), "add", str(PRODUCER_ROUTES)], check=True)  # noqa: S603, S607
    subprocess.run(  # noqa: S603
        ["git", "-C", str(repo), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"],  # noqa: S607
        check=True,
    )
    revision = subprocess.run(  # noqa: S603
        ["git", "-C", str(repo), "rev-parse", "HEAD"],  # noqa: S607
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return repo, revision


def consumer_repo(tmp_path: Path, promoted_payload: bytes, digest: bytes | None = None) -> Path:
    root = tmp_path / "consumer"
    contract_root = root / "contracts/catalog-api/graph-explorer/v1"
    contract_root.mkdir(parents=True)
    (contract_root / "routes.json").write_bytes(promoted_payload)
    source = {
        "contract_sha256": hashlib.sha256(digest if digest is not None else promoted_payload).hexdigest(),
        "producer_commit": "0" * 40,
        "version": 1,
    }
    (contract_root / "source.json").write_text(json.dumps(source))
    javascript = root / "explore/static/js/api-client.js"
    javascript.parent.mkdir(parents=True)
    javascript.write_text("fetch('/api/example')\n")
    architecture = root / "docs/architecture.md"
    architecture.parent.mkdir(parents=True)
    architecture.write_text(source["producer_commit"])
    (root / "scripts").mkdir()
    shutil.copyfile(CHECKER, root / "scripts/check-contracts.py")
    return root


def run_proof(tmp_path: Path, producer_payload: bytes, promoted_payload: bytes, digest: bytes | None = None) -> subprocess.CompletedProcess[str]:
    repo, revision = producer_repo(tmp_path, producer_payload)
    consumer = consumer_repo(tmp_path, promoted_payload, digest)
    source_path = consumer / "contracts/catalog-api/graph-explorer/v1/source.json"
    source = json.loads(source_path.read_text())
    source["producer_commit"] = revision
    source["contract_sha256"] = hashlib.sha256(digest if digest is not None else promoted_payload).hexdigest()
    source_path.write_text(json.dumps(source))
    architecture = consumer / "docs/architecture.md"
    architecture.write_text(revision)
    return subprocess.run(  # noqa: S603
        [sys.executable, str(consumer / "scripts/check-contracts.py"), "--producer-repo", str(repo)],
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def test_pinned_bytes_and_digest_pass_against_a_local_producer_repo(tmp_path: Path) -> None:
    payload = json.dumps({"version": 1, "operations": {"example": {"method": "GET", "path": "/api/example"}}}).encode() + b"\n"
    result = run_proof(tmp_path, payload, payload)
    assert result.returncode == 0, result.stderr
    assert "verified api/contracts/graph-explorer/v1/routes.json" in result.stdout


@pytest.mark.parametrize(
    ("producer_payload", "promoted_payload", "digest", "error"),
    [
        (
            json.dumps({"version": 1, "operations": {"example": {"method": "GET", "path": "/api/producer"}}}).encode() + b"\n",
            json.dumps({"version": 1, "operations": {"example": {"method": "GET", "path": "/api/example"}}}).encode() + b"\n",
            None,
            "promoted bytes differ",
        ),
        (
            json.dumps({"version": 1, "operations": {"example": {"method": "GET", "path": "/api/example"}}}).encode() + b"\n",
            json.dumps({"version": 1, "operations": {"example": {"method": "GET", "path": "/api/example"}}}).encode() + b"\n",
            b"wrong digest\n",
            "contract_sha256",
        ),
    ],
)
def test_mismatched_bytes_or_digest_fail(tmp_path: Path, producer_payload: bytes, promoted_payload: bytes, digest: bytes | None, error: str) -> None:
    result = run_proof(tmp_path, producer_payload, promoted_payload, digest)
    assert result.returncode != 0
    assert error in result.stderr
