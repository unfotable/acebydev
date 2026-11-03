"""Tests for tools/build.py — CSS/HTML minification and the build pipeline."""
import gzip
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tools"))

import build  # noqa: E402


class MinifyCssTest(unittest.TestCase):
    def test_strips_comments_and_whitespace(self):
        css = "/* header */\nbody {\n  color:  red;\n  margin: 0 ;\n}\n"
        self.assertEqual(build.minify_css(css), "body{color:red;margin:0}")

    def test_preserves_strings(self):
        css = 'a::after { content: "a; b }  c"; }'
        self.assertIn('"a; b }  c"', build.minify_css(css))

    def test_preserves_strings_with_escaped_quote(self):
        css = "a { content: 'it\\'s'; }"
        out = build.minify_css(css)
        self.assertIn("it\\'s", out)

    def test_removes_trailing_semicolons(self):
        self.assertEqual(build.minify_css("a { b: c; }"), "a{b:c}")

    def test_unclosed_comment_is_dropped_safely(self):
        self.assertEqual(build.minify_css("a{b:c}/* dangling"), "a{b:c}")

    def test_data_urls_survive(self):
        css = 'a { background: url("data:image/svg+xml;utf8,<svg x=\',\'/>") }'
        out = build.minify_css(css)
        self.assertIn("<svg x=','/>", out)

    def test_output_is_smaller(self):
        css = open(os.path.join(os.path.dirname(__file__), "..", "style.css"),
                   encoding="utf-8").read()
        self.assertLess(len(build.minify_css(css)), len(css))


class MinifyHtmlTest(unittest.TestCase):
    def test_strips_comments_keeps_conditional(self):
        html = "<!-- note --><!--[if IE]>keep<![endif]--><p>a</p>"
        out = build.minify_html(html)
        self.assertNotIn("note", out)
        self.assertIn("[if IE]", out)

    def test_collapses_blank_lines_and_indent(self):
        out = build.minify_html("<div>\n    <p>x</p>\n\n\n</div>\n")
        self.assertNotIn("\n\n", out)
        self.assertIn("\n<p>x</p>", out)


class GzipSizeTest(unittest.TestCase):
    def test_gzip_size_of_compressible_text(self):
        data = b"abcdefghij" * 100
        self.assertLess(build.gzip_size(data), len(data) // 2)


class BuildPipelineTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="acebydev-build-")
        # minimal source tree
        os.makedirs(os.path.join(self.root, "assets", "js"))
        for rel, content in {
            "index.html": ("<!doctype html><html><head><style>/* c */\n"
                           "body{color:red}\n</style></head>"
                           "<body><p>hi</p><!-- drop me --></body></html>"),
            "script.js": "console.log(1);\n",
            "style.css": "body{color:red}\n",
            "assets/js/app.js": "export const x = 1;\n",
            "assets/js/cover-art.js": "export const y = 2;\n",
            "assets/js/cover-canvas.js": "export const z = 3;\n",
            "assets/js/catalog.js": "export const w = 4;\n",
            "assets/js/spring.js": "export const s = 5;\n",
        }.items():
            with open(os.path.join(self.root, rel), "w", encoding="utf-8") as fh:
                fh.write(content)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_build_without_bundle_copies_modules_and_minifies(self):
        manifest = build.build(self.root, "dist", bundle=False)
        html = open(os.path.join(self.root, "dist", "index.html"), encoding="utf-8").read()
        self.assertIn("body{color:red}", html)   # CSS minified
        self.assertNotIn("drop me", html)        # comment stripped
        self.assertTrue(os.path.isfile(os.path.join(self.root, "dist", "assets", "js", "app.js")))
        self.assertFalse(manifest["bundle"])
        for entry in manifest["files"]:
            self.assertIn("gzip_bytes", entry)
            self.assertGreater(entry["gzip_bytes"], 0)
        html_entry = next(f for f in manifest["files"] if f["path"] == "index.html")
        self.assertLess(html_entry["gzip_bytes"], html_entry["bytes"])

    def test_manifest_is_written_and_valid(self):
        build.build(self.root, "dist", bundle=False)
        manifest = json.load(open(os.path.join(self.root, "dist", "build-manifest.json")))
        paths = {f["path"] for f in manifest["files"]}
        self.assertIn("index.html", paths)
        self.assertIn("script.js", paths)
        self.assertIn("style.css", paths)

    def test_bundle_fallback_when_esbuild_missing(self):
        ok, note = build.try_esbuild(self.root, os.path.join(self.root, "out.js"))
        self.assertFalse(ok)  # no node_modules in the fixture
        self.assertIn("esbuild", note)

    def test_bundle_with_real_esbuild(self):
        esbuild_src = os.path.join(os.path.dirname(__file__), "..", "node_modules", ".bin", "esbuild")
        if not os.path.isfile(esbuild_src):
            self.skipTest("esbuild not installed")
        node_bin = os.path.join(self.root, "node_modules", ".bin")
        os.makedirs(node_bin, exist_ok=True)
        os.symlink(os.path.abspath(esbuild_src), os.path.join(node_bin, "esbuild"))
        manifest = build.build(self.root, "dist", bundle=True)
        self.assertTrue(manifest["bundle"], manifest["note"])


if __name__ == "__main__":
    unittest.main()
