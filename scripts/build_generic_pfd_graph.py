"""Conservative, reusable PFD connectivity graph from OCR/YOLO page outputs.

This is intentionally not a process-flow inference engine: every generated
relation has unknown direction and requires human validation.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np


def args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--page", type=Path, required=True)
    p.add_argument("--ocr", type=Path, required=True)
    p.add_argument("--yolo", type=Path, required=True)
    p.add_argument("--associations", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    return p.parse_args()


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def point_to_segment(point: tuple[float, float], segment: tuple[int, int, int, int]) -> float:
    px, py = point; x1, y1, x2, y2 = segment
    dx, dy = x2 - x1, y2 - y1
    scale = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy or 1)
    scale = max(0.0, min(1.0, scale))
    return math.hypot(px - (x1 + scale * dx), py - (y1 + scale * dy))


def main() -> None:
    a = args()
    image = cv2.imread(str(a.page), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise FileNotFoundError(a.page)
    h, w = image.shape
    ocr, yolo, association = load(a.ocr), load(a.yolo), load(a.associations)
    binary = cv2.threshold(image, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]

    # Text and symbol interiors are excluded before line extraction. The border
    # of an equipment box is deliberately retained for possible pipe ports.
    for item in ocr.get("detections", []):
        poly = item.get("bounding_box") or []
        if poly:
            xs, ys = zip(*poly); cv2.rectangle(binary, (max(0, int(min(xs))-3), max(0, int(min(ys))-3)), (min(w, int(max(xs))+3), min(h, int(max(ys))+3)), 255, -1)
    for item in yolo.get("detections", []):
        x1, y1, x2, y2 = map(int, item["bbox"])
        cv2.rectangle(binary, (x1 + 4, y1 + 4), (x2 - 4, y2 - 4), 255, -1)

    lines = cv2.HoughLinesP(255 - binary, 1, np.pi / 180, threshold=55, minLineLength=40, maxLineGap=12)
    segments: list[tuple[int, int, int, int]] = []
    for row in (np.asarray(lines).reshape(-1, 4) if lines is not None else []):
        x1, y1, x2, y2 = map(int, row)
        if abs(y2-y1) <= 3 or abs(x2-x1) <= 3:
            segments.append((x1, y1, x2, y2))

    # Only tags with a one-to-one candidate association become graph nodes.
    by_detection = {item["id"]: item for item in yolo.get("detections", [])}
    nodes = []
    for record in association.get("associations", []):
        equipment = record.get("equipment") or {}
        if record.get("status") != "candidate" or equipment.get("detection_id") not in by_detection:
            continue
        nodes.append({"id": equipment["detection_id"], "tag": record["text"], "class_name": equipment["class_name"], "bbox": by_detection[equipment["detection_id"]]["bbox"], "requires_validation": True})
    nodes = list({node["id"]: node for node in nodes}.values())

    # Attach a symbol only when a detected process segment reaches its box.
    attached: dict[int, list[str]] = defaultdict(list)
    for node in nodes:
        x1, y1, x2, y2 = node["bbox"]
        ports = [(x1,(y1+y2)/2),(x2,(y1+y2)/2),((x1+x2)/2,y1),((x1+x2)/2,y2)]
        for index, segment in enumerate(segments):
            if min(point_to_segment(port, segment) for port in ports) <= 10:
                attached[index].append(node["id"])
    edges = []
    for segment_index, ids in attached.items():
        unique = sorted(set(ids))
        if len(unique) == 2:
            edges.append({"connection_id": f"candidate_{len(edges)+1:03d}", "source": unique[0], "target": unique[1], "direction": "unknown", "confidence_level": "LOW", "requires_validation": True, "evidence_segment": segment_index})
    result = {"schema_version": "generic_pfd_graph_v1", "coordinate_system": {"width": w, "height": h}, "limitations": ["Hough-derived candidate geometry only", "no process direction inferred", "all edges require validation"], "nodes": nodes, "edges": edges, "statistics": {"line_segments": len(segments), "equipment_nodes": len(nodes), "candidate_connections": len(edges)}}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Generic graph: {len(nodes)} nodes, {len(edges)} candidate connections")


if __name__ == "__main__":
    main()
