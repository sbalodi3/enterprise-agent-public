FROM docker.io/library/python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app/src PYTHONUNBUFFERED=1
COPY uv.lock locked_requirements.py ./
RUN python locked_requirements.py > /tmp/locked-requirements.txt \
    && pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: --require-hashes -r /tmp/locked-requirements.txt
COPY src/ src/
COPY contracts/ contracts/
COPY adapter.py boundary.py mock.py upstream.sha256 wage-case.json ./
RUN groupadd -g 12001 showcase && useradd -u 12001 -g showcase -M showcase && mkdir /data && chown showcase:showcase /data
USER showcase
CMD ["uvicorn", "adapter:create_app", "--factory", "--host", "0.0.0.0", "--port", "8090", "--no-access-log"]
