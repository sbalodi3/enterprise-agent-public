"""Bridge authorized Workbench wage requests to the local partner exchange."""

import hashlib
import json
import os
import secrets
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

from boundary import OUTPUT, SKILL, VERSION, authorize, callback_url, canonical, database, matches, mock_url, secret
from sedgwick_a2a import jws, schema
from sedgwick_a2a.agent_card import AgentCardCache
from sedgwick_a2a.client import A2AClient, PendingTask, ResponseVerification, SIGNATURE_HEADER, ValidatedResult
from sedgwick_a2a.envelope import Principal, PushConfig, TaskRequest, context_id_for
from sedgwick_a2a.errors import A2AError, ContractViolation
from sedgwick_a2a.provenance import Outcome

OpaqueId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_.:-]{1,128}$")]


@dataclass(frozen=True, kw_only=True)
class SignedEvidence(ValidatedResult):
    response_hash: str


class EvidenceClient(A2AClient):
    """Bind a receipt to the exact signed bytes, after all upstream checks succeed."""

    def _parse(self, raw, skill, request_id, context_id, *, expected_task_id=None):
        result = super()._parse(raw, skill, request_id, context_id, expected_task_id=expected_task_id)
        if isinstance(result, PendingTask):
            return result
        return SignedEvidence(**vars(result), response_hash="sha256:" + hashlib.sha256(raw).hexdigest())


