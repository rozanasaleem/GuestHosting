#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import time
from http import HTTPStatus
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote, unquote, urlparse
from urllib.request import Request, urlopen

from flask import Flask, jsonify, request, send_from_directory

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("GUEST_DB_PATH", str(ROOT / "guests.db"))).expanduser()
DATA_PATH = ROOT / "data" / "guests-data.js"

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
SUPABASE_GUESTS_TABLE = os.environ.get("SUPABASE_GUESTS_TABLE", "guests")
SUPABASE_FIELDS_TABLE = os.environ.get("SUPABASE_FIELDS_TABLE", "custom_fields")
SUPABASE_PAGE_SIZE = int(os.environ.get("SUPABASE_PAGE_SIZE", "1000"))


def clean(value: object) -> str:
    return str(value or "").strip()


def has_supabase() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


# SQLite fallback for local development without Supabase credentials.
def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def create_schema(con: sqlite3.Connection) -> None:
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS guests (
          id TEXT PRIMARY KEY,
          row_label TEXT,
          source TEXT NOT NULL DEFAULT 'original',
          name TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          phone TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT '',
          region TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          custom_json TEXT NOT NULL DEFAULT '{}',
          original_tags_json TEXT NOT NULL DEFAULT '[]',
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS custom_fields (
          key TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        """
    )
    con.commit()


def seed_database(con: sqlite3.Connection) -> None:
    existing = con.execute("SELECT COUNT(*) FROM guests").fetchone()[0]
    if existing:
        return

    text = DATA_PATH.read_text(encoding="utf-8")
    match = re.match(r"window\.GUEST_DATABASE = (.*);\s*$", text, re.S)
    if not match:
        raise RuntimeError(f"Could not parse {DATA_PATH}")

    payload = json.loads(match.group(1))
    rows = []
    for guest in payload["guests"]:
        rows.append(
            (
                guest.get("id", ""),
                str(guest.get("row", "")),
                "original",
                guest.get("name", ""),
                guest.get("title", ""),
                guest.get("phone", ""),
                guest.get("category", ""),
                guest.get("region", ""),
                json.dumps(guest.get("tags", []), ensure_ascii=False),
            )
        )

    con.executemany(
        """
        INSERT INTO guests
          (id, row_label, source, name, title, phone, category, region, original_tags_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    con.commit()


def init_db() -> None:
    with connect() as con:
        create_schema(con)
        seed_database(con)


def sqlite_row_to_guest(row: sqlite3.Row) -> dict:
    return {
        "id": str(row["id"]),
        "row": row["row_label"],
        "source": row["source"],
        "name": row["name"],
        "title": row["title"],
        "phone": row["phone"],
        "category": row["category"],
        "region": row["region"],
        "status": row["status"],
        "notes": row["notes"],
        "custom": json.loads(row["custom_json"] or "{}"),
        "tags": json.loads(row["original_tags_json"] or "[]"),
    }


def sqlite_get_state() -> dict:
    init_db()
    with connect() as con:
        guests = [sqlite_row_to_guest(row) for row in con.execute("SELECT * FROM guests ORDER BY source DESC, name COLLATE NOCASE")]
        fields = [dict(row) for row in con.execute("SELECT key, label FROM custom_fields ORDER BY created_at")]
        source_count = con.execute("SELECT COUNT(*) FROM guests WHERE source = 'original'").fetchone()[0]
    return {"sourceCount": source_count, "count": len(guests), "guests": guests, "customFields": fields, "backend": "sqlite"}


def sqlite_save_guest(guest_id: str, payload: dict) -> dict:
    init_db()
    fields = payload.get("fields") or {}
    custom = payload.get("custom") or {}
    status = payload.get("status")
    notes = payload.get("notes")

    with connect() as con:
        current = con.execute("SELECT * FROM guests WHERE id = ?", (guest_id,)).fetchone()
        if current is None:
            raise KeyError(guest_id)

        merged_custom = json.loads(current["custom_json"] or "{}")
        merged_custom.update(custom)
        values = {
            "name": fields.get("name", current["name"]),
            "title": fields.get("title", current["title"]),
            "phone": fields.get("phone", current["phone"]),
            "category": fields.get("category", current["category"]),
            "region": fields.get("region", current["region"]),
            "status": current["status"] if status is None else status,
            "notes": current["notes"] if notes is None else notes,
            "custom_json": json.dumps(merged_custom, ensure_ascii=False),
            "id": guest_id,
        }
        con.execute(
            """
            UPDATE guests
            SET name = :name, title = :title, phone = :phone, category = :category,
                region = :region, status = :status, notes = :notes,
                custom_json = :custom_json, updated_at = CURRENT_TIMESTAMP
            WHERE id = :id
            """,
            values,
        )
        con.commit()
        return sqlite_row_to_guest(con.execute("SELECT * FROM guests WHERE id = ?", (guest_id,)).fetchone())


def sqlite_create_guest(payload: dict) -> dict:
    init_db()
    fields = payload.get("fields") or {}
    custom = payload.get("custom") or {}
    guest_id = payload.get("id") or f"guest-{int(time.time() * 1000)}"
    with connect() as con:
        con.execute(
            """
            INSERT INTO guests
              (id, row_label, source, name, title, phone, category, region, status, notes, custom_json)
            VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                guest_id,
                "جديد",
                fields.get("name", "ضيف جديد"),
                fields.get("title", ""),
                fields.get("phone", ""),
                fields.get("category", ""),
                fields.get("region", ""),
                payload.get("status", "غير محدد"),
                payload.get("notes", ""),
                json.dumps(custom, ensure_ascii=False),
            ),
        )
        con.commit()
        return sqlite_row_to_guest(con.execute("SELECT * FROM guests WHERE id = ?", (guest_id,)).fetchone())


def sqlite_create_field(payload: dict) -> dict:
    init_db()
    label = clean(payload.get("label"))
    if not label:
        raise ValueError("Missing field label")
    key = payload.get("key") or f"field_{int(time.time() * 1000)}"
    with connect() as con:
        con.execute("INSERT INTO custom_fields (key, label) VALUES (?, ?)", (key, label))
        con.commit()
    return {"key": key, "label": label}


# Supabase REST backend for production.
def supabase_headers(prefer: str | None = None) -> dict:
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def supabase_request(method: str, path: str, body: object | None = None, prefer: str | None = None) -> object:
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = Request(url, data=data, method=method, headers=supabase_headers(prefer))
    try:
        with urlopen(req, timeout=25) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase {method} {path} failed: {exc.code} {detail}") from exc


def parse_jsonish(value: object, fallback: object) -> object:
    if value is None or value == "":
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except json.JSONDecodeError:
        return fallback


def supabase_row_to_guest(row: dict) -> dict:
    custom = parse_jsonish(row.get("custom_json"), {})
    tags = parse_jsonish(row.get("original_tags_json"), [])
    category = row.get("category") or ""
    if not tags and category:
        tags = []
    return {
        "id": str(row.get("id", "")),
        "row": row.get("row_label") or row.get("row") or "",
        "source": row.get("source") or "original",
        "name": row.get("name") or "",
        "title": row.get("title") or "",
        "phone": row.get("phone") or row.get("phone_number") or "",
        "category": category,
        "region": row.get("region") or "",
        "status": row.get("status") or "",
        "notes": row.get("notes") or row.get("phone_notes") or "",
        "custom": custom if isinstance(custom, dict) else {},
        "tags": tags if isinstance(tags, list) else [],
    }


def supabase_payload_from_fields(fields: dict, current: dict | None = None) -> dict:
    payload = {}
    mapping = {
        "name": "name",
        "title": "title",
        "phone": "phone_number",
        "category": "category",
        "region": "region",
    }
    for app_key, db_key in mapping.items():
        if app_key in fields:
            payload[db_key] = fields.get(app_key, "")
    if current and "phone" in fields and "phone" in current:
        payload["phone"] = fields.get("phone", "")
    return payload


def supabase_select_all(table: str, select: str, order: str | None = None) -> list[dict]:
    rows = []
    offset = 0
    while True:
        params = f"select={select}"
        if order:
            params += f"&order={order}"
        path = f"{table}?{params}&limit={SUPABASE_PAGE_SIZE}&offset={offset}"
        batch = supabase_request("GET", path)
        if not isinstance(batch, list):
            return rows
        rows.extend(batch)
        if len(batch) < SUPABASE_PAGE_SIZE:
            return rows
        offset += SUPABASE_PAGE_SIZE


def supabase_get_state() -> dict:
    guests_rows = supabase_select_all(SUPABASE_GUESTS_TABLE, "*", "name.asc")
    try:
        fields_rows = supabase_select_all(SUPABASE_FIELDS_TABLE, "key,label", "created_at.asc")
    except RuntimeError:
        fields_rows = []
    guests = [supabase_row_to_guest(row) for row in guests_rows]
    source_count = sum(1 for guest in guests if guest.get("source") == "original") or len(guests)
    return {"sourceCount": source_count, "count": len(guests), "guests": guests, "customFields": fields_rows, "backend": "supabase"}


def supabase_fetch_guest(guest_id: str) -> dict:
    path = f"{SUPABASE_GUESTS_TABLE}?select=*&id=eq.{quote(str(guest_id), safe='')}"
    rows = supabase_request("GET", path)
    if not rows:
        raise KeyError(guest_id)
    return rows[0]


def supabase_save_guest(guest_id: str, payload: dict) -> dict:
    current = supabase_fetch_guest(guest_id)
    fields = payload.get("fields") or {}
    custom = payload.get("custom") or {}
    update = supabase_payload_from_fields(fields, current)
    if "status" in payload:
        update["status"] = payload.get("status") or ""
    if "notes" in payload:
        update["notes"] = payload.get("notes") or ""
    if custom:
        merged_custom = parse_jsonish(current.get("custom_json"), {})
        if not isinstance(merged_custom, dict):
            merged_custom = {}
        merged_custom.update(custom)
        update["custom_json"] = merged_custom
    if not update:
        return supabase_row_to_guest(current)
    path = f"{SUPABASE_GUESTS_TABLE}?id=eq.{quote(str(guest_id), safe='')}"
    rows = supabase_request("PATCH", path, update, prefer="return=representation")
    if not rows:
        raise KeyError(guest_id)
    return supabase_row_to_guest(rows[0])


def supabase_create_guest(payload: dict) -> dict:
    fields = payload.get("fields") or {}
    custom = payload.get("custom") or {}
    insert = {
        "source": "new",
        "row_label": "جديد",
        "name": fields.get("name", "ضيف جديد"),
        "title": fields.get("title", ""),
        "phone_number": fields.get("phone", ""),
        "category": fields.get("category", ""),
        "region": fields.get("region", ""),
        "status": payload.get("status", "غير محدد"),
        "notes": payload.get("notes", ""),
        "custom_json": custom or {},
        "original_tags_json": [],
    }
    rows = supabase_request("POST", SUPABASE_GUESTS_TABLE, insert, prefer="return=representation")
    if not rows:
        raise RuntimeError("Supabase insert did not return a row")
    return supabase_row_to_guest(rows[0])


def supabase_create_field(payload: dict) -> dict:
    label = clean(payload.get("label"))
    if not label:
        raise ValueError("Missing field label")
    key = payload.get("key") or f"field_{int(time.time() * 1000)}"
    row = {"key": key, "label": label}
    rows = supabase_request("POST", SUPABASE_FIELDS_TABLE, row, prefer="return=representation")
    if not rows:
        return row
    return {"key": rows[0].get("key", key), "label": rows[0].get("label", label)}


def get_state() -> dict:
    if has_supabase():
        return supabase_get_state()
    return sqlite_get_state()


def save_guest(guest_id: str, payload: dict) -> dict:
    if has_supabase():
        return supabase_save_guest(guest_id, payload)
    return sqlite_save_guest(guest_id, payload)


def create_guest(payload: dict) -> dict:
    if has_supabase():
        return supabase_create_guest(payload)
    return sqlite_create_guest(payload)


def create_field(payload: dict) -> dict:
    if has_supabase():
        return supabase_create_field(payload)
    return sqlite_create_field(payload)


app = Flask(__name__, static_folder=None)


@app.get("/api/health")
def health():
    return jsonify({"ok": True, "backend": "supabase" if has_supabase() else "sqlite"})


@app.get("/api/state")
def api_state():
    return jsonify(get_state())


@app.post("/api/guests")
def api_create_guest():
    try:
        return jsonify(create_guest(request.get_json(silent=True) or {})), HTTPStatus.CREATED
    except Exception as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST


@app.post("/api/fields")
def api_create_field():
    try:
        return jsonify(create_field(request.get_json(silent=True) or {})), HTTPStatus.CREATED
    except Exception as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST


@app.put("/api/guests/<path:guest_id>")
def api_save_guest(guest_id: str):
    try:
        return jsonify(save_guest(unquote(guest_id), request.get_json(silent=True) or {}))
    except KeyError:
        return jsonify({"error": "Guest not found"}), HTTPStatus.NOT_FOUND
    except Exception as exc:
        return jsonify({"error": str(exc)}), HTTPStatus.BAD_REQUEST


@app.get("/")
def home():
    return send_from_directory(ROOT, "index.html")


@app.get("/<path:path>")
def static_files(path: str):
    parsed = urlparse(path).path
    target = (ROOT / parsed).resolve()
    if not str(target).startswith(str(ROOT.resolve())) or not target.is_file():
        return send_from_directory(ROOT, "index.html")
    return send_from_directory(target.parent, target.name)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", default=int(os.environ.get("PORT", "8080")), type=int)
    parser.add_argument("--init-only", action="store_true")
    args = parser.parse_args()

    if args.init_only:
        init_db()
        print(f"Database ready: {DB_PATH}")
        return

    app.run(host=args.host, port=args.port)


if __name__ == "__main__":
    main()
