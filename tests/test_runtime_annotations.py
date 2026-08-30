"""Regression tests for runtime annotation consumers on Python 3.14."""

from collections.abc import AsyncGenerator
from inspect import signature

import pytest

from explore.explore import lifespan as production_lifespan
from tests.explore_test_app import lifespan as e2e_lifespan


@pytest.mark.parametrize("lifespan", [production_lifespan, e2e_lifespan])
def test_lifespan_annotations_are_runtime_resolvable(lifespan: object) -> None:
    """Frameworks can evaluate lifespan annotations without missing globals."""
    annotation = signature(lifespan, eval_str=True).return_annotation

    assert annotation == AsyncGenerator[None]
