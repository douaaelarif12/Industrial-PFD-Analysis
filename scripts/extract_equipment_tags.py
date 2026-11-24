"""Extract industrial equipment-tag candidates from a PaddleOCR JSON result.

This utility is intentionally read-only with respect to the source OCR JSON.  It
keeps the original OCR text, confidence and page-space polygon while adding a
minimal comparison-only normalization (uppercase and whitespace removal).
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path
from typing import Any


# Tolerant tag shape:
# - a four-character plant/unit prefix such as 230A;
# - two following alphanumeric groups;
# - separators may be absent or represented by up to two non-alphanumerics;
# - common OCR substitutions in the numeric prefix (O/I/L/S/B/Z/G) are allowed.
# Semantic correction is deliberately not performed.
TAG_LIKE_PATTERN = re.compile(
    r"(?<![A-Z0-9])"
    r"([0-9OILSBZG]{3}[A-Z0-9]"
    r"[^A-Z0-9]{0,2}[A-Z0-9]{1,4}"
    r"[^A-Z0-9]{0,2}[A-Z0-9]{1,5})"
    r"(?![A-Z0-9])"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extrait les candidats tags d'équipements depuis un JSON PaddleOCR."
    )
    parser.add_argument("input_json", type=Path, help="JSON PaddleOCR source")
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="JSON de candidats à créer",
    )
    return parser.parse_args()


def normalize_for_comparison(text: str) -> str:
    """Uppercase text and remove whitespace without correcting OCR characters."""

    normalized = unicodedata.normalize("NFKC", text).upper()
    return re.sub(r"\s+", "", normalized)


def looks_like_equipment_tag(normalized_text: str) -> bool:
    match = TAG_LIKE_PATTERN.search(normalized_text)
    if match is None:
        return False
    token = match.group(1)
    # Avoid accepting purely numeric table values while remaining tolerant of
    # one-character OCR errors in otherwise tag-like strings.
    digit_count = sum(character.isdigit() for character in token)
    letter_count = sum(character.isalpha() for character in token)
    return digit_count >= 3 and letter_count >= 2


def extract_candidates(payload: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for index, detection in enumerate(payload.get("detections", [])):
        original_text = str(detection.get("text", ""))
        normalized_text = normalize_for_comparison(original_text)
        if not looks_like_equipment_tag(normalized_text):
            continue
        candidates.append(
            {
                "text": original_text,
                "normalized_text": normalized_text,
                "confidence": detection.get("confidence"),
                "bbox": detection.get("bounding_box"),
                "page_number": detection.get("page_number"),
                "source_detection_index": index,
            }
        )

    # Highest-confidence candidates first; the source index preserves stable
    # ordering for equal or missing confidence values.
    candidates.sort(
        key=lambda item: (
            -(float(item["confidence"]) if item["confidence"] is not None else -1.0),
            item["source_detection_index"],
        )
    )
    return candidates


def main() -> int:
    args = parse_args()
    source_path = args.input_json.resolve()
    output_path = args.output.resolve()

    payload = json.loads(source_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("detections"), list):
        raise ValueError("Le JSON source ne contient pas de liste 'detections'.")

    candidates = extract_candidates(payload)
    result = {
        "schema_version": "1.0",
        "source_ocr_json": str(source_path),
        "source_input_file": payload.get("input_file"),
        "normalization": "Unicode NFKC, uppercase, whitespace removed; no OCR correction",
        "candidate_count": len(candidates),
        "candidates": candidates,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Candidats détectés: {len(candidates)}")
    print(f"JSON: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
