"""Offline-consistent SQLite backup helper for sidecar and HDSI databases."""
from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


def backup(source: Path, destination: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(source)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True) as src, sqlite3.connect(destination) as dst:
        src.backup(dst)
        result = dst.execute("PRAGMA integrity_check").fetchone()
        if result != ("ok",):
            raise RuntimeError(f"backup integrity check failed: {result}")
    destination.chmod(0o600)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    backup(args.source, args.destination)

