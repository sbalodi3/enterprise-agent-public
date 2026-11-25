"""Local showcase service settings, internal credentials and crash-safe correlation."""

import hmac
import json
import os
import sqlite3
from contextlib import contextmanager

from fastapi import HTTPException, Request

SKILL = "query.wage_evidence"
VERSION = "1.0.0"
OUTPUT = f"{SKILL}/{VERSION}/output"


def canonical(data):
    return json.dumps(data, separators=(",", ":"), sort_keys=True).encode()


def secret(name):
    value = os.environ.get(name)
    if not value:
        raise ValueError(f"Configure {name} for this local showcase")
    return value


def matches(left, right):
    return bool(left and right) and hmac.compare_digest(left.encode(), right.encode())


def authorize(request: Request, credential):
    if not matches(request.headers.get("authorization"), "Bearer " + credential):
        raise HTTPException(401, "Service authentication required")


@contextmanager
def database(path):
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def mock_url():
    return os.getenv("AMAZON_MOCK_URL", "http://amazon-mock:8091").rstrip("/")


def callback_url():
    return os.getenv("PARTNER_CALLBACK_URL", "http://partner-adapter:8090/a2a/notifications")
