#!/usr/bin/env python3
"""Performance measurement harness for the acebydev site.

Serves a directory over HTTP and measures with headless Chromium (Playwright):
- navigation timings, FCP, LCP
- long tasks (count / total blocked ms)
- frame interval stats over a sampling window (mean, p95, jank%, max)
- JS heap trajectory (usedJSHeapSize samples)
- console errors / page errors (stability)
- full-page screenshot for visual identity comparison

Usage:
  python3 measure.py --dir /path/to/site --out /path/to/results.json \
      [--port 8901] [--cpu-throttle 1] [--sample-seconds 8]
"""
import argparse
import http.server
import json
import socketserver
import statistics
import threading
import time

from playwright.sync_api import sync_playwright

INIT_OBSERVERS = """
window.__metrics = { longTasks: [], errors: [], lcp: 0, fcp: 0 };
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      window.__metrics.longTasks.push({ start: e.startTime, dur: e.duration });
    }
  }).observe({ type: 'longtask', buffered: true });
} catch (e) {}
try {
  new PerformanceObserver((list) => {
    const es = list.getEntries();
    if (es.length) window.__metrics.lcp = es[es.length - 1].startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
} catch (e) {}
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') window.__metrics.fcp = e.startTime;
  }).observe({ type: 'paint', buffered: true });
} catch (e) {}
window.addEventListener('error', (e) => window.__metrics.errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__metrics.errors.push('rejection: ' + String(e.reason)));
"""

FRAME_SAMPLER = """
window.__frames = { deltas: [], heap: [], done: false };
(() => {
  let last = performance.now();
  const t0 = last;
  let lastHeap = 0;
  function tick(now) {
    const d = now - last;
    last = now;
    if (d > 1 && d < 1000) window.__frames.deltas.push(d);
    if (now - lastHeap > 500) {
      lastHeap = now;
      if (performance.memory) window.__frames.heap.push(performance.memory.usedJSHeapSize);
    }
    if (now - t0 < __SAMPLE_MS__) requestAnimationFrame(tick);
    else window.__frames.done = true;
  }
  requestAnimationFrame(tick);
})();
"""


def serve_dir(directory: str, port: int):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=directory, **kw)

        def log_message(self, *a):  # silence
            pass

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def pct(values, p):
    if not values:
        return 0
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round((p / 100) * (len(s) - 1)))))
    return s[k]


def run_measure(url, out_json, sample_seconds, cpu_throttle, shots_prefix):
    results = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--disable-dev-shm-usage",
        ])
        ctx = browser.new_context(viewport={"width": 1280, "height": 800},
                                  device_scale_factor=1)
        page = ctx.new_page()
        page.add_init_script(INIT_OBSERVERS)
        cdp = ctx.new_cdp_session(page)
        if cpu_throttle and cpu_throttle != 1:
            cdp.send("Emulation.setCPUThrottlingRate", {"rate": cpu_throttle})

        console_errors = []
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        nav_start = time.time()
        page.goto(url, wait_until="load", timeout=60000)
        load_ms = (time.time() - nav_start) * 1000
        page.wait_for_timeout(4000)  # let intro finish

        nav = page.evaluate("""() => {
            const n = performance.getEntriesByType('navigation')[0];
            return n ? { ttfb: n.responseStart, dcl: n.domContentLoadedEventEnd,
                         load: n.loadEventEnd, transferSize: n.transferSize,
                         decodedBodySize: n.decodedBodySize } : {};
        }""")
        res = page.evaluate("""() => {
            const r = performance.getEntriesByType('resource');
            return {
                count: r.length,
                bytes: r.reduce((s, e) => s + (e.transferSize || 0), 0),
                scripts: r.filter(e => e.name.includes('.js') || e.name.includes('three')).map(e => ({
                    name: e.name.split('/').slice(-1)[0].slice(0, 40),
                    ms: Math.round(e.duration), bytes: e.transferSize || 0
                })).sort((a, b) => b.ms - a.ms).slice(0, 8),
            };
        }""")

        # frame sampling
        page.evaluate(FRAME_SAMPLER.replace("__SAMPLE_MS__", str(int(sample_seconds * 1000))))
        page.wait_for_timeout(sample_seconds * 1000 + 800)
        frames = page.evaluate("() => window.__frames")
        m = page.evaluate("() => window.__metrics")

        deltas = frames["deltas"]
        heap = frames["heap"]
        long_tasks = m["longTasks"]
        results["navigation"] = {
            "load_event_ms": round(load_ms, 1),
            "ttfb_ms": round(nav.get("ttfb", 0), 1),
            "dom_content_loaded_ms": round(nav.get("dcl", 0), 1),
            "html_transfer_bytes": nav.get("transferSize", 0),
        }
        results["paint"] = {"fcp_ms": round(m["fcp"], 1), "lcp_ms": round(m["lcp"], 1)}
        results["resources"] = res
        results["long_tasks"] = {
            "count": len(long_tasks),
            "total_ms": round(sum(t["dur"] for t in long_tasks), 1),
            "worst_ms": round(max((t["dur"] for t in long_tasks), default=0), 1),
        }
        results["frames"] = {
            "sampled": len(deltas),
            "mean_ms": round(statistics.mean(deltas), 2) if deltas else 0,
            "p95_ms": round(pct(deltas, 95), 2),
            "max_ms": round(max(deltas), 2) if deltas else 0,
            "jank_pct": round(100 * sum(1 for d in deltas if d > 21) / max(1, len(deltas)), 2),
            "fps_equivalent": round(1000 / statistics.mean(deltas), 1) if deltas else 0,
        }
        results["heap"] = {
            "first_kb": round(heap[0] / 1024, 1) if heap else 0,
            "last_kb": round(heap[-1] / 1024, 1) if heap else 0,
            "peak_kb": round(max(heap) / 1024, 1) if heap else 0,
            "growth_kb": round((heap[-1] - heap[0]) / 1024, 1) if len(heap) > 1 else 0,
            "samples": len(heap),
        }
        results["errors"] = {"console": console_errors[:10], "count": len(console_errors)}
        results["meta"] = {"cpu_throttle": cpu_throttle, "sample_seconds": sample_seconds,
                           "url": url, "measured_at": time.strftime("%Y-%m-%d %H:%M:%S")}

        if shots_prefix:
            page.set_viewport_size({"width": 1280, "height": 800})
            page.wait_for_timeout(600)
            page.screenshot(timeout=10000, path=f"{shots_prefix}_1280x800.png")
            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(700)
            page.screenshot(timeout=10000, path=f"{shots_prefix}_390x844.png")

        browser.close()
    with open(out_json, "w") as f:
        json.dump(results, f, indent=2)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--port", type=int, default=8901)
    ap.add_argument("--cpu-throttle", type=float, default=1)
    ap.add_argument("--sample-seconds", type=float, default=8)
    ap.add_argument("--shots", default="")
    args = ap.parse_args()

    httpd = serve_dir(args.dir, args.port)
    url = f"http://127.0.0.1:{args.port}/index.html"
    try:
        r = run_measure(url, args.out, args.sample_seconds, args.cpu_throttle, args.shots)
        print(json.dumps(r, indent=2))
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
