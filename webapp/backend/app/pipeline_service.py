"""Upload handling for the isolated generic PFD analysis queue.

The heavy pipeline is intentionally *not* invoked here until all generic
adapters have been validated.  This avoids presenting PFD-230's frozen demo
result as if it belonged to an arbitrary uploaded PDF.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import json
import re
import time
from pathlib import Path

from fastapi import UploadFile

from .analysis_jobs import PROJECT_ROOT, completed_job_for_file, create_job, get_job, job_dir, update_job


def latest_ocr_tile_message(log_path: Path) -> str | None:
    """Read the latest tile marker emitted by existing and new OCR workers.

    This fallback keeps the web UI informative even for a worker that started
    before the richer JSON progress channel was introduced.
    """

    try:
        with log_path.open("rb") as handle:
            handle.seek(0, 2)
            handle.seek(max(0, handle.tell() - 32_768))
            text = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return None
    matches = re.findall(r"Page\s+(\d+),\s+tuile\s+(\d+)/(\d+)", text)
    if not matches:
        return None
    page, current, total = matches[-1]
    return f"Lecture OCR : page {page}, tuile {current}/{total} en cours."


async def create_analysis(upload: UploadFile) -> dict[str, str | bool]:
    if not upload.filename or not upload.filename.lower().endswith(".pdf"):
        raise ValueError("Only PDF uploads are accepted.")
    with tempfile.TemporaryDirectory(prefix="pfd-intelligence-") as temp_dir:
        target = Path(temp_dir) / Path(upload.filename).name
        with target.open("wb") as handle:
            while chunk := await upload.read(1024 * 1024):
                handle.write(chunk)
        previous = completed_job_for_file(target)
        if previous is not None:
            return {
                "analysis_id": previous["analysis_id"],
                "mode": "generic-pfd",
                "pipeline_started": False,
                "reused": True,
                "status": "completed",
                "message": "Ce PDF identique a déjà été analysé localement ; ses résultats réels sont réutilisés.",
            }
        job = create_job(target, upload.filename)
    return {
        "analysis_id": job["analysis_id"],
        "mode": "generic-pfd",
        "pipeline_started": True,
        "reused": False,
        "status": job["status"],
        "message": "PDF received. Perception analysis (OCR + YOLO + tag association) has been queued.",
    }


def start_analysis_job(analysis_id: str) -> None:
    """Start an analysis in an independent Windows process.

    Uvicorn's development reloader stops in-process background tasks whenever
    source code changes.  A detached worker keeps a long OCR run independent
    from that web-server lifecycle.
    """

    update_job(
        analysis_id,
        status="queued",
        worker_started=True,
        message="PDF queued; starting the dedicated perception worker.",
    )
    backend_python = PROJECT_ROOT / "webapp" / "backend" / ".venv" / "Scripts" / "python.exe"
    command = [str(backend_python), "-m", "app.worker", analysis_id]
    flags = 0
    if sys.platform == "win32":
        # Keep the worker independent of Uvicorn's reload process without
        # opening a distracting empty console window for each PDF analysis.
        # CREATE_NO_WINDOW is incompatible with DETACHED_PROCESS, so do not
        # combine the two flags here.
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    try:
        worker = subprocess.Popen(
            command,
            cwd=PROJECT_ROOT / "webapp" / "backend",
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
        )
        update_job(analysis_id, worker_pid=worker.pid)
    except OSError as exc:
        update_job(analysis_id, status="failed", message=f"Unable to start the local worker: {exc}")
        raise


def run_analysis_job(analysis_id: str) -> None:
    """Run the real reusable perception workflow in its dedicated environments.

    This deliberately stops after OCR, six-class YOLO and reviewable tag
    association.  The frozen PFD-230 geometry/topology stages are not reused
    for another document and no process graph is fabricated.
    """

    job = get_job(analysis_id)
    if job is None:
        return
    directory = job_dir(analysis_id)
    input_path = PROJECT_ROOT / job["source_file"]
    log_path = directory / "pipeline.log"
    progress_path = directory / "progress.json"
    progress_path.unlink(missing_ok=True)
    command = [
        str(PROJECT_ROOT / ".venv" / "Scripts" / "python.exe"),
        str(PROJECT_ROOT / "scripts" / "run_generic_pfd_stage10.py"),
        str(input_path), "--job-dir", str(directory), "--device", "cpu",
        "--progress-file", str(progress_path),
    ]
    with log_path.open("w", encoding="utf-8") as log:
        log.write("COMMAND: " + subprocess.list2cmdline(command) + "\n\n")
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, text=True)
        seen_status: str | None = None
        seen_message: str | None = None
        cancelled = False
        while process.poll() is None:
            # A browser close requests cancellation through the API.  Stop the
            # complete child process tree so PaddleOCR/YOLO cannot continue in
            # the background after the user has left the application.
            if (get_job(analysis_id) or {}).get("status") == "cancelled":
                cancelled = True
                if sys.platform == "win32":
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                    )
                else:
                    process.terminate()
                break
            if progress_path.is_file():
                try:
                    progress = json.loads(progress_path.read_text(encoding="utf-8"))
                    status = str(progress.get("status", ""))
                    message = str(progress.get("message", "Processing uploaded PDF."))
                    if status == "running_ocr":
                        message = latest_ocr_tile_message(log_path) or message
                    if status in {"rendering_pdf", "running_ocr", "running_yolo", "associating"} and (status != seen_status or message != seen_message):
                        update_job(analysis_id, status=status, message=message)
                        seen_status = status
                        seen_message = message
                except (OSError, json.JSONDecodeError):
                    pass
            time.sleep(0.5)
        return_code = process.returncode
    if cancelled or (get_job(analysis_id) or {}).get("status") == "cancelled":
        return
    if return_code == 0:
        update_job(
            analysis_id,
            status="completed",
            message="Real perception analysis completed: OCR, YOLO detections and reviewable tag associations are available.",
            pipeline={
                "mode": "generic-pfd",
                "stages": {
                    "ocr": "completed", "yolo": "completed", "tag_association": "completed",
                    "line_topology": "not_started", "structured_json": "not_started",
                },
                "manifest": str((directory / "stage10_perception_manifest.json").relative_to(PROJECT_ROOT)),
            },
        )
        return
    # A manually stopped internal test must remain visibly cancelled rather
    # than being overwritten by the subprocess's non-zero exit code.
    if (get_job(analysis_id) or {}).get("status") == "cancelled":
        return
    update_job(
        analysis_id,
        status="failed",
        message=f"Perception analysis stopped with exit code {return_code}. See pipeline.log.",
        pipeline={"mode": "generic-pfd", "stages": {"ocr": "failed_or_incomplete", "yolo": "not_started_or_incomplete", "tag_association": "not_started_or_incomplete", "line_topology": "not_started", "structured_json": "not_started"}},
    )
