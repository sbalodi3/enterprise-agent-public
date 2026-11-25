# Docker artifact check

On November 18, 2026, Docker Desktop's local BuildKit v0.34.0 exported two synthetic contexts using the [full build filter](../deploy/Dockerfile.dockerignore) and the [refresh filter](../deploy/Dockerfile.refresh.dockerignore). Each used `FROM scratch` and `COPY . /`. Both excluded eight marked paths, including the Claude symlink. Neither export contained the private marker anywhere. Both retained a mock runtime file and a mock UI file with their contents intact. Only the synthetic context and the ignore files reached the builder.

| Evidence | Full | Refresh |
| --- | --- | --- |
| Internal architecture documents, claims guides, audit doc, generated report, demo environment file, model file | All excluded | All excluded |
| Selected runtime and UI controls | Both included | Both included |
| Root contributor guide control in the synthetic context | Included | Excluded |

Read-only containers from existing images `claims-workbench:local` (`495fb8087b92`) and `claims-workbench:verified-harness` (`33afaef17b40`) contained the claims launcher. Both lacked root `AGENTS.md` and `.agents/skills/`, and `claims/{AGENTS.md,CLAUDE.md,docs,deploy/reports,deploy/.env}`. Both contained upstream `packages/AGENTS.md` and `docs/AGENTS.md`. The [full Dockerfile](../deploy/Dockerfile) copies selected top-level paths and keeps the built workspace in the final image. A source file available in its build context can therefore be absent from the image. The [refresh Dockerfile](../deploy/Dockerfile.refresh) inherits its base image's filesystem, so check the base when it changes.

These tests cover Docker's filtering of the named paths and the selected image filesystems. Both images predate the documentation changes. Image history, registry caches, other build configurations, the website, package publishing, and Git transfers require their own checks.

## Repeat the context test

Run from the Git root with Python 3 and a local Docker Desktop builder named `desktop-linux`. The test uses fresh fake files in a temporary directory and exports ordinary files there. It leaves the application and its image tags in place.

```sh
python3 - <<'PY'
from pathlib import Path
from subprocess import check_output, run
from tempfile import TemporaryDirectory
from uuid import uuid4

builder = "desktop-linux"
socket = check_output(
    ["docker", "context", "inspect", builder, "--format", '{{(index .Endpoints "docker").Host}}'],
    text=True,
).strip()
assert socket.startswith("unix://"), f"Expected a local socket, found {socket}"
private_paths = [
    "claims/AGENTS.md", "claims/CLAUDE.md", "claims/docs/report.md",
    "claims/deploy/reports/test.txt", "claims/deploy/.env", "claims/deploy/models/test.gguf",
]
controls = ["claims/runtime/launch.mjs", "packages/client/ui-layout/src/control.ts"]
private = f"private-source-{uuid4()}".encode()
product = f"product-source-{uuid4()}".encode()
with TemporaryDirectory() as tmp:
    root = Path(tmp)
    context = root / "context"
    for name in private_paths + controls + ["AGENTS.md"]:
        file = context / name
        file.parent.mkdir(parents=True, exist_ok=True)
        if name == "claims/CLAUDE.md":
            file.symlink_to("AGENTS.md")
        else:
            file.write_bytes(private if name in private_paths else product)
    for name in ("Dockerfile", "Dockerfile.refresh"):
        relative = Path("claims/deploy") / name
        recipe = context / relative
        recipe.write_text("FROM scratch\nCOPY . /\n")
        ignore = Path(str(relative) + ".dockerignore")
        (context / ignore).write_bytes(ignore.read_bytes())
        output = root / ("out-" + name)
        run(["docker", "--context", builder, "buildx", "build", "--builder", builder,
             "--network=none", "--no-cache", "--file", str(recipe), "--output",
             f"type=local,dest={output}", str(context)], check=True)
        assert all(not (output / p).exists() and not (output / p).is_symlink() for p in private_paths)
        assert all((output / p).read_bytes() == product for p in controls)
        assert all(private not in p.read_bytes() for p in output.rglob("*") if p.is_file())
        assert (output / "AGENTS.md").exists() == (name == "Dockerfile")
        print(name, "excluded all eight marked paths and retained both controls")
PY
```
