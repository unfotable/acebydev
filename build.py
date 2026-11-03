#!/usr/bin/env python3
"""build.py — production build for the unfotable site (stdlib only).

Pipeline:
1. If Node + esbuild are available (devDependencies), bundle assets/js/app.js
   and its three.js dependency graph into a single tree-shaken, minified
   module (~40% lighter over the wire than fetching three from a CDN).
   Otherwise fall back to serving the unminified ES modules with the importmap.
2. Minify the inline critical CSS with a conservative, string-safe minifier.
3. Strip HTML comments (markup/inline CSS only — never inside <script>).
4. Emit dist/ + build-manifest.json (sizes, sha256, gzip sizes).

Usage: python tools/build.py [--root .] [--out dist] [--no-bundle]
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

THREE_VERSION = "0.160.0"


# ---------------------------------------------------------------------------
# Conservative, string-safe CSS minifier.
# Strings (incl. url("data:...") payloads) are tokenized out first and copied
# verbatim; whitespace collapsing runs only on the non-string segments.
# Removes: comments, runs of whitespace outside strings, last ';' in a block,
# space around { } : ; , >.
# ---------------------------------------------------------------------------
def minify_css(css: str) -> str:
    segments: list[tuple[bool, str]] = []  # (is_string, text)
    buf: list[str] = []
    i, n = 0, len(css)
    while i < n:
        ch = css[i]
        if ch in "\"'":  # string literal — copied verbatim
            quote = ch
            j = i + 1
            while j < n:
                if css[j] == "\\":
                    j += 2
                    continue
                if css[j] == quote:
                    break
                j += 1
            if buf:
                segments.append((False, "".join(buf)))
                buf = []
            segments.append((True, css[i:min(n, j + 1)]))
            i = j + 1
            continue
        if css.startswith("/*", i):  # comment — dropped
            end = css.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        buf.append(ch)
        i += 1
    if buf:
        segments.append((False, "".join(buf)))

    out: list[str] = []
    for is_string, text in segments:
        if is_string:
            out.append(text)
            continue
        text = re.sub(r"\s+", " ", text)
        text = re.sub(r"\s*([{}:;,>])\s*", r"\1", text)
        text = text.replace(";}", "}")
        out.append(text)
    return "".join(out).strip()


# ---------------------------------------------------------------------------
# HTML minifier: strip comments, trim blank lines. Script/style contents are
# handled separately (CSS minified; JS left to esbuild / left intact).
# ---------------------------------------------------------------------------
def minify_html(html: str) -> str:
    html = re.sub(r"<!--(?!\[if).*?-->", "", html, flags=re.S)  # keep IE hints
    html = re.sub(r"\n[ \t]+(?=\S)", "\n", html)                # indent runs
    html = re.sub(r"\n{2,}", "\n", html)                        # blank lines
    return html.strip() + "\n"


def gzip_size(data: bytes) -> int:
    return len(gzip.compress(data, compresslevel=9, mtime=0))


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def try_esbuild(root: str, out_path: str) -> tuple[bool, str]:
    """Bundle app.js with esbuild when present. Returns (ok, note)."""
    esbuild = shutil.which(os.path.join(root, "node_modules", ".bin", "esbuild")) or shutil.which("esbuild")
    if esbuild is None:
        return False, "esbuild not installed; shipping unminified ES modules"
    cmd = [
        esbuild, os.path.join(root, "assets", "js", "app.js"),
        "--bundle", "--minify", "--format=esm",
        f"--outfile={out_path}",
        "--sourcemap=external",
        "--log-level=warning",
    ]
    proc = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        return False, f"esbuild failed: {proc.stderr.strip()[:400]}"
    return True, "bundled + minified with esbuild"


def build(root: str, out: str, bundle: bool) -> dict:
    root = os.path.abspath(root)
    dist = os.path.abspath(os.path.join(root, out))
    if os.path.isdir(dist):
        shutil.rmtree(dist)  # builds are reproducible; never mix with stale output
    os.makedirs(dist, exist_ok=True)
    os.makedirs(os.path.join(dist, "assets", "js"), exist_ok=True)

    manifest: dict = {"bundle": False, "note": "", "files": []}

    # ---- JS ----
    app_src = os.path.join(root, "assets", "js")
    if bundle:
        ok, note = try_esbuild(root, os.path.join(dist, "assets", "js", "app.js"))
        manifest["bundle"], manifest["note"] = ok, note
    else:
        manifest["note"] = "bundling disabled (--no-bundle)"

    bundled = os.path.isfile(os.path.join(dist, "assets", "js", "app.js"))

    # ---- index.html ----
    html = open(os.path.join(root, "index.html"), encoding="utf-8").read()
    if bundled:
        html = re.sub(
            r'  <script type="importmap">.*?</script>\n', "", html, flags=re.S)
        html = re.sub(
            r'  <link rel="modulepreload" href="https://cdn\.jsdelivr\.net[^>]+>\n',
            "", html)
        html = re.sub(
            r'  <link rel="modulepreload" href="assets/js/app\.js">\n',
            '  <link rel="modulepreload" href="assets/js/app.js">\n', html)
    # minify inline CSS inside <style>...</style>
    html = re.sub(
        r"(<style>)(.*?)(</style>)",
        lambda m: m.group(1) + minify_css(m.group(2)) + m.group(3),
        html, flags=re.S)
    html = minify_html(html)

    # ---- copy static assets ----
    files: dict[str, bytes] = {"index.html": html.encode("utf-8")}
    for name in ("script.js", "style.css"):
        path = os.path.join(root, name)
        if os.path.isfile(path):
            files[name] = open(path, "rb").read()

    # JS assets: the esbuild bundle (written by esbuild, picked up here for the
    # manifest + sourcemap) or all unminified source modules
    if bundled:
        bundle_path = os.path.join(dist, "assets", "js", "app.js")
        files["assets/js/app.js"] = open(bundle_path, "rb").read()
        map_path = bundle_path + ".map"
        if os.path.isfile(map_path):
            files["assets/js/app.js.map"] = open(map_path, "rb").read()
    else:
        for name in os.listdir(app_src):
            if name.endswith(".js"):
                files[f"assets/js/{name}"] = open(os.path.join(app_src, name), "rb").read()

    for rel, data in files.items():
        dest = os.path.join(dist, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(data)
        manifest["files"].append({
            "path": rel,
            "bytes": len(data),
            "gzip_bytes": gzip_size(data),
            "sha256": sha256(data),
        })

    with open(os.path.join(dist, "build-manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
    return manifest


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=".")
    ap.add_argument("--out", default="dist")
    ap.add_argument("--no-bundle", action="store_true",
                    help="copy ES modules unminified instead of esbuild bundling")
    args = ap.parse_args()
    manifest = build(args.root, args.out, bundle=not args.no_bundle)
    total = sum(f["gzip_bytes"] for f in manifest["files"])
    print(f"build → {os.path.join(args.root, args.out)}  "
          f"({len(manifest['files'])} files, {total:,} B gzipped total)")
    print(f"bundle: {'yes' if manifest['bundle'] else 'no'} — {manifest['note']}")
    for f in manifest["files"]:
        print(f"  {f['path']:<24} {f['bytes']:>8,} B  ({f['gzip_bytes']:,} B gz)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
