#!/usr/bin/env bash

set -euo pipefail

exec gunicorn -k uvicorn.workers.UvicornWorker main:app --workers 4 --bind 0.0.0.0:8000
