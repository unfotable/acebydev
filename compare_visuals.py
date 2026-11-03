#!/usr/bin/env python3
"""Deterministic visual identity check (v2).

Protocol (applied identically to both versions):
- goto(wait_until=load)
- dispatch a pointermove far offscreen: ambient cursor suppressed, zero book
  lift, pointerInside=true so behavior is locked for the 4s window
- wait for document.fonts.ready (no font-swap diffs)
- wait until books settle (all intro delays < 1.4s + spring settling)
- screenshot and diff
"""
import argparse
import http.server
import socketserver
import threading

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright


def serve(directory, port):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=directory, **kw)

        def log_message(self, *a):
            pass

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def snap(page, url, path, debug_scene=False):
    page.goto(url, wait_until="load", timeout=60000)
    # Pin the pointer far offscreen and keep it there: ambient cursor suppressed,
    # zero book lift. Then wait until every book spring has actually converged
    # to rest (mesh positions ~0) — deterministic regardless of frame timing.
    page.evaluate(
        """() => {
      const move = () => window.dispatchEvent(new PointerEvent('pointermove',
        { clientX: -100000, clientY: -100000 }));
      move();
      window.__keepalive = setInterval(move, 1200);
    }"""
    )
    page.evaluate("document.fonts.ready.then(() => true)")
    if debug_scene and page.evaluate("!!window.__folioScene"):
        page.evaluate(
            """() => {
          window.__stable = false;
          const read = () => {
            const arr = [];
            window.__folioScene.traverse((o) => {
              if (o.isMesh && o.userData.bookIndex !== undefined)
                arr.push([o.position.y, o.position.z, o.rotation.x]);
            });
            return arr;
          };
          let prev = read();
          setInterval(() => {
            const cur = read();
            let maxd = 0;
            for (let i = 0; i < cur.length && i < prev.length; i++) {
              maxd = Math.max(maxd, Math.abs(cur[i][0] - prev[i][0]),
                Math.abs(cur[i][1] - prev[i][1]), Math.abs(cur[i][2] - prev[i][2]));
            }
            prev = cur;
            if (maxd < 1e-5) window.__stable = true;
          }, 1000);
        }"""
        )
        try:
            page.wait_for_function("window.__stable === true", timeout=150000, polling=1000)
        except Exception:
            pass  # fall through: compare whatever state we reached, symmetrically
    else:
        page.wait_for_timeout(60000)
    page.screenshot(path=path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--a-dir", required=True)
    ap.add_argument("--b-dir", required=True)
    ap.add_argument("--out", default="results/identity.png")
    ap.add_argument("--size", default="1280x800")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()
    w, h = (int(x) for x in args.size.split("x"))

    ha = serve(args.a_dir, 8911)
    hb = serve(args.b_dir, 8912)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
            ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=1)
            page = ctx.new_page()
            snap(page, "http://127.0.0.1:8911/index.html", "/tmp/id_a.png", debug_scene=args.debug)
            snap(page, "http://127.0.0.1:8912/index.html", "/tmp/id_b.png", debug_scene=args.debug)
            browser.close()
    finally:
        ha.shutdown()
        hb.shutdown()

    a = Image.open("/tmp/id_a.png").convert("RGB")
    b = Image.open("/tmp/id_b.png").convert("RGB")
    diff = ImageChops.difference(a, b)
    gray = diff.convert("L")
    px_total = a.size[0] * a.size[1]
    visible = sum(1 for v in gray.getdata() if v > 8)
    small = sum(1 for v in gray.getdata() if 0 < v <= 8)
    print(f"pixels differing  >8/255: {visible}/{px_total} ({100 * visible / px_total:.3f}%)")
    print(f"pixels differing 1..8  : {small} ({100 * small / px_total:.3f}%)  [anti-aliasing noise]")
    diff.save(args.out)
    return 100 * visible / px_total


if __name__ == "__main__":
    main()
