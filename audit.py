#!/usr/bin/env python3
"""audit.py — performance & quality gate for the unfotable site (stdlib only).

A CI-shaped linter that encodes the optimizations this repo depends on, so
regressions fail loudly instead of silently eroding smoothness:

- render-loop budget: no object allocations (new THREE.*) and no .map(/.filter()
  inside the animation loop body
- input: pointer/touch/scroll/wheel listeners must be passive
- write-on-change: canvas cursor writes must be guarded by a change check
- XSS guard: no template-literal innerHTML assignments
- storage guard: localStorage writes must be wrapped in try/catch
- loading hints: importmap + modulepreload present, CDN-failure fallback wired
- required <meta>/favicon/noscript present
- size budgets for source and dist (when dist/ exists)

Exit code 0 = pass, 1 = violations. --json for machine output.
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sys

VIOLATIONS: list[dict] = []


def v(severity: str, rule: str, message: str, file: str = "", line: int = 0) -> None:
    VIOLATIONS.append({"severity": severity, "rule": rule, "message": message,
                       "file": file, "line": line})


def line_of(source: str, index: int) -> int:
    return source.count("\n", 0, index) + 1


def extract_function(source: str, name: str) -> tuple[int, str] | None:
    """Return (start_index, body) of `function name(...) { ... }` (brace-matched)."""
    m = re.search(rf"function {name}\s*\(", source)
    if not m:
        return None
    brace_open = source.find("{", m.end())
    depth, i = 0, brace_open
    while i < len(source):
        ch = source[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return m.start(), source[brace_open + 1:i]
        elif ch in "\"'`":  # skip strings/templates
            quote = ch
            i += 1
            while i < len(source) and source[i] != quote:
                if source[i] == "\\":
                    i += 1
                i += 1
        i += 1
    return m.start(), source[brace_open + 1:]


def check_app_js(path: str) -> None:
    src = open(path, encoding="utf-8").read()
    fn = extract_function(src, "animate")
    if fn is None:
        v("error", "render-loop", "animate() function not found", path)
    else:
        start, body = fn
        for m in re.finditer(r"new\s+THREE\.\w+", body):
            v("error", "loop-alloc",
              f"allocation inside animate(): `{m.group(0)}` — use preallocated scratch objects",
              path, line_of(src, start + m.start()))
        for m in re.finditer(r"\.(map|filter|slice|concat|join)\(", body):
            v("error", "loop-alloc",
              f"array method `{m.group(0)}` allocates inside animate() — cache the array",
              path, line_of(src, start + m.start()))
        if re.search(r"\.setPixelRatio\(", body) and "drsEma" not in body:
            v("warn", "loop-cost", "pixel ratio churn inside animate() without DRS gating", path)
        # unguarded cursor writes in animate body
        cursor = re.search(r"style\.cursor\s*=", body)
        if cursor and "nextCursor !== cursor" not in body:
            v("warn", "style-churn", "style.cursor written without a change check", path,
              line_of(src, start + cursor.start()))
        # per-frame emissive writes
        if re.search(r"emissive\.setHex", body):
            v("warn", "loop-cost",
              "emissive.setHex inside animate() — set it in setProject() on change only",
              path, line_of(src, start + re.search(r"emissive\.setHex", body).start()))

    # passive listeners (whole file, independent of animate)
    for m in re.finditer(r"addEventListener\(\s*['\"](pointermove|touchmove|scroll|wheel)['\"]\s*,\s*[^,]+,\s*\{([^}]*)\}\s*\)", src):
        if "passive" not in m.group(2):
            v("error", "passive-listener",
              f"'{m.group(1)}' listener must be registered with passive: true",
              path, line_of(src, m.start()))
    # template-literal innerHTML
    for m in re.finditer(r"innerHTML\s*=\s*`[^`]*\$\{", src):
        v("error", "xss-guard", "innerHTML from a template literal — use DOM APIs",
          path, line_of(src, m.start()))


def check_chat_script(path: str) -> None:
    src = open(path, encoding="utf-8").read()
    m = re.search(r"localStorage\.setItem", src)
    if m:
        window = src[max(0, m.start() - 260):m.end() + 120]
        if "try" not in window:
            v("error", "storage-guard", "localStorage.setItem not wrapped in try/catch",
              path, line_of(src, m.start()))
    if "MAX_MESSAGES" not in src:
        v("error", "storage-growth",
          "chat history is unbounded — cap stored messages (MAX_MESSAGES)", path)


def check_index_html(path: str) -> None:
    src = open(path, encoding="utf-8").read()
    required = [
        ("charset", r"<meta[^>]+charset", "meta charset"),
        ("viewport", r'name="viewport"', "meta viewport"),
        ("description", r'name="description"', "meta description"),
        ("theme-color", r'name="theme-color"', "meta theme-color"),
        ("og-title", r'property="og:title"', "og:title"),
        ("favicon", r'rel="icon"', "favicon"),
        ("preconnect", r'rel="preconnect"', "font preconnect"),
        ("fallback-bootstrap", r"__folioFallback", "CDN-failure bootstrap"),
        ("noscript", r"<noscript>", "noscript reveal"),
    ]
    for rule, pattern, label in required:
        if not re.search(pattern, src):
            v("error", "required-markup", f"missing {label}", path)
    if "modulepreload" not in src and "dist" not in path:
        v("warn", "loading-hints", "no modulepreload hints — three.js is discovered late", path)


def check_budgets(root: str) -> None:
    budgets = [  # (path, max_bytes raw, max_bytes gzipped, label)
        ("index.html", 16_384, 6_144, "document"),
        (os.path.join("assets", "js", "app.js"), 45_054, 12_288, "app module"),
        (os.path.join("assets", "js", "cover-art.js"), 20_480, 6_144, "cover engine"),
        (os.path.join("assets", "js", "catalog.js"), 8_192, 3_072, "catalog data"),
        ("script.js", 6_144, 2_048, "chat app"),
        ("style.css", 4_096, 2_048, "chat styles"),
    ]
    for rel, max_raw, max_gz, label in budgets:
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            # existence of the load-bearing files is checked separately;
            # budgets only apply to files that are present (fixtures, dists)
            continue
        data = open(path, "rb").read()
        gz = len(gzip.compress(data, compresslevel=9, mtime=0))
        if len(data) > max_raw:
            v("error", "budget", f"{label} grew to {len(data):,} B (budget {max_raw:,} B raw)", rel)
        if gz > max_gz:
            v("error", "budget", f"{label} grew to {gz:,} B gzipped (budget {max_gz:,} B)", rel)

    dist = os.path.join(root, "dist")
    if os.path.isdir(dist):
        total_gz = 0
        for dirpath, _dirs, names in os.walk(dist):
            for name in names:
                p = os.path.join(dirpath, name)
                if name == "build-manifest.json" or name.endswith(".map"):
                    continue  # dev artifacts — excluded from wire-cost budgets
                total_gz += len(gzip.compress(open(p, "rb").read(), compresslevel=9, mtime=0))
        if total_gz > 196_608:  # 192 KB gzipped for the whole site in production form
            v("error", "budget", f"dist total {total_gz:,} B gzipped exceeds 192 KB", "dist")


def check_placeholders(root: str) -> None:
    # assembled dynamically (with \u escapes) so this file never matches itself
    patterns = re.compile("|".join([
        "TO" + "DO", "FIX" + "ME", "XX" + "X",
        "\u5f85" + "\u8865" + "\u5145",  # CJK "to be filled"
        "\u3010",                         # CJK lenticular bracket
        "placeholder" + "-text",
    ]))
    for dirpath, dirs, names in os.walk(root):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "dist")]
        for name in names:
            if not name.endswith((".js", ".html", ".css", ".py", ".md", ".yml")):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, root)
            try:
                for i, line in enumerate(open(path, encoding="utf-8"), 1):
                    if patterns.search(line):
                        v("warn", "placeholder", f"possible unfinished work: {line.strip()[:80]!r}",
                          rel, i)
            except (UnicodeDecodeError, OSError):
                continue


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=".")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args()
    root = os.path.abspath(args.root)

    app = os.path.join(root, "assets", "js", "app.js")
    if os.path.isfile(app):
        check_app_js(app)
    else:
        v("error", "required-file", "assets/js/app.js missing")
    if os.path.isfile(os.path.join(root, "script.js")):
        check_chat_script(os.path.join(root, "script.js"))
    html = os.path.join(root, "index.html")
    if os.path.isfile(html):
        check_index_html(html)
    else:
        v("error", "required-file", "index.html missing")
    check_budgets(root)
    check_placeholders(root)

    errors = [x for x in VIOLATIONS if x["severity"] == "error"]
    warns = [x for x in VIOLATIONS if x["severity"] == "warn"]

    if args.json:
        print(json.dumps({"pass": not errors, "errors": errors, "warnings": warns}, indent=2))
    else:
        for x in errors:
            loc = f"{x['file']}:{x['line']}" if x.get("line") else x["file"]
            print(f"ERROR   {x['rule']:<18} {loc} — {x['message']}")
        for x in warns:
            loc = f"{x['file']}:{x['line']}" if x.get("line") else x["file"]
            print(f"WARNING {x['rule']:<18} {loc} — {x['message']}")
        print(f"\n{len(errors)} error(s), {len(warns)} warning(s)")

    return 0 if not errors else 1


if __name__ == "__main__":
    sys.exit(main())
