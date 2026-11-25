"""Run against a prepared context (see README); neither checkout is mutated by these tests."""

import hashlib
import json
import os
import sqlite3
from pathlib import Path

import httpx
import pytest

import adapter
import mock
from boundary import canonical

AUTH = {"Authorization": "Bearer bridge-test"}


def wage_input():
    return {
        "tpaName": "Sedgwick", "requestType": "52-week-wage-history",
        "adjusterName": "Demo Claims Desk", "adjusterEmail": "claims.desk@example.invalid",
        **json.loads((Path(adapter.__file__).parent / "wage-case.json").read_bytes()),
        "additionalDetails": "Review synthetic wage evidence for the requested period",
    }


START = {"requestId": "req-01", "workItemId": "WC-102", "actorId": "maya",
         "operationId":"approved-01", "payloadDigest":"a"*64, "input":wage_input()}


class Network(httpx.AsyncBaseTransport):
    """Exercise all three HTTP boundaries, with optional acknowledgement loss."""

    def __init__(self):
        self.apps = {}
        self.notices = []
        self.lost_notice = False
        self.lost_start = False
        self.replace = None
        self.signed_result_hash = None

    async def handle_async_request(self, request):
        if request.url.host == "workbench":
            assert request.headers["authorization"] == AUTH["Authorization"]
            if self.lost_notice:
                raise httpx.ConnectError("local callback delivery unavailable")
            self.notices.append(json.loads(await request.aread()))
            return httpx.Response(202)
        result = await httpx.ASGITransport(app=self.apps[request.url.host]).handle_async_request(request)
        if self.lost_start and request.url.path == "/a2a" and json.loads(await request.aread())["method"] == "message/send":
            self.lost_start = False
            raise httpx.ReadError("local response lost after acceptance")
        if self.replace and request.url.path == "/a2a" and json.loads(await request.aread())["method"] == "tasks/get":
            body = json.loads(await result.aread())
            self.replace(body)
            modified = canonical(body)
            return httpx.Response(200, content=modified, headers={"X-JWS-Signature": self.apps["mock"].state.sign(modified)})
        if request.url.path == "/a2a" and json.loads(await request.aread())["method"] == "tasks/get":
            self.signed_result_hash = "sha256:" + hashlib.sha256(await result.aread()).hexdigest()
        return result


@pytest.fixture
def runtime(monkeypatch, tmp_path):
    for name, value in {
        "PARTNER_DB": str(tmp_path / "adapter.sqlite"), "MOCK_DB": str(tmp_path / "mock.sqlite"),
        "AMAZON_MOCK_URL": "http://mock", "PARTNER_CALLBACK_URL": "http://adapter/a2a/notifications",
        "WORKBENCH_NOTICE_URL": "http://workbench/private/notice", "SHOWCASE_PARTNER_TOKEN": "bridge-test",
        "SHOWCASE_CALLBACK_TOKEN": "callback-test", "SHOWCASE_MOCK_CLIENT_SECRET": "oauth-test",
    }.items():
        monkeypatch.setenv(name, value)
    network = Network()
    http = httpx.AsyncClient(transport=network)
    def restart():
        network.apps.update(adapter=adapter.create_app(http=http), mock=mock.create_app(http=http))
    restart()
    return network, http, restart


@pytest.mark.asyncio
async def test_real_exchange_replay_poll_and_restart(runtime):
    n, http, restart = runtime
    async with http:
        n.lost_start = True
        first = await http.post("http://adapter/requests", json=START, headers=AUTH)
        assert first.status_code == 200, first.text
        ref = first.json()
        assert ref["taskId"].startswith("amz-") and ref["state"] == "working"
        url = "http://adapter/requests/req-01"
        for _ in range(3):
            assert (await http.get(url, headers=AUTH)).json()["state"] == "working"
        restart()
        assert (await http.post("http://adapter/requests", json=START, headers=AUTH)).json() == ref
        conflict = await http.post("http://adapter/requests", json={**START, "actorId": "alex"}, headers=AUTH)
        assert conflict.status_code == 409
        n.lost_notice = True
        assert (await http.post(url + "/release", headers=AUTH)).json() == {"released": True, "notificationDelivered": False}
        assert not n.notices
        result = (await http.get(url, headers=AUTH)).json()
        assert result["taskId"] == ref["taskId"] and result["state"] == "completed"
        assert result["signedResponseHash"] == n.signed_result_hash
        artifact = result["artifact"]
        assert artifact["schema"] == "query.wage_evidence/1.0.0/output"
        assert artifact["data"]["payPeriods"][0]["grossEarnings"] == {"amount": "1830.00", "currency": "USD"}
        assert artifact["provenance"]["recordIds"] == ["mock-rec-001"]
        restart()
        n.lost_notice = False
        for _ in range(2):
            assert (await http.post(url + "/release", headers=AUTH)).json()["notificationDelivered"]
        assert n.notices == [{k: ref[k] for k in ("requestId", "workItemId", "taskId", "contextId", "eventId")}] * 2
        replay = (await http.get(url, headers=AUTH)).json()
        # Each signed tasks/get echoes a new RPC id, so the raw response hash changes on re-fetch.
        assert replay.pop("signedResponseHash") == n.signed_result_hash
        assert replay == {k: v for k, v in result.items() if k != "signedResponseHash"}
        with sqlite3.connect(os.environ["MOCK_DB"]) as db:
            assert db.execute("SELECT count(*) FROM held").fetchone()[0] == 1


