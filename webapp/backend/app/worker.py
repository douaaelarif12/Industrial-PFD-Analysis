"""Detached local worker entry point for one persisted analysis job."""

from __future__ import annotations

import sys

from .pipeline_service import run_analysis_job


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python -m app.worker <analysis_id>")
    run_analysis_job(sys.argv[1])
