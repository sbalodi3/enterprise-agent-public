"""Offline CPU inference. Only the work service can address this internal HTTP listener."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


class Router:
    def __init__(self, folder):
        self.meta = json.loads((folder / "manifest.json").read_text())
        self.tokens = Tokenizer.from_file(str(folder / "tokenizer.json"))
        self.tokens.enable_truncation(max_length=self.meta["max_length"])
        self.weights = np.asarray(self.meta["weights"], dtype=np.float32)
        self.bias = np.asarray(self.meta["bias"], dtype=np.float32)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(folder / "model.onnx"), options, providers=["CPUExecutionProvider"]
        )

    def classify(self, text):
        tokens = self.tokens.encode(text)
        feed = {
            name: np.asarray([values], dtype=np.int64)
            for name, values in [
                ("input_ids", tokens.ids),
                ("attention_mask", tokens.attention_mask),
                ("token_type_ids", tokens.type_ids),
            ]
        }
        embedding = self.session.run(["embedding"], feed)[0][0]
        logits = self.weights @ embedding + self.bias
        exp = np.exp(logits - logits.max())
        probabilities = exp / exp.sum()
        first, second = np.argsort(probabilities)[-2:][::-1]
        return {
            "intent": self.meta["labels"][first],
            "confidence": float(probabilities[first]),
            "margin": float(probabilities[first] - probabilities[second]),
            "version": self.meta["version"],
        }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, result):
        payload = json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"version": self.server.router.meta["version"]})
        self.reply(404, {})

    def do_POST(self):
        if self.path != "/classify":
            return self.reply(404, {})
        try:
            size = int(self.headers.get("Content-Length", 0))
            if not 1 <= size <= 32768:
                return self.reply(413, {})
            body = json.loads(self.rfile.read(size))
            if (
                set(body) != {"text"}
                or not isinstance(body["text"], str)
                or not 1 <= len(body["text"]) <= 6000
            ):
                return self.reply(400, {})
        except (ValueError, KeyError, TypeError):
            return self.reply(400, {})
        self.reply(200, self.server.router.classify(body["text"]))


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8093), Handler)
    server.router = Router(Path(os.environ.get("ROUTER_MODEL_DIR", "/model")))
    server.serve_forever()