@pytest.mark.asyncio
async def test_notification_and_refetch_fail_closed(runtime):
    n, http, _ = runtime
    async with http:
        ref = (await http.post("http://adapter/requests", json=START, headers=AUTH)).json()
        with sqlite3.connect(os.environ["MOCK_DB"]) as db:
            token, context = db.execute("SELECT push_token, context_id FROM held").fetchone()
        endpoint = "http://adapter/a2a/notifications"
        body = canonical({"id": ref["taskId"], "contextId": context, "data": {"forged": "ignore"}})
        headers = {"Authorization": "Bearer callback-test", "X-A2A-Notification-Token": token,
                   "X-JWS-Signature": n.apps["mock"].state.sign(body)}
        assert (await http.post(endpoint, content=body, headers={**headers, "Authorization": "Bearer bad"})).status_code == 401
        assert (await http.post(endpoint, content=body + b" ", headers=headers)).status_code == 401
        assert (await http.post(endpoint, content=body, headers={**headers, "X-A2A-Notification-Token": "bad"})).status_code == 403
        assert not n.notices
        assert (await http.post(endpoint, content=body, headers=headers)).status_code == 202
        assert n.notices == [{k: ref[k] for k in ("requestId", "workItemId", "taskId", "contextId", "eventId")}]
        url = "http://adapter/requests/req-01"
        assert (await http.get(url, headers=AUTH)).json()["state"] == "working"
        await http.post(url + "/release", headers=AUTH)
        def artifact(body):
            return body["result"]["artifacts"][0]["parts"][0]["data"]
        for change in [
            lambda body: artifact(body)["data"]["payPeriods"][0]["grossEarnings"].update(amount="1850.00"),
            lambda body: artifact(body)["data"].update(payFrequency="invalid"),
            lambda body: artifact(body).pop("provenance"),
            lambda body: body["result"].update(contextId="another"),
            lambda body: body["result"].update(id="another"),
        ]:
            n.replace = change
            response = await http.get(url, headers=AUTH)
            assert response.status_code == 502 and "1850" not in response.text


@pytest.mark.asyncio
async def test_no_browser_credentials_or_injected_claim_input(runtime):
    _, http, _ = runtime
    async with http:
        assert (await http.post("http://adapter/requests", json=START)).status_code == 401
        for fields in [{"workItemId": "WC-101"}, {"input": {"claimNumber": "WC-999"}}]:
            assert (await http.post("http://adapter/requests", json={**START, **fields}, headers=AUTH)).status_code == 422
        assert (await http.post("http://mock/oauth/token", data={"grant_type": "client_credentials", "client_id": "enterprise-agent-showcase"})).status_code == 401
        assert (await http.post("http://mock/presenter/tasks/anything/release")).status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize("claim,start,end,periods", [
    ("CLM-000020", "2023-12-08", "2024-12-05", 1),
    ("CLM-000002", "2023-02-05", "2024-02-03", 26),
])
async def test_claim_specific_approved_disclosure_and_pay_periods(runtime, claim, start, end, periods):
    _, http, _ = runtime
    async with http:
        payload = {**START, "workItemId":claim, "input":{**START["input"], "claimNumber":claim,
                   "dateRangeStart":start, "dateRangeEnd":end}}
        sent = await http.post("http://adapter/requests", json=payload, headers=AUTH)
        assert sent.status_code == 200, sent.text
        receipt = await http.get("http://adapter/requests/req-01/receipt", headers=AUTH)
        assert receipt.json() == sent.json()
        await http.post("http://adapter/requests/req-01/release", headers=AUTH)
        returned = await http.get("http://adapter/requests/req-01", headers=AUTH)
        assert returned.status_code == 200, returned.text
        rows = returned.json()["artifact"]["data"]["payPeriods"]
        assert len(rows) == periods and rows[0]["periodStart"] == start
        if periods > 1:
            assert rows[-1]["periodEnd"] == end
