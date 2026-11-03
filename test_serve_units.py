"""Direct coroutine tests for serve.handle_request — every branch, no sockets."""
import asyncio
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import serve  # noqa: E402


class FakeReader:
    def __init__(self, lines):
        self._buf = b"".join(lines)

    async def readline(self):
        idx = self._buf.find(b"\n")
        if idx == -1:
            line, self._buf = self._buf, b""
            return line
        line, self._buf = self._buf[:idx + 1], self._buf[idx + 1:]
        return line


class FakeWriter:
    def __init__(self):
        self.data = b""
        self.closed = False

    def write(self, data):
        self.data += data

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    async def wait_closed(self):
        return


def run(coro):
    return asyncio.run(coro)


class HandleRequestBranchTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="acebydev-hr-")
        with open(os.path.join(self.root, "index.html"), "w") as fh:
            fh.write("<html>" + "z" * 2000 + "</html>")
        self.site = serve.Site(self.root)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def request(self, *lines):
        reader = FakeReader([line + b"\r\n" for line in lines] + [b"\r\n"])
        writer = FakeWriter()
        run(serve.handle_request(reader, writer, self.site, gzip_on=True))
        return writer.data

    def test_get_200_with_gzip_and_headers(self):
        raw = self.request(b"GET / HTTP/1.1", b"Accept-Encoding: gzip")
        self.assertIn(b"200 OK", raw)
        self.assertIn(b"Content-Encoding: gzip", raw)
        self.assertIn(b"ETag: ", raw)
        self.assertIn(b"Cache-Control: no-cache", raw)
        self.assertIn(b"Content-Length: ", raw)

    def test_head_returns_headers_only(self):
        raw = self.request(b"HEAD / HTTP/1.1")
        self.assertIn(b"200 OK", raw)
        body = raw.split(b"\r\n\r\n", 1)[1]
        self.assertEqual(body, b"")

    def test_404(self):
        raw = self.request(b"GET /nope HTTP/1.1")
        self.assertIn(b"404 Not Found", raw)
        self.assertIn(b"Not Found", raw)

    def test_405_with_allow_header(self):
        raw = self.request(b"DELETE / HTTP/1.1")
        self.assertIn(b"405 Method Not Allowed", raw)
        self.assertIn(b"Allow: GET, HEAD", raw)

    def test_304_on_matching_etag(self):
        writer = FakeWriter()
        reader = FakeReader([b"GET / HTTP/1.1\r\n"])
        run(serve.handle_request(reader, writer, self.site, True))
        etag = [l for l in writer.data.split(b"\r\n") if l.startswith(b"ETag")][0]
        raw = self.request(b"GET / HTTP/1.1", b"If-None-Match: " + etag.split(b": ", 1)[1])
        self.assertIn(b"304 Not Modified", raw)

    def test_malformed_request_line_is_ignored(self):
        raw = self.request(b"GARBAGE")
        self.assertEqual(raw, b"")

    def test_empty_connection_closes_silently(self):
        raw = self.request()
        self.assertEqual(raw, b"")

    def test_gzip_disabled_flag(self):
        reader = FakeReader([b"GET / HTTP/1.1\r\n", b"Accept-Encoding: gzip\r\n", b"\r\n"])
        writer = FakeWriter()
        run(serve.handle_request(reader, writer, self.site, gzip_on=False))
        self.assertNotIn(b"Content-Encoding", writer.data)

    def test_query_string_and_fragment_stripped(self):
        raw = self.request(b"GET /index.html?x=1#frag HTTP/1.1")
        self.assertIn(b"200 OK", raw)

    def test_directory_url_serves_index(self):
        os.makedirs(os.path.join(self.root, "docs"))
        with open(os.path.join(self.root, "docs", "index.html"), "w") as fh:
            fh.write("<p>docs</p>")
        raw = self.request(b"GET /docs HTTP/1.1")
        self.assertIn(b"200 OK", raw)

    def test_connection_error_swallowed(self):
        class BoomReader:
            async def readline(self):
                raise ConnectionResetError()

        writer = FakeWriter()
        run(serve.handle_request(BoomReader(), writer, self.site, True))
        self.assertTrue(writer.closed)

    def test_site_traversal_and_isdir_edges(self):
        site = serve.Site(self.root)
        self.assertIsNone(site.resolve("/../x"))
        self.assertEqual(site.resolve(""), os.path.join(self.root, "index.html"))


class StaticFileTest(unittest.TestCase):
    def test_binary_types_not_gzipped(self):
        f = serve.StaticFile(b"\x89PNG\r\n\x1a\n" + b"\0" * 2000, ".png")
        self.assertIsNone(f.gzip_body)
        self.assertEqual(f.media_type, "image/png")
        self.assertEqual(f.cache_control, "public, max-age=86400")

    def test_unknown_type_fallback(self):
        f = serve.StaticFile(b"data", ".xyz")
        self.assertEqual(f.media_type, "application/octet-stream")

    def test_gzip_deterministic(self):
        f = serve.StaticFile(b"hello world" * 100, ".html")
        self.assertEqual(serve.gzip_compress(b"hello world" * 100), f.gzip_body)


if __name__ == "__main__":
    unittest.main()