class Start(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: OpaqueId
    workItemId: Literal["WC-102", "CLM-000020", "CLM-000002"]
    operationId: OpaqueId
    payloadDigest: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
    input: dict[str, str]
    actorId: OpaqueId


def envelope(row, callback):
    return TaskRequest(
        skill_id=SKILL, skill_version=VERSION, principal=Principal(row["actor"], "claims-wage-evidence"),
        input=json.loads(row["input"]), traceparent=row["trace"], business_key=row["request_id"],
        message_id=row["message_id"], task_id=row["client_task"], push=PushConfig(callback, row["push_token"]),
    )


def reference(row):
    return {"requestId": row["request_id"], "workItemId": row["item"], "taskId": row["partner_task"],
            "contextId": context_id_for(row["request_id"]), "eventId": "wage-result:" + row["partner_task"]}


def checked_artifact(result):
    p = result.provenance
    expected = "sha256:" + hashlib.sha256(canonical(result.data)).hexdigest()
    if p.payload_hash != expected or result.outcome != Outcome.FOUND:
        raise ContractViolation("Unexpected evidence digest or outcome")
    return {
        "schema": OUTPUT, "data": result.data,
        "provenance": {"sourceSystem": p.source_system, "asOf": p.as_of, "recordIds": list(p.record_ids),
                       "sensitivityTier": p.sensitivity_tier,
                       "withheld": [{"field": w.field, "ruleId": w.rule_id} for w in p.withheld],
                       "policyDecisionId": p.policy_decision_id,
                       "payloadHash": p.payload_hash},
    }


def create_app(*, http=None, contract_dir=None):
    owned = http is None
    http = http or httpx.AsyncClient(timeout=8, trust_env=False)
    base = mock_url()
    callback = callback_url()
    notice = os.environ["WORKBENCH_NOTICE_URL"]
    internal = secret("SHOWCASE_PARTNER_TOKEN")
    cb_credential = secret("SHOWCASE_CALLBACK_TOKEN")
    oauth_secret = secret("SHOWCASE_MOCK_CLIENT_SECRET")
    path = os.getenv("PARTNER_DB", "/data/partner.sqlite3")
    with database(path) as db:
        db.execute("""CREATE TABLE IF NOT EXISTS requests (
            request_id TEXT PRIMARY KEY, item TEXT NOT NULL, actor TEXT NOT NULL, message_id TEXT UNIQUE NOT NULL,
            client_task TEXT NOT NULL, trace TEXT NOT NULL, push_token TEXT NOT NULL, input TEXT NOT NULL, partner_task TEXT UNIQUE)""")

        columns = {row[1] for row in db.execute("PRAGMA table_info(requests)")}
        for field in ("operation_id", "payload_digest", "accepted_at"):
            if field not in columns:
                db.execute(f"ALTER TABLE requests ADD COLUMN {field} TEXT")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS approved_operation ON requests(operation_id)")

    async def keys():
        result = await http.get(base + "/jwks.json")
        result.raise_for_status()
        return result.json()

    registry = schema.SchemaRegistry(contract_dir or Path(__file__).parent / "contracts")
    client = EvidenceClient(http, registry, ResponseVerification(keys), max_attempts=2)
    card = AgentCardCache(http, base + "/.well-known/agent-card.json")

    async def partner():
        skill = await card.resolve(SKILL)
        token_url = await card.client_credentials_token_url()
        if (skill.version != VERSION or skill.output_schema != OUTPUT or skill.status != "active"
                or skill.endpoint_url != base + "/a2a" or token_url != base + "/oauth/token"):
            raise ContractViolation("Partner card does not match the pinned showcase capability and origin")
        response = await http.post(token_url, data={"grant_type": "client_credentials", "scope": "wage.read",
                                                    "client_id": "enterprise-agent-showcase", "client_secret": oauth_secret})
        response.raise_for_status()
        return skill, response.json()["access_token"]

    def load(request_id):
        with database(path) as db:
            row = db.execute("SELECT * FROM requests WHERE request_id=?", (request_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Unknown request")
        return row

    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            if owned:
                await http.aclose()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(A2AError)
    @app.exception_handler(ContractViolation)
    @app.exception_handler(httpx.HTTPError)
    async def partner_error(_request, _error):
        return Response("Partner exchange failed validation or is unavailable", status_code=502)

    @app.get("/healthz")
    async def health():
        return {"status": "ok"}

    @app.post("/requests")
    async def start(payload: Start, request: Request):
        authorize(request, internal)
        if payload.input.get("claimNumber") != payload.workItemId:
            raise HTTPException(422, "Wrong disclosure target")
        schema.validate(payload.input, registry.get(f"{SKILL}/{VERSION}/input"))
        with database(path) as db:
            db.execute("""INSERT OR IGNORE INTO requests
                (request_id,item,actor,message_id,client_task,trace,push_token,input,operation_id,payload_digest)
                VALUES (?,?,?,?,?,?,?,?,?,?)""", (
                payload.requestId, payload.workItemId, payload.actorId, str(uuid4()), str(uuid4()),
                "00-" + secrets.token_hex(16) + "-" + secrets.token_hex(8) + "-01", secrets.token_urlsafe(32), canonical(payload.input).decode(),
                payload.operationId, payload.payloadDigest,
            ))
        row = load(payload.requestId)
        if (row["actor"] != payload.actorId or row["item"] != payload.workItemId or row["operation_id"] != payload.operationId
                or row["payload_digest"] != payload.payloadDigest or json.loads(row["input"]) != payload.input):
            raise HTTPException(409, "Request correlation conflicts with the original registration")
        if not row["partner_task"]:
            skill, bearer = await partner()
            message = envelope(row, callback)
            schema.validate(message.input, registry.get(f"{SKILL}/{VERSION}/input"))
            result = await client.send(skill, message, bearer)
            if not isinstance(result, PendingTask):
                raise ContractViolation("Expected presenter-held partner task")
            with database(path) as db:
                db.execute("UPDATE requests SET partner_task=?,accepted_at=? WHERE request_id=? AND partner_task IS NULL",
                           (result.task_id, datetime.now(timezone.utc).isoformat(), payload.requestId))
            row = load(payload.requestId)
            if row["partner_task"] != result.task_id:
                raise ContractViolation("Partner assigned inconsistent task IDs to the same message")
        return receipt(row)

    def receipt(row):
        return {**reference(row), "state":"working", "receiptId":row["partner_task"], "operationId":row["operation_id"],
                "payloadDigest":row["payload_digest"], "type":"request_wages", "claimId":row["item"], "appliedAt":row["accepted_at"]}

    @app.get("/requests/{request_id}/registration")
    @app.get("/requests/{request_id}/receipt")
    async def lookup(request_id: str, request: Request):
        authorize(request, internal)
        row = load(request_id)
        if not row["partner_task"]:
            result = await http.get(base+"/presenter/registrations/"+row["message_id"],
                                    headers={"Authorization":"Bearer "+oauth_secret})
            result.raise_for_status()
            found = result.json()
            if found["contextId"] != context_id_for(request_id):
                raise ContractViolation("Wrong recovered registration")
            with database(path) as db:
                db.execute("UPDATE requests SET partner_task=?,accepted_at=? WHERE request_id=? AND partner_task IS NULL",
                           (found["taskId"], datetime.now(timezone.utc).isoformat(), request_id))
            row = load(request_id)
        return receipt(row)

    @app.get("/requests/{request_id}")
    async def fetch(request_id: str, request: Request):
        authorize(request, internal)
        row = load(request_id)
        if not row["partner_task"]:
            raise HTTPException(409, "Request registration in progress")
        skill, bearer = await partner()
        result = await client.get_task(skill, row["partner_task"], context_id_for(request_id), row["trace"], bearer)
        if isinstance(result, PendingTask):
            return {**reference(row), "state": "working"}
        return {**reference(row), "state": "completed", "artifact": checked_artifact(result),
                "signedResponseHash": result.response_hash}

    @app.post("/requests/{request_id}/release")
    async def release(request_id: str, request: Request):
        authorize(request, internal)
        row = load(request_id)
        if not row["partner_task"]:
            raise HTTPException(409, "Request registration in progress")
        result = await http.post(base + "/presenter/tasks/" + row["partner_task"] + "/release",
                                 headers={"Authorization": "Bearer " + oauth_secret})
        result.raise_for_status()
        return result.json()

    @app.post("/a2a/notifications", status_code=202)
    async def notification(request: Request):
        authorize(request, cb_credential)
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 8192:
                raise HTTPException(413, "Notification exceeds the local limit")
        signature = request.headers.get(SIGNATURE_HEADER, "")
        try:
            jws.verify_detached(bytes(raw), signature, await keys(), ("ES256",))
        except (ContractViolation, ValueError, TypeError, AttributeError):
            raise HTTPException(401, "Invalid callback signature") from None
        try:
            hint = json.loads(raw)
        except ValueError:
            raise HTTPException(400, "Malformed notification") from None
        if not isinstance(hint, dict) or not isinstance(hint.get("id"), str):
            raise HTTPException(400, "Malformed task reference")
        with database(path) as db:
            row = db.execute("SELECT * FROM requests WHERE partner_task=?", (hint["id"],)).fetchone()
        if row is None or not matches(row["push_token"], request.headers.get("x-a2a-notification-token")):
            raise HTTPException(403, "Unrecognized callback registration")
        if hint.get("contextId") != context_id_for(row["request_id"]):
            raise HTTPException(403, "Unrecognized callback context")
        receipt = await http.post(notice, headers={"Authorization": "Bearer " + internal}, json=reference(row))
        receipt.raise_for_status()
        return Response(status_code=202)

    return app
