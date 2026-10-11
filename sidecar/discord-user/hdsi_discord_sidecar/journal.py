from __future__ import annotations

import json
import sqlite3
from pathlib import Path


class EventJournal:
    """Append-only inbound replay journal.

    Satori v1 has no event acknowledgement operation. Events therefore remain
    replayable across reconnect/restart and HDSI R1 Inbox performs durable
    remote-message deduplication. Capacity exhaustion stops admission instead
    of deleting an event that may not have reached Koishi.
    """

    def __init__(self, path: str | Path, max_events: int = 10_000):
        self.path = str(path)
        self.max_events = max_events
        self.db = sqlite3.connect(self.path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("""
          CREATE TABLE IF NOT EXISTS inbound_event (
            remote_message_id TEXT PRIMARY KEY,
            sn INTEGER NOT NULL UNIQUE,
            body TEXT NOT NULL
          )
        """)
        self.db.commit()

    def append(self, remote_message_id: str, body: dict) -> tuple[dict, bool]:
        found = self.db.execute(
            "SELECT body FROM inbound_event WHERE remote_message_id = ?", (remote_message_id,),
        ).fetchone()
        if found:
            return json.loads(found[0]), False
        count = self.db.execute("SELECT count(*) FROM inbound_event").fetchone()[0]
        if count >= self.max_events:
            raise RuntimeError("SIDECAR_INBOUND_JOURNAL_FULL")
        sn = self.db.execute("SELECT coalesce(max(sn), 1) + 1 FROM inbound_event").fetchone()[0]
        stored = {**body, "sn": sn}
        self.db.execute(
            "INSERT INTO inbound_event(remote_message_id, sn, body) VALUES (?, ?, ?)",
            (remote_message_id, sn, json.dumps(stored, ensure_ascii=False, separators=(",", ":"))),
        )
        self.db.commit()
        return stored, True

    def events(self) -> list[dict]:
        return [json.loads(row[0]) for row in self.db.execute(
            "SELECT body FROM inbound_event ORDER BY sn ASC",
        ).fetchall()]

    def close(self) -> None:
        self.db.close()

