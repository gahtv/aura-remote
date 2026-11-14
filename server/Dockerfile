FROM python:3.12-slim

WORKDIR /app

# adb is optional: it is only used to launch Aura when it is not running.
# Everything else (library, queue, transport, mirroring) goes through Aura's
# own mirror link and needs no Android tooling at all.
RUN apt-get update \
    && apt-get install -y --no-install-recommends adb \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY web/ web/

ENV PORT=8099
ENV AURA_ACTIVITY=com.hans.aura/.MainActivity
EXPOSE 8099
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
