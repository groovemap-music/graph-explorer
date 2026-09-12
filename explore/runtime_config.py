"""Environment-backed construction settings for graph-explorer."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING


if TYPE_CHECKING:
    from collections.abc import Mapping


@dataclass(frozen=True, slots=True)
class RuntimeConfig:
    api_base_url: str
    cors_origins: tuple[str, ...] | None

    @classmethod
    def from_environment(cls, environment: Mapping[str, str] | None = None) -> RuntimeConfig:
        values = os.environ if environment is None else environment
        raw_origins = values.get("CORS_ORIGINS", "")
        origins = tuple(origin.strip() for origin in raw_origins.split(",") if origin.strip())
        return cls(
            api_base_url=values.get("API_BASE_URL", "http://api:8004"),
            cors_origins=origins or None,
        )
