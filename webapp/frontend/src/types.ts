export type Equipment = {
  equipment_id: string; tag: string; class: string; bbox: number[];
  detection: { confidence: number; detection_id: string };
  ocr: { confidence: number; text: string; bbox: number[] };
  ports: Array<{ port_id: string; topology_node_id: string; side: string; geometry_confidence: number }>;
  connectivity_status: { connected_to_equipment_graph: boolean; relation_count: number };
}
export type Connection = {
  connection_id: string; equipment_a: string; equipment_b: string; direction: 'unknown';
  confidence: number; confidence_level: 'MEDIUM'; requires_validation: true;
  path: { path_length_px: number; node_ids: string[]; edge_ids: string[]; segment_ids: string[] };
}
export type FlowArrow = { arrow_id: string; orientation: 'right' | 'left' | 'up' | 'down'; position: { x: number; y: number }; confidence: number; nearest_segment_id: string; nearest_edge_id: string }
export type Summary = {
  document: { document_id: string; filename: string; image_width: number; image_height: number };
  equipment: number; physical_arrows: number; process_connections: number; ocr_text_regions: number; ocr_mean_confidence: number;
  geometry_ports: number; connected_equipment: number; isolated_equipment: number; unknown_edge_directions: number; unresolved_crossings: number; unassociated_yolo_detection: string; pipeline: string[];
}
export type Graph = { nodes: Array<{ id: string; tag: string; class: string; connectivity_status: Equipment['connectivity_status']; port_count: number }>; edges: Array<{ id: string; source: string; target: string; direction: 'unknown'; confidence: number; confidence_level: 'MEDIUM'; requires_validation: true; path_length_px: number }> }
