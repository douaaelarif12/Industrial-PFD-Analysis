#!/usr/bin/env python
"""Exécute PaddleOCR (CPU) sur une image ou toutes les pages d'un PDF."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable

import fitz
import numpy as np
from PIL import Image, ImageDraw

SUPPORTED_IMAGES = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}
LOG = logging.getLogger("pfd-paddleocr")
PROJECT_ROOT = Path(__file__).resolve().parents[1]
# Empêche PaddleX/PaddleOCR d'écrire ses modèles hors du projet.
os.environ.setdefault("PADDLE_PDX_CACHE_HOME", str(PROJECT_ROOT / ".model_cache"))
# Les deux modeles sont deja versionnes dans le cache local du projet. Eviter
# le test reseau PaddleX a chaque analyse retire une attente de demarrage sans
# modifier les poids, la configuration OCR ou les resultats.
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="OCR PaddleOCR CPU avec sorties JSON, TXT et images annotées."
    )
    parser.add_argument("input", type=Path, help="PDF ou image à analyser")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=PROJECT_ROOT / "results" / "paddleocr",
        help="Répertoire racine des résultats",
    )
    parser.add_argument("--dpi", type=int, default=300, help="Résolution PDF (défaut: 300)")
    parser.add_argument("--lang", default="en", help="Langue PaddleOCR (défaut: en)")
    parser.add_argument(
        "--det-model",
        default="PP-OCRv5_mobile_det",
        help="Modèle de détection PaddleOCR (défaut: PP-OCRv5_mobile_det, adapté CPU)",
    )
    parser.add_argument(
        "--rec-model",
        default="en_PP-OCRv5_mobile_rec",
        help="Modèle de reconnaissance (défaut: en_PP-OCRv5_mobile_rec, adapté CPU)",
    )
    parser.add_argument(
        "--det-limit-side-len",
        type=int,
        default=4000,
        help="Taille maximale du grand côté pour la détection (défaut: 4000)",
    )
    parser.add_argument(
        "--tile-size",
        type=int,
        default=0,
        help="Découpe les grandes pages en tuiles carrées; 0 désactive (défaut: 0)",
    )
    parser.add_argument(
        "--tile-overlap",
        type=int,
        default=128,
        help="Chevauchement des tuiles en pixels (défaut: 128)",
    )
    parser.add_argument("--min-confidence", type=float, default=0.0)
    parser.add_argument(
        "--progress-file",
        type=Path,
        help="Fichier JSON facultatif mis a jour pendant l'OCR (usage application web).",
    )
    return parser.parse_args()


def publish_progress(progress_file: Path | None, **payload: Any) -> None:
    """Ecrit l'avancement de facon atomique, sans toucher aux sorties OCR."""

    if progress_file is None:
        return
    # A reader/antivirus may briefly lock the destination on Windows.
    # Progress is telemetry: failure to publish it must not abort OCR.
    import time
    for attempt in range(4):
        try:
            progress_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = progress_file.with_suffix(progress_file.suffix + ".tmp")
            temporary.write_text(
                json.dumps({"status": "running_ocr", **payload}, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            temporary.replace(progress_file)
            return
        except OSError as exc:
            if attempt == 3:
                print(f"[progress-warning] Avancement non publié : {exc}", flush=True)
                return
            time.sleep(0.05 * (attempt + 1))


def load_pages(input_path: Path, dpi: int) -> list[tuple[int, Image.Image]]:
    suffix = input_path.suffix.lower()
    if suffix == ".pdf":
        pages: list[tuple[int, Image.Image]] = []
        try:
            with fitz.open(input_path) as document:
                if document.page_count == 0:
                    raise ValueError("Le PDF ne contient aucune page.")
                matrix = fitz.Matrix(dpi / 72.0, dpi / 72.0)
                for index, page in enumerate(document):
                    pixmap = page.get_pixmap(matrix=matrix, alpha=False)
                    image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
                    pages.append((index + 1, image))
        except fitz.FileDataError as exc:
            raise ValueError(f"PDF illisible ou corrompu: {input_path}") from exc
        return pages
    if suffix in SUPPORTED_IMAGES:
        try:
            with Image.open(input_path) as opened:
                return [(1, opened.convert("RGB"))]
        except OSError as exc:
            raise ValueError(f"Image illisible ou corrompue: {input_path}") from exc
    raise ValueError(
        f"Format non pris en charge: {suffix or '(sans extension)'}. "
        f"Formats: PDF, {', '.join(sorted(SUPPORTED_IMAGES))}"
    )


def result_to_mapping(result: Any) -> dict[str, Any]:
    """Normalise un objet de résultat PaddleOCR 3.x en dictionnaire."""
    candidate = getattr(result, "json", result)
    if callable(candidate):
        candidate = candidate()
    if isinstance(candidate, str):
        candidate = json.loads(candidate)
    if not isinstance(candidate, dict):
        try:
            candidate = dict(candidate)
        except (TypeError, ValueError) as exc:
            raise TypeError(f"Format PaddleOCR inattendu: {type(result).__name__}") from exc
    payload = candidate.get("res", candidate)
    if not isinstance(payload, dict):
        raise TypeError("La clé 'res' de PaddleOCR n'est pas un objet JSON.")
    return payload


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        return value.tolist()
    return list(value)


def extract_detections(result: Any, page_number: int, threshold: float) -> list[dict[str, Any]]:
    payload = result_to_mapping(result)
    texts = as_list(payload.get("rec_texts"))
    scores = as_list(payload.get("rec_scores"))
    polygons_value = payload.get("rec_polys")
    if polygons_value is None:
        polygons_value = payload.get("dt_polys")
    polygons = as_list(polygons_value)
    detections: list[dict[str, Any]] = []
    for index, text in enumerate(texts):
        score = float(scores[index]) if index < len(scores) else None
        if score is not None and score < threshold:
            continue
        polygon = polygons[index] if index < len(polygons) else None
        box = [[float(point[0]), float(point[1])] for point in polygon] if polygon else None
        detections.append(
            {
                "text": str(text),
                "bounding_box": box,
                "confidence": score,
                "page_number": page_number,
            }
        )
    return detections


def annotate(image: Image.Image, detections: list[dict[str, Any]]) -> Image.Image:
    annotated = image.copy()
    draw = ImageDraw.Draw(annotated)
    for item in detections:
        box = item["bounding_box"]
        if not box:
            continue
        points = [(round(x), round(y)) for x, y in box]
        draw.line(points + [points[0]], fill=(255, 0, 0), width=max(2, image.width // 1000))
        label = item["text"]
        if item["confidence"] is not None:
            label += f" ({item['confidence']:.2f})"
        x, y = points[0]
        draw.text((x, max(0, y - 14)), label, fill=(220, 0, 0), stroke_width=1, stroke_fill="white")
    return annotated


def tile_starts(length: int, tile_size: int, overlap: int) -> list[int]:
    if length <= tile_size:
        return [0]
    step = tile_size - overlap
    starts = list(range(0, length - tile_size + 1, step))
    last = length - tile_size
    if starts[-1] != last:
        starts.append(last)
    return starts


def rectangle_iou(first: list[list[float]], second: list[list[float]]) -> float:
    ax1 = min(point[0] for point in first)
    ay1 = min(point[1] for point in first)
    ax2 = max(point[0] for point in first)
    ay2 = max(point[1] for point in first)
    bx1 = min(point[0] for point in second)
    by1 = min(point[1] for point in second)
    bx2 = max(point[0] for point in second)
    by2 = max(point[1] for point in second)
    intersection = max(0.0, min(ax2, bx2) - max(ax1, bx1)) * max(
        0.0, min(ay2, by2) - max(ay1, by1)
    )
    union = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    union += max(0.0, bx2 - bx1) * max(0.0, by2 - by1) - intersection
    return intersection / union if union else 0.0


def deduplicate_detections(detections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Supprime les doublons créés dans les zones de chevauchement des tuiles."""
    ordered = sorted(
        detections,
        key=lambda item: item["confidence"] if item["confidence"] is not None else -1.0,
        reverse=True,
    )
    kept: list[dict[str, Any]] = []
    for candidate in ordered:
        text_key = " ".join(candidate["text"].casefold().split())
        duplicate = any(
            text_key == " ".join(existing["text"].casefold().split())
            and candidate["bounding_box"]
            and existing["bounding_box"]
            and rectangle_iou(candidate["bounding_box"], existing["bounding_box"]) >= 0.25
            for existing in kept
        )
        if not duplicate:
            kept.append(candidate)
    return sorted(
        kept,
        key=lambda item: (
            item["page_number"],
            min(point[1] for point in item["bounding_box"]) if item["bounding_box"] else 0,
            min(point[0] for point in item["bounding_box"]) if item["bounding_box"] else 0,
        ),
    )


def infer_page(
    ocr: Any,
    image: Image.Image,
    page_number: int,
    threshold: float,
    tile_size: int,
    overlap: int,
    on_tile_started: Callable[[int, int], None] | None = None,
    on_tile_completed: Callable[[int, int], None] | None = None,
) -> tuple[list[dict[str, Any]], float, int]:
    if tile_size <= 0 or (image.width <= tile_size and image.height <= tile_size):
        if on_tile_started:
            on_tile_started(1, 1)
        started = time.perf_counter()
        raw_results = list(ocr.predict(np.asarray(image)))
        elapsed = time.perf_counter() - started
        if on_tile_completed:
            on_tile_completed(1, 1)
        detections: list[dict[str, Any]] = []
        for raw_result in raw_results:
            detections.extend(extract_detections(raw_result, page_number, threshold))
        return detections, elapsed, 1

    detections = []
    elapsed = 0.0
    x_starts = tile_starts(image.width, tile_size, overlap)
    y_starts = tile_starts(image.height, tile_size, overlap)
    tile_count = len(x_starts) * len(y_starts)
    current = 0
    for top in y_starts:
        for left in x_starts:
            current += 1
            right = min(left + tile_size, image.width)
            bottom = min(top + tile_size, image.height)
            LOG.info("Page %d, tuile %d/%d (%d,%d)-(%d,%d)", page_number, current, tile_count, left, top, right, bottom)
            if on_tile_started:
                on_tile_started(current, tile_count)
            tile = image.crop((left, top, right, bottom))
            started = time.perf_counter()
            raw_results = list(ocr.predict(np.asarray(tile)))
            elapsed += time.perf_counter() - started
            for raw_result in raw_results:
                tile_detections = extract_detections(raw_result, page_number, threshold)
                for item in tile_detections:
                    if item["bounding_box"]:
                        item["bounding_box"] = [
                            [point[0] + left, point[1] + top] for point in item["bounding_box"]
                        ]
                detections.extend(tile_detections)
            if on_tile_completed:
                on_tile_completed(current, tile_count)
    return deduplicate_detections(detections), elapsed, tile_count


def run(args: argparse.Namespace) -> int:
    input_path = args.input.expanduser().resolve()
    if not input_path.is_file():
        raise FileNotFoundError(f"Fichier d'entrée introuvable: {input_path}")
    if args.dpi < 72 or args.dpi > 1200:
        raise ValueError("--dpi doit être compris entre 72 et 1200.")
    if not 0.0 <= args.min_confidence <= 1.0:
        raise ValueError("--min-confidence doit être compris entre 0 et 1.")
    if args.det_limit_side_len < 64 or args.det_limit_side_len > 10000:
        raise ValueError("--det-limit-side-len doit être compris entre 64 et 10000.")
    if args.tile_size < 0:
        raise ValueError("--tile-size doit être positif ou nul.")
    if args.tile_size and args.tile_size < 256:
        raise ValueError("--tile-size doit être au moins 256 pixels.")
    if args.tile_overlap < 0 or (args.tile_size and args.tile_overlap >= args.tile_size):
        raise ValueError("--tile-overlap doit être positif et inférieur à --tile-size.")

    progress_file = args.progress_file.expanduser().resolve() if args.progress_file else None
    publish_progress(progress_file, message="Chargement du modele PaddleOCR sur CPU.")

    from paddleocr import PaddleOCR

    output_root = args.output_dir.expanduser().resolve() / input_path.stem
    pages_dir = output_root / "pages"
    annotated_dir = output_root / "annotated"
    pages_dir.mkdir(parents=True, exist_ok=True)
    annotated_dir.mkdir(parents=True, exist_ok=True)

    LOG.info("Chargement du modèle PaddleOCR (CPU)...")
    model_start = time.perf_counter()
    ocr = PaddleOCR(
        lang=args.lang,
        text_detection_model_name=args.det_model,
        text_recognition_model_name=args.rec_model,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        text_det_limit_side_len=args.det_limit_side_len,
        text_det_limit_type="max",
        device="cpu",
        # PaddlePaddle 3.3.1/Windows peut échouer sur certains graphes PIR oneDNN.
        enable_mkldnn=False,
    )
    model_load_seconds = time.perf_counter() - model_start

    pages = load_pages(input_path, args.dpi)
    all_detections: list[dict[str, Any]] = []
    page_summaries: list[dict[str, Any]] = []
    inference_total = 0.0

    for page_number, image in pages:
        page_path = pages_dir / f"page_{page_number:04d}.png"
        image.save(page_path)
        LOG.info("OCR page %d/%d (%dx%d)", page_number, len(pages), image.width, image.height)
        page_started = time.perf_counter()

        def on_tile_started(current: int, total: int) -> None:
            publish_progress(
                progress_file,
                message=(
                    f"Lecture OCR : page {page_number}/{len(pages)}, tuile {current}/{total} en cours. "
                    "Cette etape est volontairement realisee a qualite maximale sur CPU."
                ),
                page=page_number,
                page_count=len(pages),
                current_tile=current,
                total_tiles=total,
                completed_tiles=current - 1,
            )

        def on_tile_completed(current: int, total: int) -> None:
            elapsed_seconds = time.perf_counter() - page_started
            eta_seconds = round(elapsed_seconds / current * (total - current)) if current else None
            publish_progress(
                progress_file,
                message=(
                    f"Lecture OCR : page {page_number}/{len(pages)}, tuile {current}/{total} terminee. "
                    + (f"Estimation restante : environ {eta_seconds} s." if eta_seconds else "Finalisation de la page.")
                ),
                page=page_number,
                page_count=len(pages),
                current_tile=current,
                total_tiles=total,
                completed_tiles=current,
                eta_seconds=eta_seconds,
            )

        detections, elapsed, tile_count = infer_page(
            ocr,
            image,
            page_number,
            args.min_confidence,
            args.tile_size,
            args.tile_overlap,
            on_tile_started,
            on_tile_completed,
        )
        inference_total += elapsed
        all_detections.extend(detections)
        annotated_path = annotated_dir / f"page_{page_number:04d}_annotated.png"
        annotate(image, detections).save(annotated_path)
        page_summaries.append(
            {
                "page_number": page_number,
                "execution_time_seconds": round(elapsed, 6),
                "detected_text_count": len(detections),
                "tile_count": tile_count,
                "source_image": str(page_path),
                "annotated_image": str(annotated_path),
            }
        )

    confidences = [d["confidence"] for d in all_detections if d["confidence"] is not None]
    report = {
        "schema_version": "1.0",
        "model": "PaddleOCR",
        "text_detection_model": args.det_model,
        "text_recognition_model": args.rec_model,
        "input_file": str(input_path),
        "input_file_name": input_path.name,
        "dpi": args.dpi if input_path.suffix.lower() == ".pdf" else None,
        "text_detection_limit_side_len": args.det_limit_side_len,
        "tile_size": args.tile_size,
        "tile_overlap": args.tile_overlap if args.tile_size else None,
        "page_count": len(pages),
        "model_load_time_seconds": round(model_load_seconds, 6),
        "execution_time_seconds": round(inference_total, 6),
        "detected_text_count": len(all_detections),
        "average_confidence": round(sum(confidences) / len(confidences), 6) if confidences else None,
        "bounding_boxes_available": all(d["bounding_box"] is not None for d in all_detections),
        "pages": page_summaries,
        "detections": all_detections,
    }
    json_path = output_root / f"{input_path.stem}_paddleocr.json"
    txt_path = output_root / f"{input_path.stem}_paddleocr.txt"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    txt_lines = [
        f"[page {d['page_number']}] {d['text']}\t"
        f"confidence={d['confidence'] if d['confidence'] is not None else 'N/A'}"
        for d in all_detections
    ]
    txt_path.write_text("\n".join(txt_lines), encoding="utf-8")
    LOG.info("Terminé: %d textes en %.3f s", len(all_detections), inference_total)
    LOG.info("JSON: %s", json_path)
    LOG.info("TXT : %s", txt_path)
    return 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s - %(message)s")
    args = parse_args()
    try:
        return run(args)
    except KeyboardInterrupt:
        LOG.error("Exécution interrompue par l'utilisateur.")
        return 130
    except Exception as exc:
        LOG.error("%s", exc)
        LOG.debug("%s", traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
