"""Materialize a fingerprinted, synthetic-only Docker context. Works with stock macOS Python."""

import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLIENT = ("__init__", "agent_card", "client", "envelope", "errors", "jws", "provenance", "retry", "schema")
FILES = (
    "uv.lock",
    "src/mocks/__init__.py", "src/mocks/amazon_wage_evidence/__init__.py",
    "src/mocks/amazon_wage_evidence/app.py",
    *(f"src/sedgwick_a2a/{name}.py" for name in CLIENT),
    *(f"contracts/query.wage_evidence/1.0.0/{kind}.schema.json" for kind in ("input", "output")),
)
LOCAL = ("Dockerfile", "locked_requirements.py", "boundary.py", "adapter.py", "mock.py")


def prepare(source, output):
    source, output = source.resolve(), output.resolve()
    if source == output or source in output.parents or output in source.parents:
        raise ValueError("The build context must be separate from the source checkout")
    if output.exists() and any(output.iterdir()):
        raise ValueError("Choose a new or empty build context")
    expected = (HERE / "upstream.sha256").read_text().splitlines()
    data = {}
    for name in sorted(FILES):
        path = source / name
        if path.resolve() != path or not path.is_file():
            raise ValueError(f"Expected a regular upstream file: {name}")
        data[name] = path.read_bytes()
    actual = [f"{hashlib.sha256(raw).hexdigest()}  {name}" for name, raw in data.items()]
    if actual != expected:
        raise ValueError("Upstream fingerprint changed. Review the changed allowlisted sources before refreshing upstream.sha256.")
    output.mkdir(parents=True, exist_ok=True)
    for name, raw in data.items():
        path = output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    subprocess.run(["patch", "-s", "-p1", "-i", str(HERE / "presenter.patch")], cwd=output, check=True)
    for name in LOCAL:
        shutil.copyfile(HERE / name, output / name)
    # Materialize just this synthetic claim from the shared fixture model; never mount the portfolio.
    module = (HERE.parent / "data" / "scenario.mjs").as_uri()
    read_case = """
      const {claims, wagePeriod} = await import(process.argv[1]);
      const c = claims.find(item => item.id === 'WC-102');
      process.stdout.write(JSON.stringify({claimNumber:c.id,associateName:c.claimant,state:c.jurisdiction,
        dateOfInjury:c.incidentDate,dateRangeStart:wagePeriod.periodStart,dateRangeEnd:wagePeriod.periodEnd}));
    """
    case = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", read_case, module]))
    (output / "wage-case.json").write_text(json.dumps(case, sort_keys=True))
    shutil.copyfile(HERE / "upstream.sha256", output / "upstream.sha256")
    print(f"Prepared {len(data)} verified sibling files and local showcase adapter at {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    prepare(args.source, args.output)
