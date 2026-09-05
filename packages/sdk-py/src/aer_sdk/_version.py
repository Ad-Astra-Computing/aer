"""Single source of truth for the SDK's runtime version string.

Kept separate from __init__.py so client.py can import it (for the default
transport's User-Agent header) without a circular import through __init__.
This is the file to bump on release; pyproject.toml's [project].version must
be kept in step with it by hand.
"""

__version__ = "0.1.0"
