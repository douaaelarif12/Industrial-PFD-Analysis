"""Run the validated six-class YOLO checkpoint on an arbitrary rendered PFD page.

This is a new, isolated adapter.  It does not alter the historical PFD-230
inference script or any validated Stage 01--08 artifact.  The source page must
be rendered at 150 DPI, matching the detector's JESA training preparation; a
target page (normally PaddleOCR's 72-DPI render) can be supplied to export all
detections into the common OCR coordinate frame.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image
from ultralytics import YOLO


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = PROJECT_ROOT / "artifacts" / "jesa_yolo11s_v3s" / "weights" / "best_v3.pt"
CLASS_NAMES = {
    0: "pump",
    1: "pump_box",
    2: "cyclone_cluster",
    3: "sampler",
    4: "tank",
    5: "process_cell",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_page", type=Path, help="PFD page rendered at 150 DPI")
    parser.add_argument("--target-page", type=Path, help="Optional OCR page for common-coordinate export")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--tile-size", type=int, default=1280)
    parser.add_argument("--tile-overlap", type=int, default=256)
    parser.add_argument("--imgsz", type=int, default=1024)
    parser.add_argument("--conf", type=float, default=0.25)
    parser.add_argument("--iou", type=float, default=0.60)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--save-tiles", action="store_true", help="Persist inference tiles for traceability")
    return parser.parse_args()


def positions(length: int, tile_size: int, overlap: int) -> list[int]:
    if length <= tile_size:
        return [0]
    stride = tile_size - overlap
    starts = list(range(0, length - tile_size + 1, stride))
    final = length - tile_size
    if starts[-1] != final:
        starts.append(final)
    return starts


def iou(one: list[float], many: np.ndarray) -> np.ndarray:
    if many.size == 0:
        return np.empty((0,), dtype=float)
    x1 = np.maximum(one[0], many[:, 0]); y1 = np.maximum(one[1], many[:, 1])
    x2 = np.minimum(one[2], many[:, 2]); y2 = np.minimum(one[3], many[:, 3])
    intersection = np.maximum(0, x2 - x1) * np.maximum(0, y2 - y1)
    area_one = max(0, one[2] - one[0]) * max(0, one[3] - one[1])
    area_many = np.maximum(0, many[:, 2] - many[:, 0]) * np.maximum(0, many[:, 3] - many[:, 1])
    union = area_one + area_many - intersection
    return np.divide(intersection, union, out=np.zeros_like(intersection), where=union > 0)


def class_aware_nms(items: list[dict], threshold: float) -> list[dict]:
    kept: list[dict] = []
    for class_id in CLASS_NAMES:
        candidates = sorted((item for item in items if item["class_id"] == class_id), key=lambda item: item["confidence"], reverse=True)
        while candidates:
            best = candidates.pop(0)
            kept.append(best)
            boxes = np.asarray([candidate["bbox_source"] for candidate in candidates], dtype=float)
            overlaps = iou(best["bbox_source"], boxes)
            candidates = [candidate for candidate, overlap in zip(candidates, overlaps) if overlap <= threshold]
    return sorted(kept, key=lambda item: (item["class_id"], -item["confidence"], item["bbox_source"][1], item["bbox_source"][0]))


def main() -> int:
    args = parse_args()
    if not args.source_page.is_file() or not args.model.is_file():
        missing = args.source_page if not args.source_page.is_file() else args.model
        raise FileNotFoundError(missing)
    if args.tile_size <= 0 or not 0 <= args.tile_overlap < args.tile_size:
        raise ValueError("tile-size must be positive and tile-overlap must be in [0, tile-size).")

    output_dir = args.output_dir.resolve()
    tile_dir = output_dir / "tiles"
    output_dir.mkdir(parents=True, exist_ok=True)
    page = Image.open(args.source_page).convert("RGB")
    source_width, source_height = page.size
    target_width, target_height = source_width, source_height
    if args.target_page:
        with Image.open(args.target_page) as target:
            target_width, target_height = target.size
    scale_x, scale_y = target_width / source_width, target_height / source_height

    model = YOLO(str(args.model), verbose=False)
    actual_names = {int(key): value for key, value in model.names.items()}
    if actual_names != CLASS_NAMES:
        raise RuntimeError(f"Unexpected checkpoint classes: {actual_names}")

    raw: list[dict] = []
    index = 0
    for y0 in positions(source_height, args.tile_size, args.tile_overlap):
        for x0 in positions(source_width, args.tile_size, args.tile_overlap):
            index += 1
            tile = page.crop((x0, y0, min(x0 + args.tile_size, source_width), min(y0 + args.tile_size, source_height)))
            tile_path = tile_dir / f"tile_{index:04d}.png"
            if args.save_tiles:
                tile_dir.mkdir(parents=True, exist_ok=True)
                tile.save(tile_path)
            result = model.predict(source=np.asarray(tile), conf=args.conf, iou=args.iou, imgsz=args.imgsz, device=args.device, verbose=False)[0]
            if result.boxes is None:
                continue
            for xyxy, class_id, confidence in zip(result.boxes.xyxy.cpu().numpy(), result.boxes.cls.cpu().numpy().astype(int), result.boxes.conf.cpu().numpy()):
                x1, y1, x2, y2 = (float(value) for value in xyxy)
                raw.append({
                    "class_id": int(class_id), "class_name": CLASS_NAMES[int(class_id)], "confidence": float(confidence),
                    "bbox_source": [max(0.0, x1 + x0), max(0.0, y1 + y0), min(float(source_width), x2 + x0), min(float(source_height), y2 + y0)],
                    "tile_index": index, "tile_offset": [x0, y0],
                })
    merged = class_aware_nms(raw, args.iou)
    detections = [{
        "id": f"det_{index:04d}", "class_id": item["class_id"], "class_name": item["class_name"], "confidence": round(item["confidence"], 8),
        "bbox": [round(item["bbox_source"][0] * scale_x, 3), round(item["bbox_source"][1] * scale_y, 3), round(item["bbox_source"][2] * scale_x, 3), round(item["bbox_source"][3] * scale_y, 3)],
    } for index, item in enumerate(merged, 1)]
    counts = Counter(item["class_name"] for item in detections)
    payload = {
        "schema_version": "1.0", "model": str(args.model.resolve()), "source_page": str(args.source_page.resolve()),
        "inference": {"source_dpi": 150, "tile_size_px": args.tile_size, "tile_overlap_px": args.tile_overlap, "tile_count": index, "imgsz": args.imgsz, "confidence_threshold": args.conf, "global_nms_iou": args.iou, "raw_tile_detection_count": len(raw), "final_detection_count": len(detections)},
        "coordinate_transform": {"source_yolo_dimensions": [source_width, source_height], "target_ocr_dimensions": [target_width, target_height], "scale_x": scale_x, "scale_y": scale_y, "target_coordinate_system": "global page pixels; top-left origin; x right; y down"},
        "class_counts": {name: counts.get(name, 0) for name in CLASS_NAMES.values()}, "detections": detections,
    }
    result_path = output_dir / "detections.json"
    result_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Tiles: {index}; raw: {len(raw)}; final: {len(detections)}")
    print(f"Output: {result_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
