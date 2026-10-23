# Elpis on Railway (or any container host). Attach a volume at /data so conversations survive redeploys.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend backend
COPY frontend frontend
ENV ELPIS_DB_PATH=/data/elpis.db PYTHONUNBUFFERED=1
WORKDIR /app/backend
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-3000} --proxy-headers --forwarded-allow-ips="*"
