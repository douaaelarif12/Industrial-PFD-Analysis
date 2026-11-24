"""Persistent, isolated job records for uploaded PFD analyses.

This module deliberately does not read or write the frozen Stage 01--08
artifacts.  Each uploaded document instead receives its own runtime folder;
the generic pipeline adapters will write their outputs there in later steps.
"""

from __future__ import annotations

import json
import hashlib
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4


PROJECT_ROOT = Path(__file__).resolve().parents[3]
JOBS_ROOT = PROJECT_ROOT / "webapp" / "runtime" / "analyses"


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _safe_filename(filename: str) -> str:
    # Keep a readable filename, but avoid path traversal and characters that are
    # problematic on Windows.  The original upload remains inside its job only.
    name = Path(filename).name
    name = re.sub(r"[^A-Za-z0-9._ -]", "_", name).strip(". ")
    return name or "uploaded_pfd.pdf"


def job_dir(analysis_id: str) -> Path:
    return JOBS_ROOT / analysis_id


def metadata_path(analysis_id: str) -> Path:
    return job_dir(analysis_id) / "job.json"


def file_sha256(path: Path) -> str:
    """Return a stable content identity for an uploaded PDF."""

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def completed_job_for_file(upload_path: Path) -> dict[str, Any] | None:
    """Find an existing completed result for the *same bytes* only.

    Filename matching would be unsafe: two revisions can have the same name.
    This deliberately reuses only an identical local upload and never the
    PFD-230 demonstration assets.
    """

    if not JOBS_ROOT.is_dir():
        return None
    upload_hash = file_sha256(upload_path)
    for path in sorted(JOBS_ROOT.glob("*/job.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
            if job.get("status") != "completed":
                continue
            source = PROJECT_ROOT / str(job.get("source_file", ""))
            if not source.is_file():
                continue
            source_hash = str(job.get("source_sha256") or file_sha256(source))
            if source_hash == upload_hash:
                return job
        except (OSError, json.JSONDecodeError):
            continue
    return None


def create_job(upload_path: Path, original_filename: str) -> dict[str, Any]:
    """Create a queued job and move an already validated temporary upload into it."""

    analysis_id = f"analysis-{uuid4().hex[:12]}"
    directory = job_dir(analysis_id)
    input_dir = directory / "input"
    input_dir.mkdir(parents=True, exist_ok=False)
    destination = input_dir / _safe_filename(original_filename)
    shutil.move(str(upload_path), destination)
    metadata: dict[str, Any] = {
        "analysis_id": analysis_id,
        "status": "queued",
        "worker_started": False,
        "created_at": _utc_now(),
        "updated_at": _utc_now(),
        "source_file": str(destination.relative_to(PROJECT_ROOT)),
        "original_filename": original_filename,
        "source_sha256": file_sha256(destination),
        "pipeline": {
            "mode": "generic-pfd",
            "stages": {
                "ocr": "pending",
                "yolo": "pending",
                "tag_association": "pending",
                "line_topology": "pending",
                "structured_json": "pending",
            },
        },
        "message": "PDF received. Generic pipeline adapters are being prepared; processing has not started.",
    }
    metadata_path(analysis_id).write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return metadata


def get_job(analysis_id: str) -> dict[str, Any] | None:
    path = metadata_path(analysis_id)
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def active_running_job() -> dict[str, Any] | None:
    """Return the single locally running CPU-heavy analysis, if any."""

    if not JOBS_ROOT.is_dir():
        return None
    for path in sorted(JOBS_ROOT.glob("*/job.json"), key=lambda item: item.stat().st_mtime, reverse=True):
        job = json.loads(path.read_text(encoding="utf-8"))
        if job.get("worker_started") and job.get("status") in {
            "queued", "rendering_pdf", "running_ocr", "running_yolo", "associating"
        }:
            return job
    return None


def latest_job() -> dict[str, Any] | None:
    """Return the most recently updated local analysis job, including a completed one."""

    if not JOBS_ROOT.is_dir():
        return None
    paths = sorted(JOBS_ROOT.glob("*/job.json"), key=lambda item: item.stat().st_mtime, reverse=True)
    for path in paths:
        job = json.loads(path.read_text(encoding="utf-8"))
        # Do not resurrect abandoned records from an earlier local session.
        # A completed/failed record is useful to display; a queued one is only
        # meaningful once this version of the backend actually started it.
        if job.get("status") in {"completed", "failed"} or job.get("worker_started"):
            return job
    return None


def latest_completed_job() -> dict[str, Any] | None:
    """Return the newest usable result, ignoring cancelled/failed attempts."""

    if not JOBS_ROOT.is_dir():
        return None
    paths = sorted(JOBS_ROOT.glob("*/job.json"), key=lambda item: item.stat().st_mtime, reverse=True)
    for path in paths:
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if job.get("status") == "completed":
            return job
    return None


def update_job(analysis_id: str, **changes: Any) -> dict[str, Any]:
    """Atomically enough for this single-process local development workflow."""

    job = get_job(analysis_id)
    if job is None:
        raise FileNotFoundError(analysis_id)
    job.update(changes)
    job["updated_at"] = _utc_now()
    metadata_path(analysis_id).write_text(json.dumps(job, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return job
