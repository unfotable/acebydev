"""Tests for tools/audit.py — the quality gate."""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

AUDIT = os.path.join(os.path.dirname(__file__), "..", "tools", "audit.py")
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

GOOD_APP = '''
import * as THREE from 'three';
const scratch = new THREE.Vector3();
const meshes = [];
function animate(now) {
  requestAnimationFrame(animate);
  const dt = 0.016;
  mesh.localToWorld(scratch.set(0, 0.1, 0));
  renderer.render(scene, camera);
}
window.addEventListener('pointermove', () => {}, { passive: true });
let cursor = '';
if (nextCursor !== cursor) { rendererCanvas.style.cursor = cursor = nextCursor; }
'''


def write(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


class AuditFixture(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="acebydev-audit-")
        write(os.path.join(self.root, "index.html"), self._good_html())
        write(os.path.join(self.root, "assets", "js", "app.js"), GOOD_APP)
        write(os.path.join(self.root, "script.js"),
              "var MAX_MESSAGES = 200;\ntry { localStorage.setItem('k','v'); } catch (e) {}\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    @staticmethod
    def _good_html():
        return ('<!doctype html><html><head><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width, initial-scale=1">'
                '<meta name="description" content="d"><meta name="theme-color" content="#000">'
                '<meta property="og:title" content="t"><link rel="icon" href="x">'
                '<link rel="preconnect" href="https://fonts.example">'
                '<link rel="modulepreload" href="a.js">'
                '<script>window.__folioFallback = function () {};</script>'
                '<noscript>fallback</noscript>'
                '</head><body>ok</body></html>')

    def run_audit(self):
        return subprocess.run(
            [sys.executable, AUDIT, "--root", self.root, "--json"],
            capture_output=True, text=True, timeout=60)

    def test_clean_fixture_passes(self):
        proc = self.run_audit()
        result = __import__("json").loads(proc.stdout)
        self.assertTrue(result["pass"], result)
        self.assertEqual(proc.returncode, 0)

    def test_loop_allocation_fails(self):
        # a file whose ONLY animate() allocates — audit must flag it
        write(os.path.join(self.root, "assets", "js", "app.js"),
              "import * as THREE from 'three';\n"
              "function animate(now) { requestAnimationFrame(animate); const v = new THREE.Vector3(); }")
        proc = self.run_audit()
        result = __import__("json").loads(proc.stdout)
        self.assertFalse(result["pass"])
        rules = {v["rule"] for v in result["errors"]}
        self.assertIn("loop-alloc", rules)

    def test_array_method_in_loop_fails(self):
        write(os.path.join(self.root, "assets", "js", "app.js"),
              "const meshes = [];\nfunction animate(now) { requestAnimationFrame(animate); meshes.map(f => f); }")
        proc = self.run_audit()
        result = __import__("json").loads(proc.stdout)
        self.assertIn("loop-alloc", {v["rule"] for v in result["errors"]})

    def test_non_passive_listener_fails(self):
        # keep the animate() the audit expects, add a bad listener
        write(os.path.join(self.root, "assets", "js", "app.js"),
              GOOD_APP + "\nwindow.addEventListener('touchmove', function () {}, {});\n")
        proc = self.run_audit()
        result = __import__("json").loads(proc.stdout)
        self.assertIn("passive-listener", {v["rule"] for v in result["errors"]})

    def test_template_innerhtml_fails(self):
        write(os.path.join(self.root, "assets", "js", "app.js"),
              GOOD_APP + "\nel.innerHTML = `<b>${user}</b>`;\n")
        proc = self.run_audit()
        result = __import__("json").loads(proc.stdout)
        self.assertIn("xss-guard", {v["rule"] for v in result["errors"]})

    def test_unguarded_localstorage_fails(self):
        write(os.path.join(self.root, "script.js"), "localStorage.setItem('a', 'b');")
        proc = self.run_audit()
        result = __import__("json").loads(proc.stdout)
        self.assertIn("storage-guard", {v["rule"] for v in result["errors"]})

    def test_uncapped_chat_history_fails(self):
        write(os.path.join(self.root, "script.js"),
              "try { localStorage.setItem('a', 'b'); } catch (e) {}\n")
        proc = self.run_audit()
        result = __import__("json").loads(proc.stdout)
        self.assertIn("storage-growth", {v["rule"] for v in result["errors"]})

    def test_missing_meta_fails(self):
        write(os.path.join(self.root, "index.html"),
              "<!doctype html><html><head></head><body>x</body></html>")
        proc = self.run_audit()
        result = __import__("json").loads(proc.stdout)
        self.assertIn("required-markup", {v["rule"] for v in result["errors"]})

    def test_budget_violation_fails(self):
        write(os.path.join(self.root, "index.html"),
              self._good_html() + "<!-- " + "pad" * 8000 + " -->")
        proc = self.run_audit()
        result = __import__("json").loads(proc.stdout)
        self.assertIn("budget", {v["rule"] for v in result["errors"]})

    def test_missing_app_js_fails(self):
        os.remove(os.path.join(self.root, "assets", "js", "app.js"))
        proc = self.run_audit()
        result = __import__("json").loads(proc.stdout)
        self.assertIn("required-file", {v["rule"] for v in result["errors"]})

    def test_human_output_on_real_repo(self):
        proc = subprocess.run([sys.executable, AUDIT, "--root", ROOT],
                              capture_output=True, text=True, timeout=60)
        self.assertIn("error(s)", proc.stdout)


if __name__ == "__main__":
    unittest.main()
