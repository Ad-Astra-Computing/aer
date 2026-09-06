"""Single source of truth for the SDK's runtime version string.

Kept separate from __init__.py so client.py can import it (for the default
transport's User-Agent header) without a circular import through __init__.
This is the single source of truth: pyproject.toml reads the version from
here, so bumping this file is the whole release bump.
"""

__version__ = "0.1.0"
