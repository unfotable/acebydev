"""Tests for tools/serve.py — the asyncio static server."""
import asyncio
import gzip
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import serve  # noqa: E402


class SiteTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="acebydev-serve-")
        with open(os.path.join(self.root, "index.html"), "w") as fh:
            fh.write("<html>" + "x" * 2000 + "</html>")
        os.makedirs(os.path.join(self.root, "sub"))
        with open(os.path.join(self.root, "sub", "a.js"), "w") as fh:
            fh.write("console.log(1);")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_serves_index_for_root(self):
        site = serve.Site(self.root)
        file = site.get("/")
        self.assertIsNotNone(file)
        self.assertEqual(file.media_type, "text/html; charset=utf-8")

    def test_mime_types(self):
        site = serve.Site(self.root)
        self.assertEqual(site.get("/sub/a.js").media_type, "text/javascript; charset=utf-8")
        self.assertEqual(site.get("/missing.txt"), None)

    def test_blocks_path_traversal(self):
        site = serve.Site(self.root)
        self.assertIsNone(site.get("/../etc/passwd"))
        self.assertIsNone(site.get("/../../etc/passwd"))

    def test_etag_stable_and_cache_headers(self):
        site = serve.Site(self.root)
        file = site.get("/")
        self.assertEqual(len(file.etag), 16)
        self.assertEqual(file.cache_control, "no-cache")
        self.assertEqual(site.get("/sub/a.js").cache_control, "public, max-age=3600")

    def test_gzip_built_for_large_compressible_files_only(self):
        site = serve.Site(self.root)
        self.assertIsNotNone(site.get("/").gzip_body)
        tiny = os.path.join(self.root, "tiny.css")
        with open(tiny, "w") as fh:
            fh.write("a{b:c}")
        self.assertIsNone(site.get("/tiny.css").gzip_body)

    def test_rereads_when_mtime_changes(self):
        site = serve.Site(self.root)
        before = site.get("/sub/a.js").body
        with open(os.path.join(self.root, "sub", "a.js"), "w") as fh:
            fh.write("console.log(2);")
        st = os.stat(os.path.join(self.root, "sub", "a.js"))
        os.utime(os.path.join(self.root, "sub", "a.js"), (st.st_atime + 10, st.st_mtime + 10))
        after = site.get("/sub/a.js").body
        self.assertNotEqual(before, after)


class ServerTest(unittest.TestCase):
    """End-to-end over a real socket (server on an ephemeral port)."""

    @classmethod
    def setUpClass(cls):
        cls.root = tempfile.mkdtemp(prefix="acebydev-serve2-")
        with open(os.path.join(cls.root, "index.html"), "w") as fh:
            fh.write("<html>" + "y" * 2000 + "</html>")
        with open(os.path.join(cls.root, "app.js"), "w") as fh:
            fh.write("console.log(1);")
        cls.loop = asyncio.new_event_loop()
        cls.thread = threading.Thread(
            target=cls.loop.run_forever, daemon=True)
        cls.thread.start()
        site = serve.Site(cls.root)

        async def start():
            async def handler(reader, writer):
                await serve.handle_request(reader, writer, site, True)
            server = await asyncio.start_server(handler, "127.0.0.1", 0)
            return server

        cls.server = asyncio.run_coroutine_threadsafe(start(), cls.loop).result()
        cls.port = cls.server.sockets[0].getsockname()[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.close()
        cls.loop.call_soon_threadsafe(cls.loop.stop)
        cls.thread.join(timeout=2)
        cls.loop.close()
        shutil.rmtree(cls.root, ignore_errors=True)

    def url(self, path):
        return f"http://127.0.0.1:{self.port}{path}"

    def test_get_html(self):
        with urllib.request.urlopen(self.url("/")) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers["Content-Type"], "text/html; charset=utf-8")
            self.assertGreater(len(resp.read()), 1000)

    def test_gzip_negotiation(self):
        req = urllib.request.Request(self.url("/"), headers={"Accept-Encoding": "gzip"})
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.headers.get("Content-Encoding"), "gzip")
            body = gzip.decompress(resp.read())
        self.assertTrue(body.startswith(b"<html>"))

    def test_304_revalidation(self):
        with urllib.request.urlopen(self.url("/")) as resp:
            etag = resp.headers["ETag"]
        req = urllib.request.Request(self.url("/"), headers={"If-None-Match": etag})
        try:
            urllib.request.urlopen(req)
            self.fail("expected HTTPError 304")
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 304)

    def test_404(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(self.url("/nope.js"))
        self.assertEqual(cm.exception.code, 404)

    def test_method_not_allowed(self):
        req = urllib.request.Request(self.url("/"), method="POST", data=b"x")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req)
        self.assertEqual(cm.exception.code, 405)

    def test_head_has_no_body(self):
        req = urllib.request.Request(self.url("/"), method="HEAD")
        with urllib.request.urlopen(req) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.read(), b"")


if __name__ == "__main__":
    unittest.main()
