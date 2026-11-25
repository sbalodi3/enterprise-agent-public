"""Presenter release control for the fingerprinted sibling's synthetic wage mock."""

from datetime import date, timedelta
import json
import hashlib
import os
from contextlib import asynccontextmanager
from uuid import uuid4

import httpx
from fastapi import HTTPException, Request

from boundary import authorize, callback_url, canonical, database, matches, mock_url, secret
from mocks.amazon_wage_evidence.app import create_app as upstream_mock


class Presenter:
    def __init__(self, path, client_secret, callback_secret, callback, http):
        self.path = path
        self.client_secret = client_secret
        self.callback_secret = callback_secret
        self.callback = callback
        self.http = http
        with database(path) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS held (
                message_id TEXT PRIMARY KEY, task_id TEXT UNIQUE NOT NULL, context_id TEXT NOT NULL,
                body_hash TEXT NOT NULL, push_token TEXT NOT NULL, state TEXT NOT NULL)""")

            if "disclosure" not in {row[1] for row in db.execute("PRAGMA table_info(held)")}:
                db.execute("ALTER TABLE held ADD COLUMN disclosure TEXT")

    def result_data(self, task_id, template):
        row = self.find(task_id)
        if not row or not row["disclosure"]:
            return template
        disclosure = json.loads(row["disclosure"])
        if disclosure["claimNumber"] == "WC-102":
            return template
        start = date.fromisoformat(disclosure["dateRangeStart"])
        end = date.fromisoformat(disclosure["dateRangeEnd"])
        periods = []
        while start <= end:
            last = min(end, start + timedelta(days=13))
            periods.append({**template["payPeriods"][0], "periodStart":start.isoformat(), "periodEnd":last.isoformat()})
            if disclosure["claimNumber"] == "CLM-000020":
                break
            start = last + timedelta(days=1)
        return {**template, "hireDate":"2021-04-17", "payPeriods":periods}

    def valid_client(self, form):
        return form.get("client_id") == "enterprise-agent-showcase" and matches(
            form.get("client_secret"), self.client_secret
        )

    def hold(self, body):
        message = body["params"]["message"]
        push = body["params"].get("configuration", {}).get("pushNotificationConfig", {})
        if push.get("url") != self.callback or not isinstance(push.get("token"), str) or not push["token"]:
            raise HTTPException(422, "Invalid local callback registration")
        body_hash = hashlib.sha256(canonical(body)).hexdigest()
        with database(self.path) as db:
            db.execute("INSERT OR IGNORE INTO held(message_id,task_id,context_id,body_hash,push_token,state,disclosure) VALUES (?,?,?,?,?,'working',?)", (
                message["messageId"], "amz-" + str(uuid4()), message["contextId"], body_hash, push["token"], canonical(message["parts"][0]["data"]["input"]).decode(),
            ))
            row = db.execute("SELECT task_id, body_hash FROM held WHERE message_id=?", (message["messageId"],)).fetchone()
            if row["body_hash"] != body_hash:
                raise HTTPException(409, "Message was already registered with different content")
            return row["task_id"]

    def find(self, task_id):
        with database(self.path) as db:
            return db.execute("SELECT * FROM held WHERE task_id=?", (task_id,)).fetchone()

    def install(self, app, sign):
        @app.get("/presenter/registrations/{message_id}")
        async def registration(message_id: str, request: Request):
            authorize(request, self.client_secret)
            with database(self.path) as db:
                row = db.execute("SELECT task_id,context_id FROM held WHERE message_id=?", (message_id,)).fetchone()
            if not row:
                raise HTTPException(404, "Unknown registration")
            return {"taskId":row["task_id"], "contextId":row["context_id"]}

        @app.get("/healthz")
        async def health():
            return {"status": "ok"}

        @app.post("/presenter/tasks/{task_id}/release")
        async def release(task_id: str, request: Request):
            authorize(request, self.client_secret)
            with database(self.path) as db:
                if not db.execute("UPDATE held SET state='completed' WHERE task_id=?", (task_id,)).rowcount:
                    raise HTTPException(404, "Unknown local task")
            row = self.find(task_id)
            body = canonical({"id": task_id, "contextId": row["context_id"], "status": {"state": "completed"}})
            headers = {
                "Authorization": "Bearer " + self.callback_secret,
                "X-A2A-Notification-Token": row["push_token"],
                "X-JWS-Signature": sign(body),
                "Content-Type": "application/json",
            }
            # Commit release before callback I/O. Polling sees completion even if delivery fails.
            try:
                response = await self.http.post(self.callback, content=body, headers=headers)
                delivered = response.status_code == 202
            except httpx.HTTPError:
                delivered = False
            return {"released": True, "notificationDelivered": delivered}


def create_app(*, http=None):
    owned = http is None
    http = http or httpx.AsyncClient(timeout=8, trust_env=False)
    presenter = Presenter(os.getenv("MOCK_DB", "/data/mock.sqlite3"), secret("SHOWCASE_MOCK_CLIENT_SECRET"),
                          secret("SHOWCASE_CALLBACK_TOKEN"), callback_url(), http)
    app = upstream_mock(mock_url(), showcase=presenter)

    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            if owned:
                await http.aclose()

    app.router.lifespan_context = lifespan
    return app
