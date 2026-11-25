"""Train the local scope classifier. Input rows must be reviewed, deidentified text/label pairs."""

import argparse
import hashlib
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory

os.environ.update(
    HF_HUB_OFFLINE="1",
    HF_HUB_DISABLE_TELEMETRY="1",
    ACCELERATE_USE_CPU="true",
    TOKENIZERS_PARALLELISM="false",
)
import torch
from datasets import Dataset
from setfit import SetFitModel
from setfit.sampler import ContrastiveDataset
from sentence_transformers import (
    SentenceTransformerTrainer,
    SentenceTransformerTrainingArguments,
    losses,
)
from transformers import set_seed

HERE = Path(__file__).resolve().parent
REVISION = "c9745ed1d9f207416be6d2e6f8de32d1f16199bf"
LABELS = {"workspace", "claim", "document", "portfolio", "clarify"}


def train(base, rows_path, output):
    if output.exists():
        raise ValueError("Choose a new output directory for each model release")
    rows = [
        json.loads(line) for line in rows_path.read_text().splitlines() if line.strip()
    ]
    if {r["label"] for r in rows} != LABELS or any(
        set(r) != {"text", "label"} or not r["text"].strip() for r in rows
    ):
        raise ValueError(
            "Expected synthetic or reviewed examples for each routing label"
        )
    weights = base / "model.safetensors"
    if (
        hashlib.sha256(weights.read_bytes()).hexdigest()
        != "53aa51172d142c89d9012cce15ae4d6cc0ca6895895114379cacb4fab128d9db"
    ):
        raise ValueError("Base weights do not match the pinned MiniLM release")
    set_seed(41)
    torch.set_num_threads(4)
    model = SetFitModel.from_pretrained(
        str(base),
        local_files_only=True,
        device="cpu",
        head_params={"C": 20, "max_iter": 400, "random_state": 41},
    )
    texts = [row["text"] for row in rows]
    labels = [row["label"] for row in rows]
    # Use SetFit's sampler and two training phases; select the CPU explicitly on Apple Silicon.
    pairs = ContrastiveDataset(
        texts, labels, False, None, "oversampling", max_pairs=720
    )
    model.model_body.max_seq_length = 80
    args = SentenceTransformerTrainingArguments(
        output_dir=str(output.parent / "training-cache"),
        use_cpu=True,
        per_device_train_batch_size=12,
        max_steps=60,
        learning_rate=2e-5,
        warmup_ratio=0.1,
        seed=41,
        report_to="none",
        save_strategy="no",
    )
    SentenceTransformerTrainer(
        model=model.model_body,
        args=args,
        train_dataset=Dataset.from_list(list(pairs)),
        loss=losses.CosineSimilarityLoss(model.model_body),
    ).train()
    model.fit(texts, labels, num_epochs=1, show_progress_bar=False)
    destination = output
    with TemporaryDirectory(dir=destination.parent) as temp:
        model_dir = Path(temp) / "release"
        model_dir.mkdir()
        export_model(model, rows_path, model_dir)
        model_dir.rename(destination)
    print("Trained on", len(rows), "examples")


def export_model(model, rows_path, output):
    model.model_body.to("cpu")
    encoder = model.model_body[0].auto_model.eval()
    tokenizer = model.model_body.tokenizer
    tokenizer.backend_tokenizer.save(str(output / "tokenizer.json"))
    inputs = tokenizer("Pull up my case", return_tensors="pt")
    names = ["input_ids", "attention_mask", "token_type_ids"]

    # Export only the trained transformer and the normalised mean pooling used by MiniLM.
    class Embeddings(torch.nn.Module):
        def __init__(self, body):
            super().__init__()
            self.body = body

        def forward(self, input_ids, attention_mask, token_type_ids):
            states = self.body(
                input_ids=input_ids,
                attention_mask=attention_mask,
                token_type_ids=token_type_ids,
            )[0]
            mask = attention_mask.unsqueeze(-1)
            return torch.nn.functional.normalize(
                (states * mask).sum(1) / mask.sum(1).clamp(min=1), dim=1
            )

    torch.onnx.export(
        Embeddings(encoder).eval(),
        tuple(inputs[n] for n in names),
        str(output / "model.onnx"),
        input_names=names,
        output_names=["embedding"],
        opset_version=17,
        dynamic_axes={n: {0: "batch", 1: "tokens"} for n in names}
        | {"embedding": {0: "batch"}},
    )
    head = model.model_head
    meta = {
        "labels": head.classes_.tolist(),
        "weights": head.coef_.tolist(),
        "bias": head.intercept_.tolist(),
        "base": "sentence-transformers/all-MiniLM-L6-v2",
        "revision": REVISION,
        "max_length": 80,
        "training_sha256": hashlib.sha256(rows_path.read_bytes()).hexdigest(),
    }
    digest = hashlib.sha256(
        (output / "model.onnx").read_bytes()
        + (output / "tokenizer.json").read_bytes()
        + json.dumps(meta, sort_keys=True).encode()
    ).hexdigest()
    meta["version"] = "scope-minilm-" + digest[:12]
    (output / "manifest.json").write_text(json.dumps(meta))
    print(meta["version"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--examples", default=HERE / "train.jsonl", type=Path)
    args = parser.parse_args()
    train(args.base, args.examples, args.output)
