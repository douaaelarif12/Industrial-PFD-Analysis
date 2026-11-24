"""Read-only access to the frozen Stage 07 structured PFD output."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[3]
FINAL_JSON = PROJECT_ROOT / "results" / "final_structured_pfd230_20260901" / "pfd230_final.json"


@lru_cache(maxsize=1)
def load_demo() -> dict[str, Any]:
    """Load the final JSON without writing to any pipeline artifact."""
    with FINAL_JSON.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def equipment_by_tag(tag: str) -> dict[str, Any] | None:
    return next((item for item in load_demo()["equipment"] if item["tag"] == tag), None)


def graph_payload() -> dict[str, Any]:
    data = load_demo()
    return {
        "nodes": [
            {
                "id": item["tag"],
                "tag": item["tag"],
                "class": item["class"],
                "connectivity_status": item["connectivity_status"],
                "port_count": len(item.get("ports", [])),
            }
            for item in data["equipment"]
        ],
        "edges": [
            {
                "id": item["connection_id"],
                "source": item["equipment_a"],
                "target": item["equipment_b"],
                "direction": "unknown",
                "confidence": item["confidence"],
                "confidence_level": item["confidence_level"],
                "requires_validation": item["requires_validation"],
                "path_length_px": item["path"]["path_length_px"],
            }
            for item in data["process_connections"]
        ],
    }


def summary_payload() -> dict[str, Any]:
    data = load_demo()
    summary = data["processing_summary"]
    unresolved = data["unresolved_items"]
    return {
        "document": data["document"],
        "equipment": len(data["equipment"]),
        "physical_arrows": len(data["flow_arrows"]),
        "process_connections": len(data["process_connections"]),
        "ocr_text_regions": summary["ocr"]["texts_detected"],
        "ocr_mean_confidence": summary["ocr"]["mean_confidence"],
        "geometry_ports": summary["stage04_attachment"]["geometry_ports"],
        "connected_equipment": summary["stage06_equipment_graph"]["connected_equipment"],
        "isolated_equipment": summary["stage06_equipment_graph"]["isolated_equipment"],
        "unknown_edge_directions": unresolved["unknown_topology_directions"],
        "unresolved_crossings": unresolved["crossing_candidates"]["count"],
        "unassociated_yolo_detection": "det_0008",
        "pipeline": [
            "PDF Input", "Equipment Detection", "OCR / Tag Extraction", "Line Extraction",
            "Topology Construction", "Equipment Attachment", "Flow Arrow Detection",
            "Process Connectivity", "Structured JSON", "Graph Export",
        ],
    }
