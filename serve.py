#!/usr/bin/env python3
"""serve.py — zero-dependency development server for the unfotable site.

Asynchronous (asyncio) instead of the stdlib blocking http.server, so
concurrent asset requests never block each other while you edit. Provides the
things a static host (GitHub Pages) gives you, locally:

- gzip negotiation (what most of the wire cost actually looks like)
- ETag / If-None-Match revalidation (304s)
- correct MIME types + charset
- cache headers that mirror the production pattern (HTML: revalidate,
  assets: short TTL)

Usage: python tools/serve.py [--port 8000] [--root .] [--no-gzip]
"""
from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import os
import sys

MEDIA_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json; charset=utf-8",
}

GZIP_MIN_SIZE = 860  # bytes; below this gzip is counterproductive
CACHE_HEADERS = {
    ".html": "no-cache",
    ".js": "public, max-age=3600",
    ".css": "public, max-age=3600",
    ".svg": "public, max-age=86400",
    ".png": "public, max-age=86400",
}

STATUS_TEXT = {200: "OK", 304: "Not Modified", 404: "Not Found", 405: "Method Not Allowed"}


def gzip_compress(data: bytes) -> bytes:
    return gzip.compress(data, compresslevel=6, mtime=0)


class StaticFile:
    """A loaded file plus derived caching metadata (built once, served many)."""

    __slots__ = ("body", "gzip_body", "etag", "media_type", "cache_control")

    def __init__(self, body: bytes, ext: str):
        self.body = body
        self.etag = hashlib.sha256(body).hexdigest()[:16]
        self.media_type = MEDIA_TYPES.get(ext, "application/octet-stream")
        self.cache_control = CACHE_HEADERS.get(ext, "no-cache")
        compressible = ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2")
        self.gzip_body = gzip_compress(body) if compressible and len(body) >= GZIP_MIN_SIZE else None


class Site:
    """Serves static files from a root directory; re-reads a file when its mtime changes."""

    def __init__(self, root: str):
        self.root = os.path.abspath(root)
        self._cache: dict[str, tuple[float, StaticFile]] = {}

    def resolve(self, url_path: str) -> str | None:
        rel = url_path.lstrip("/") or "index.html"
        path = os.path.normpath(os.path.join(self.root, rel))
        if not path.startswith(self.root + os.sep) and path != self.root:
            return None  # path traversal attempt
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        return path if os.path.isfile(path) else None

    def get(self, url_path: str) -> StaticFile | None:
        path = self.resolve(url_path)
        if path is None:
            return None
        try:
            mtime = os.path.getmtime(path)
            cached = self._cache.get(path)
            if cached and cached[0] == mtime:
                return cached[1]
            with open(path, "rb") as fh:
                body = fh.read()
        except OSError:
            return None
        entry = StaticFile(body, os.path.splitext(path)[1].lower())
        self._cache[path] = (mtime, entry)
        return entry


async def parse_headers(reader: asyncio.StreamReader) -> dict[str, str]:
    headers: dict[str, str] = {}
    while True:
        line = await reader.readline()
        if line in (b"\r\n", b"\n", b""):
            break
        name, _, value = line.decode("latin-1").partition(":")
        headers[name.strip().lower()] = value.strip()
    return headers


async def send_response(writer: asyncio.StreamWriter, status: int, headers: list[tuple[str, str]], body: bytes) -> None:
    head = [f"HTTP/1.1 {status} {STATUS_TEXT.get(status, 'OK')}"]
    for name, value in headers:
        head.append(f"{name}: {value}")
    head.append(f"Content-Length: {len(body)}")
    head.append("Connection: close")
    writer.write("\r\n".join(head).encode("latin-1") + b"\r\n\r\n" + body)
    await writer.drain()


async def handle_request(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, site: Site, gzip_on: bool) -> None:
    try:
        request_line = await asyncio.wait_for(reader.readline(), timeout=10)
        if not request_line:
            return
        parts = request_line.decode("latin-1").split()
        if len(parts) < 2:
            return
        method, target = parts[0].upper(), parts[1]
        path = target.split("?", 1)[0].split("#", 1)[0]
        headers = await parse_headers(reader)

        if method not in ("GET", "HEAD"):
            await send_response(writer, 405, [("Allow", "GET, HEAD")], b"")
            return

        file = site.get(path)
        if file is None:
            body = b"Not Found" if method == "GET" else b""
            await send_response(writer, 404, [("Content-Type", MEDIA_TYPES[".txt"])], body)
            return

        base = [("ETag", f'"{file.etag}"'), ("Cache-Control", file.cache_control)]
        if headers.get("if-none-match", "").strip() == f'"{file.etag}"':
            await send_response(writer, 304, base, b"")
            return

        use_gzip = gzip_on and file.gzip_body and "gzip" in headers.get("accept-encoding", "")
        body = file.gzip_body if use_gzip else file.body
        resp_headers = list(base)
        if use_gzip:
            resp_headers.append(("Content-Encoding", "gzip"))
        resp_headers.append(("Content-Type", file.media_type))
        payload = b"" if method == "HEAD" else body
        await send_response(writer, 200, resp_headers, payload)
    except (ConnectionResetError, BrokenPipeError, asyncio.TimeoutError):
        pass
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def start_server(port: int, root: str, gzip_on: bool):
    """Create the asyncio server. Returns (server, site) — testable in isolation."""
    site = Site(root)

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await handle_request(reader, writer, site, gzip_on)

    server = await asyncio.start_server(handler, "127.0.0.1", port)
    addrs = ", ".join(str(s.getsockname()) for s in server.sockets)
    print(f"serving {site.root} at http://{addrs} (gzip {'on' if gzip_on else 'off'})", file=sys.stderr)
    return server, site


async def main_async(port: int, root: str, gzip_on: bool) -> None:
    server, _site = await start_server(port, root, gzip_on)
    async with server:
        await server.serve_forever()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--root", default=".")
    ap.add_argument("--no-gzip", action="store_true")
    args = ap.parse_args()
    try:
        asyncio.run(main_async(args.port, args.root, not args.no_gzip))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
