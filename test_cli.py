"""Coverage tests for CLI entry points and hard-to-reach branches."""
import asyncio
import contextlib
import io
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import build  # noqa: E402
import serve  # noqa: E402

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


class BuildCliTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="acebydev-cli-")
        os.makedirs(os.path.join(self.root, "assets", "js"))
        with open(os.path.join(self.root, "index.html"), "w") as fh:
            fh.write("<!doctype html><html><body>x</body></html>")
        for name in ("app.js", "cover-art.js", "cover-canvas.js", "catalog.js", "spring.js"):
            with open(os.path.join(self.root, "assets", "js", name), "w") as fh:
                fh.write(f"export const {name[0]} = 1;\n")
        with open(os.path.join(self.root, "script.js"), "w") as fh:
            fh.write("// chat\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_main_cli_no_bundle(self):
        with mock.patch.object(sys, "argv", ["build.py", "--root", self.root, "--no-bundle"]):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                code = build.main()
        self.assertEqual(code, 0)
        self.assertTrue(os.path.isfile(os.path.join(self.root, "dist", "index.html")))

    def test_main_cli_with_bundle_if_available(self):
        node_bin = os.path.join(self.root, "node_modules", ".bin")
        os.makedirs(node_bin, exist_ok=True)
        esbuild_src = os.path.join(REPO, "node_modules", ".bin", "esbuild")
        if not os.path.isfile(esbuild_src):
            self.skipTest("esbuild not installed in repo")
        os.symlink(esbuild_src, os.path.join(node_bin, "esbuild"))
        with mock.patch.object(sys, "argv", ["build.py", "--root", self.root]):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                code = build.main()
        self.assertEqual(code, 0)
        out = buf.getvalue()
        self.assertIn("bundle: yes", out)
        self.assertTrue(os.path.isfile(os.path.join(self.root, "dist", "assets", "js", "app.js")))

    def test_rebuild_cleans_stale_dist(self):
        stale = os.path.join(self.root, "dist", "assets", "js")
        os.makedirs(stale)
        with open(os.path.join(stale, "stale.js"), "w") as fh:
            fh.write("old")
        build.build(self.root, "dist", bundle=False)
        self.assertFalse(os.path.exists(os.path.join(self.root, "dist", "assets", "js", "stale.js")))

    def test_try_esbuild_reports_failure(self):
        # esbuild binary exists but is fed an invalid entry file
        node_bin = os.path.join(self.root, "node_modules", ".bin")
        os.makedirs(node_bin, exist_ok=True)
        esbuild_src = os.path.join(REPO, "node_modules", ".bin", "esbuild")
        if not os.path.isfile(esbuild_src):
            self.skipTest("esbuild not installed in repo")
        os.symlink(esbuild_src, os.path.join(node_bin, "esbuild"))
        with open(os.path.join(self.root, "assets", "js", "app.js"), "w") as fh:
            fh.write('import "does-not-exist";\n')
        ok, note = build.try_esbuild(self.root, os.path.join(self.root, "out.js"))
        self.assertFalse(ok)
        self.assertIn("esbuild failed", note)


class ServeCliTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="acebydev-servecli-")
        with open(os.path.join(self.root, "index.html"), "w") as fh:
            fh.write("<html>ok</html>")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_start_server_serves_requests(self):
        async def scenario():
            server, site = await serve.start_server(0, self.root, True)
            port = server.sockets[0].getsockname()[1]
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
            writer.write(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            await writer.drain()
            data = await reader.read(4096)
            writer.close()
            server.close()
            await server.wait_closed()
            return data, site

        data, site = asyncio.run(scenario())
        self.assertIn(b"200 OK", data)
        self.assertEqual(site.root, os.path.abspath(self.root))

    def test_main_handles_keyboard_interrupt(self):
        async def boom(*_a, **_k):
            raise KeyboardInterrupt()
        with mock.patch.object(sys, "argv", ["serve.py", "--root", self.root, "--port", "0"]):
            with mock.patch.object(serve, "main_async", boom):
                serve.main()  # must not raise

    def test_get_oserror_returns_none(self):
        site = serve.Site(self.root)
        with mock.patch.object(serve.os.path, "getmtime", side_effect=OSError):
            self.assertIsNone(site.get("/index.html"))


if __name__ == "__main__":
    unittest.main()
