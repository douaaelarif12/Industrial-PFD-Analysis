"""Render a PDF to PNG pages without altering the source PDF.

The generic workflow uses 150-DPI pages for the trained YOLO detector and may
use the independently rendered 72-DPI OCR pages as the shared target frame.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import fitz


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input_pdf", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--dpi", type=int, default=150)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.input_pdf.is_file() or args.input_pdf.suffix.lower() != ".pdf":
        raise FileNotFoundError(args.input_pdf)
    if args.dpi <= 0:
        raise ValueError("dpi must be positive")
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    pages: list[dict[str, int | str]] = []
    matrix = fitz.Matrix(args.dpi / 72.0, args.dpi / 72.0)
    with fitz.open(args.input_pdf) as document:
        for index, page in enumerate(document, 1):
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            path = output_dir / f"page_{index:04d}.png"
            pixmap.save(path)
            pages.append({"page_number": index, "path": str(path), "width": pixmap.width, "height": pixmap.height})
    manifest = {"input_pdf": str(args.input_pdf.resolve()), "dpi": args.dpi, "page_count": len(pages), "pages": pages}
    (output_dir / "render_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Rendered {len(pages)} page(s) at {args.dpi} DPI into {output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
