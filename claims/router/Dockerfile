FROM docker.io/library/python:3.12-slim
WORKDIR /router
COPY requirements.txt .
RUN pip install --no-cache-dir --disable-pip-version-check -r requirements.txt
COPY serve.py .
USER 65534:65534
CMD ["python", "-B", "serve.py"]
