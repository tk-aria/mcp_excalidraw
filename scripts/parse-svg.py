#!/usr/bin/env python3
"""parse-svg.py — Excalidraw SVGから構造化JSONを抽出する

Usage:
    python3 parse-svg.py < canvas.svg
    python3 parse-svg.py canvas.svg
    curl ... | python3 parse-svg.py --from-api

Output: JSON with elements, texts, images, connections, and summary.
"""

import json
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter


def parse_svg(svg_content: str) -> dict:
    # Excalidraw SVG uses namespaces
    ns = {
        "svg": "http://www.w3.org/2000/svg",
        "xlink": "http://www.w3.org/1999/xlink",
    }

    try:
        root = ET.fromstring(svg_content)
    except ET.ParseError as e:
        return {"error": f"SVG parse error: {e}"}

    viewbox = root.get("viewBox", "")
    width = root.get("width", "")
    height = root.get("height", "")

    texts = []
    shapes = []
    images = []
    paths = []
    lines = []

    def strip_ns(tag: str) -> str:
        return tag.split("}")[-1] if "}" in tag else tag

    def extract_transform(el) -> dict:
        t = el.get("transform", "")
        result = {}
        m = re.search(r"translate\(([-\d.]+)[,\s]+([-\d.]+)\)", t)
        if m:
            result["translate"] = [float(m.group(1)), float(m.group(2))]
        m = re.search(r"rotate\(([-\d.]+)", t)
        if m:
            result["rotate"] = float(m.group(1))
        return result

    def walk(el, depth=0):
        tag = strip_ns(el.tag)

        if tag == "text":
            text_content = "".join(el.itertext()).strip()
            if text_content:
                entry = {
                    "type": "text",
                    "content": text_content,
                }
                x, y = el.get("x"), el.get("y")
                if x is not None:
                    entry["x"] = float(x)
                if y is not None:
                    entry["y"] = float(y)
                font_size = el.get("font-size")
                if font_size:
                    entry["fontSize"] = font_size
                direction = el.get("direction")
                if direction:
                    entry["direction"] = direction
                transform = extract_transform(el)
                if transform:
                    entry["transform"] = transform
                texts.append(entry)

        elif tag == "rect":
            entry = {
                "type": "rect",
                "x": float(el.get("x", 0)),
                "y": float(el.get("y", 0)),
                "width": float(el.get("width", 0)),
                "height": float(el.get("height", 0)),
            }
            stroke = el.get("stroke")
            fill = el.get("fill")
            if stroke and stroke != "none":
                entry["stroke"] = stroke
            if fill and fill != "none":
                entry["fill"] = fill
            transform = extract_transform(el)
            if transform:
                entry["transform"] = transform
            shapes.append(entry)

        elif tag == "ellipse":
            entry = {
                "type": "ellipse",
                "cx": float(el.get("cx", 0)),
                "cy": float(el.get("cy", 0)),
                "rx": float(el.get("rx", 0)),
                "ry": float(el.get("ry", 0)),
            }
            stroke = el.get("stroke")
            if stroke:
                entry["stroke"] = stroke
            shapes.append(entry)

        elif tag == "path":
            entry = {
                "type": "path",
                "d": (el.get("d") or "")[:100],  # truncate long paths
            }
            stroke = el.get("stroke")
            fill = el.get("fill")
            if stroke and stroke != "none":
                entry["stroke"] = stroke
            if fill and fill != "none":
                entry["fill"] = fill
            marker_end = el.get("marker-end")
            if marker_end:
                entry["hasArrowhead"] = True
            paths.append(entry)

        elif tag == "line":
            entry = {
                "type": "line",
                "x1": float(el.get("x1", 0)),
                "y1": float(el.get("y1", 0)),
                "x2": float(el.get("x2", 0)),
                "y2": float(el.get("y2", 0)),
            }
            lines.append(entry)

        elif tag == "image":
            href = el.get("href") or el.get(f"{{{ns['xlink']}}}href", "")
            entry = {
                "type": "image",
                "width": el.get("width", ""),
                "height": el.get("height", ""),
            }
            if href.startswith("data:"):
                mime = href.split(";")[0].split(":")[1] if ";" in href else "unknown"
                data_len = len(href) - href.index(",") - 1 if "," in href else 0
                entry["mimeType"] = mime
                entry["dataSize"] = data_len
            else:
                entry["href"] = href[:200]
            transform = extract_transform(el)
            if transform:
                entry["transform"] = transform
            images.append(entry)

        elif tag == "use":
            href = el.get("href") or el.get(f"{{{ns['xlink']}}}href", "")
            if href:
                entry = {
                    "type": "use",
                    "href": href,
                    "width": el.get("width", ""),
                    "height": el.get("height", ""),
                }
                transform = extract_transform(el)
                if transform:
                    entry["transform"] = transform
                images.append(entry)

        for child in el:
            walk(child, depth + 1)

    walk(root)

    # Detect arrows (paths with arrowhead markers)
    arrows = [p for p in paths if p.get("hasArrowhead")]

    # Build connections by finding arrows near text/shapes
    # (simplified heuristic: group texts near shapes by proximity)

    type_counts = Counter()
    for t in texts:
        type_counts["text"] += 1
    for s in shapes:
        type_counts[s["type"]] += 1
    for p in paths:
        type_counts["path"] += 1
    for ln in lines:
        type_counts["line"] += 1
    for img in images:
        type_counts["image"] += 1

    result = {
        "canvas": {
            "viewBox": viewbox,
            "width": width,
            "height": height,
        },
        "summary": {
            "totalElements": sum(type_counts.values()),
            "typeCounts": dict(type_counts),
            "textCount": len(texts),
            "shapeCount": len(shapes),
            "pathCount": len(paths),
            "arrowCount": len(arrows),
            "imageCount": len(images),
        },
        "texts": texts,
        "shapes": shapes,
        "images": [
            {k: v for k, v in img.items() if k != "dataSize" or v > 0}
            for img in images
        ],
        "arrows": arrows,
    }

    return result


def main():
    from_api = "--from-api" in sys.argv

    if from_api:
        # Read JSON API response from stdin
        data = json.load(sys.stdin)
        if data.get("success") and data.get("data"):
            svg_content = data["data"]
        else:
            print(json.dumps({"error": "API response has no data"}))
            sys.exit(1)
    elif len(sys.argv) > 1 and not sys.argv[1].startswith("-"):
        with open(sys.argv[1]) as f:
            svg_content = f.read()
    else:
        svg_content = sys.stdin.read()

    result = parse_svg(svg_content)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
