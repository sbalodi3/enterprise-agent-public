# Local wage partner

English | [中文](README.zh.md)

The single Podman app includes a bundled synthetic wage service for a fresh installation. It accepts reviewed disclosures for seeded claims, persists task and receipt IDs, and returns the generated evidence when the presenter releases the result. It uses the same private Workbench interface and Temporal workflow. Evidence from this backend is marked synthetic-payroll. Use the signed A2A backend to test agent-card discovery and the external signature boundary.

The showcase runs the sibling A2A client's card discovery, OAuth exchange, JSON-RPC, detached ES256 verification, schema checks and validation of the returned wage records’ source fields against the sibling Amazon wage mock. Both run on the private demo network. This fixture uses HTTP and local service credentials. The proposed partner mTLS, production identity, signing-key custody and bilateral contract still need enterprise validation.

The builder fingerprints an explicit file list, copies it into a new directory and applies [the presenter patch](presenter.patch). The digest manifest covers the active `query.wage_evidence/1.0.0` schemas, client, mock and lock. A fingerprint mismatch stops preparation so a developer can review the change. Dependencies come from the corresponding wheel hashes in that lock. The sibling checkout is read-only.

Workbench sends the exact approved disclosure for the authenticated actor and claim. The operation ID and payload digest bind the partner receipt to the reviewed request. Workbench recovers a lost acknowledgement by looking up the original request ID. SQLite reserves the original message, task, trace and callback token before transmission. The presenter releases the durable mock task and sends a signed notification. The adapter checks the callback service credential, raw signature, task token and context and forwards only correlation to the Workbench. The worker reads the signed authoritative task after either a notice or a poll. The adapter recomputes the payload digest before returning the synthetic pay period, source system, as-of timestamp, record IDs and policy decision ID to the worker. A duplicate release carries the same event ID. Workbench owns claim entitlement, human approval and JURIS dispatch.

Run the showcase launcher from the repository root. To test the adapter and mock independently, use the sibling's existing Python 3.12 test environment and a fresh prepared directory.

```sh
repo_dir="$PWD"
a2a_dir="${SHOWCASE_A2A_SOURCE:-$HOME/Documents/A2A/dev_a2a_aws}"
context_dir="$(mktemp -d)"
python3 claims/showcase/partner/prepare.py --source "$a2a_dir" --output "$context_dir"
(cd "$context_dir" && PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=src "$a2a_dir/.venv/bin/python" -m pytest --import-mode=importlib -p no:cacheprovider -q "$repo_dir/claims/showcase/partner/test_partner.py")
```
