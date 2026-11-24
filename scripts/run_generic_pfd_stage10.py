"""Execute the first reusable per-PDF workflow: OCR + YOLO + tag candidates.

This runner is intentionally limited to the validated perception stages.  It
does not invoke the frozen PFD-230 topology stages, infer process directions,
or claim an equipment-to-equipment graph.  Every output is written beneath the
provided job directory.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import fitz


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_pdf", type=Path)
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--ocr-python", type=Path, default=PROJECT_ROOT / ".venv" / "Scripts" / "python.exe")
    parser.add_argument("--yolo-python", type=Path, default=PROJECT_ROOT / ".venv_yolo_eval" / "Scripts" / "python.exe")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--progress-file", type=Path, help="Optional JSON status file for the local web worker.")
    return parser.parse_args()


def run(command: list[str]) -> None:
    print("+", subprocess.list2cmdline(command), flush=True)
    subprocess.run(command, check=True)


def report_progress(path: Path | None, status: str, message: str) -> None:
    """Publish a small, atomic progress record without touching scientific outputs."""

    print(f"[progress] {status}: {message}", flush=True)
    if path is None:
        return
    import time
    for attempt in range(4):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(path.suffix + ".tmp")
            temporary.write_text(
                json.dumps({"status": status, "message": message}, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            temporary.replace(path)
            return
        except OSError as exc:
            if attempt == 3:
                print(f"[progress-warning] Avancement non publié : {exc}", flush=True)
                return
            time.sleep(0.05 * (attempt + 1))


def main() -> int:
    args = parse_args()
    pdf = args.input_pdf.resolve(); job_dir = args.job_dir.resolve()
    if not pdf.is_file() or pdf.suffix.lower() != ".pdf":
        raise FileNotFoundError(pdf)
    if not args.ocr_python.is_file() or not args.yolo_python.is_file():
        raise FileNotFoundError("OCR or YOLO virtual-environment Python is unavailable")
    with fitz.open(pdf) as document:
        if document.page_count != 1:
            raise ValueError(f"This first generic runner supports one-page PFDs only; received {document.page_count} pages.")
    for directory in (job_dir / "ocr", job_dir / "yolo", job_dir / "association", job_dir / "render_150dpi"):
        directory.mkdir(parents=True, exist_ok=True)
    progress_file = args.progress_file.resolve() if args.progress_file else None
    ocr_root = job_dir / "ocr" / pdf.stem
    ocr_json = ocr_root / f"{pdf.stem}_paddleocr.json"
    ocr_page = ocr_root / "pages" / "page_0001.png"
    yolo_source = job_dir / "render_150dpi" / "page_0001.png"
    report_progress(progress_file, "rendering_pdf", "Rendering the PDF for YOLO tiling.")
    if yolo_source.is_file():
        print("Reusing completed 150-DPI render.")
    else:
        run([str(args.ocr_python), str(PROJECT_ROOT / "scripts" / "render_pfd_pages.py"), str(pdf), "--output-dir", str(job_dir / "render_150dpi"), "--dpi", "150"])
    report_progress(progress_file, "running_ocr", "Running PaddleOCR on the uploaded PDF.")
    if ocr_json.is_file() and ocr_page.is_file():
        print("Reusing completed OCR output.")
    else:
        ocr_command = [
            str(args.ocr_python), str(PROJECT_ROOT / "scripts" / "test_paddleocr.py"), str(pdf),
            "--output-dir", str(job_dir / "ocr"), "--dpi", "72", "--tile-size", "1600",
            "--tile-overlap", "128", "--det-limit-side-len", "2000",
        ]
        if progress_file is not None:
            ocr_command.extend(["--progress-file", str(progress_file)])
        run(ocr_command)
    detections_json = job_dir / "yolo" / "detections.json"
    report_progress(progress_file, "running_yolo", "Running six-class YOLO equipment detection.")
    if detections_json.is_file():
        print("Reusing completed YOLO output.")
    else:
        run([str(args.yolo_python), str(PROJECT_ROOT / "scripts" / "infer_yolo_generic_pfd.py"), str(yolo_source), "--target-page", str(ocr_page), "--output-dir", str(job_dir / "yolo"), "--device", args.device, "--save-tiles"])
    report_progress(progress_file, "associating", "Extracting OCR tag candidates and computing spatial associations.")
    tag_candidates = job_dir / "association" / "equipment_tag_candidates.json"
    if not tag_candidates.is_file():
        run([str(args.ocr_python), str(PROJECT_ROOT / "scripts" / "extract_equipment_tags.py"), str(ocr_json), "--output", str(tag_candidates)])
    associations = job_dir / "association" / "equipment_associations.json"
    if not associations.is_file():
        run([str(args.ocr_python), str(PROJECT_ROOT / "scripts" / "associate_generic_ocr_yolo.py"), str(ocr_json), str(detections_json), "--candidates-json", str(tag_candidates), "--output", str(associations)])
    graph_json = job_dir / "graph" / "equipment_graph.json"
    report_progress(progress_file, "associating", "Building the conservative equipment connectivity graph.")
    if not graph_json.is_file():
        run([str(args.ocr_python), str(PROJECT_ROOT / "scripts" / "build_generic_pfd_graph.py"), "--page", str(ocr_page), "--ocr", str(ocr_json), "--yolo", str(detections_json), "--associations", str(associations), "--output", str(graph_json)])
    manifest = {"schema_version": "1.0", "completed_at": datetime.now(UTC).isoformat(timespec="seconds"), "input_pdf": str(pdf), "scope": "OCR + six-class YOLO + reviewable spatial tag candidates + conservative connectivity graph", "not_run": ["validated process direction", "final structured process graph"], "outputs": {"ocr_json": str(ocr_json), "ocr_page": str(ocr_page), "yolo_detections": str(detections_json), "tag_candidates": str(tag_candidates), "associations": str(associations), "graph_json": str(graph_json)}}
    (job_dir / "stage10_perception_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Generic perception workflow completed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"Stage failed with subprocess code {exc.returncode}", file=sys.stderr)
        raise SystemExit(exc.returncode)
