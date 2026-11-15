"""Make tempfile.mkdtemp usable under this machine's Windows sandbox.

`os.mkdir(path, 0o700)` produces directories that the creating process cannot
even read on this host (Python 3.12 + restricted token). tempfile.mkdtemp uses
exactly that mode, which breaks pip's unpack step. This shim creates temp dirs
with default permissions instead.
"""
import os
import random
import string
import tempfile

_ORIGINAL_MKDTEMP = tempfile.mkdtemp


def _safe_mkdtemp(suffix=None, prefix=None, dir=None):
    suffix = suffix or ""
    prefix = prefix or "tmp"
    directory = dir or tempfile.gettempdir()
    for _ in range(10000):
        name = prefix + "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(10)) + suffix
        path = os.path.join(directory, name)
        try:
            os.makedirs(path)  # default ACL, unlike os.mkdir(path, 0o700)
            return path
        except FileExistsError:
            continue
    raise FileExistsError("could not create a temporary directory")


tempfile.mkdtemp = _safe_mkdtemp
