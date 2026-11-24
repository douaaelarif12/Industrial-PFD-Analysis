"""Create reviewable OCR-tag to YOLO-equipment associations for one PFD page.

The adapter makes no document-specific tag assumptions and never invents an
equipment tag.  Associations are spatial candidates only; ambiguous matches
remain explicitly marked for review.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
from pathlib import Path
from typing import Any


TAG_PATTERN = re.compile(r"(?<![A-Z0-9])(?:[0-9OILSBZG]{3}[A-Z0-9])[^A-Z0-9]{0,2}[A-Z0-9]{1,4}[^A-Z0-9]{0,2}[A-Z0-9]{1,5}(?![A-Z0-9])")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ocr_json", type=Path)
    parser.add_argument("detections_json", type=Path)
    parser.add_argument("--candidates-json", type=Path, help="Optional output from extract_equipment_tags.py; when set, its candidate list is authoritative")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-distance", type=float, default=140.0, help="Maximum tag-to-box edge distance in target page pixels")
    parser.add_argument("--ambiguity-margin", type=float, default=18.0, help="Mark equally close alternatives within this distance")
    return parser.parse_args()


def normalized(text: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text).upper())


def bbox_from_polygon(points: Any) -> list[float] | None:
    if not isinstance(points, list) or not points:
        return None
    try:
        xs, ys = zip(*((float(point[0]), float(point[1])) for point in points))
    except (TypeError, ValueError, IndexError):
        return None
    return [min(xs), min(ys), max(xs), max(ys)]


def distance_to_box(point: tuple[float, float], box: list[float]) -> float:
    x, y = point; x1, y1, x2, y2 = box
    return math.hypot(max(x1 - x, 0, x - x2), max(y1 - y, 0, y - y2))


def main() -> int:
    args = parse_args()
    ocr = json.loads(args.ocr_json.read_text(encoding="utf-8"))
    detector = json.loads(args.detections_json.read_text(encoding="utf-8"))
    candidates: list[dict[str, Any]] = []
    if args.candidates_json:
        candidate_payload = json.loads(args.candidates_json.read_text(encoding="utf-8"))
        for index, item in enumerate(candidate_payload.get("candidates", [])):
            bbox = bbox_from_polygon(item.get("bbox"))
            if bbox is None:
                continue
            text = str(item.get("text", ""))
            token = str(item.get("normalized_text") or normalized(text))
            source_index = int(item.get("source_detection_index", index))
            candidates.append({"candidate_id": f"ocr_tag_{source_index:04d}", "text": text, "normalized_text": token, "confidence": item.get("confidence"), "bbox": bbox})
    else:
        for index, item in enumerate(ocr.get("detections", [])):
            text = str(item.get("text", "")); token = normalized(text)
            if not TAG_PATTERN.search(token):
                continue
            bbox = bbox_from_polygon(item.get("bounding_box"))
            if bbox is None:
                continue
            candidates.append({"candidate_id": f"ocr_tag_{index:04d}", "text": text, "normalized_text": token, "confidence": item.get("confidence"), "bbox": bbox})
    associations: list[dict[str, Any]] = []
    used_detection_ids: set[str] = set()
    for candidate in candidates:
        x1, y1, x2, y2 = candidate["bbox"]
        center = ((x1 + x2) / 2, (y1 + y2) / 2)
        scored = sorted(((distance_to_box(center, detection["bbox"]), detection) for detection in detector.get("detections", [])), key=lambda item: item[0])
        valid = [(distance, detection) for distance, detection in scored if distance <= args.max_distance]
        if not valid:
            associations.append({**candidate, "status": "unmatched", "equipment": None, "alternatives": []})
            continue
        best_distance, best = valid[0]
        alternatives = [{"detection_id": item["id"], "distance_px": round(distance, 2)} for distance, item in valid[:3]]
        ambiguous = len(valid) > 1 and valid[1][0] - best_distance <= args.ambiguity_margin
        status = "to_review" if ambiguous or best["id"] in used_detection_ids else "candidate"
        used_detection_ids.add(best["id"])
        associations.append({**candidate, "status": status, "equipment": {"detection_id": best["id"], "class_id": best["class_id"], "class_name": best["class_name"], "bbox": best["bbox"], "distance_px": round(best_distance, 2)}, "alternatives": alternatives})
    result = {"schema_version": "1.0", "ocr_json": str(args.ocr_json.resolve()), "detections_json": str(args.detections_json.resolve()), "candidates_json": str(args.candidates_json.resolve()) if args.candidates_json else None, "rules": {"tag_normalization": "Unicode NFKC + uppercase + whitespace removal; no OCR correction", "max_distance_px": args.max_distance, "ambiguity_margin_px": args.ambiguity_margin}, "tag_candidate_count": len(candidates), "association_count": len(associations), "associations": associations}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Tag candidates: {len(candidates)}; associations: {len(associations)}; output: {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
