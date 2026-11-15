"""Windows fix: directories created with mode 0o700 are inaccessible here.

On this host `os.mkdir(path, 0o700)` (what tempfile.mkdtemp uses) produces a
directory the creating process cannot write into. Anything that downloads models
(HuggingFace) or unpacks archives breaks on it, so we replace mkdtemp with a
default-permissions implementation. Import this module before such libraries.
"""
from __future__ import annotations

import os
import random
import string
import tempfile


def apply() -> None:
    if getattr(tempfile, "_khmer_safe_mkdtemp", False):
        return

    def _safe_mkdtemp(suffix: str | None = None, prefix: str | None = None, dir: str | None = None) -> str:
        suffix = suffix or ""
        prefix = prefix or "tmp"
        directory = dir or tempfile.gettempdir()
        for _ in range(10000):
            name = prefix + "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(10)) + suffix
            path = os.path.join(directory, name)
            try:
                os.makedirs(path)
                return path
            except FileExistsError:
                continue
        raise FileExistsError("could not create a temporary directory")

    tempfile.mkdtemp = _safe_mkdtemp
    tempfile._khmer_safe_mkdtemp = True


apply()
