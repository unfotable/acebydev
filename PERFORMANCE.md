# Performance & Quality Report — acebydev upgrade

**Date:** 2026-11-02 · **Repository:** `unfotable/acebydev` (static portfolio, three.js 0.160.0)
**Method:** all runtime numbers were produced by the same headless-Chromium (Playwright) harness
against the pristine clone ("before") and the optimized tree ("after"), served identically over
local HTTP. Static numbers (file sizes, allocations) are derived from the code itself.

## 1. Environment constraint — read this first

The measurement sandbox has **no GPU**: Chromium renders WebGL through SwiftShader (software),
which makes a single frame cost ~500 ms — about 30× over a real 60 FPS frame budget, and ~95 % of
that cost is native rasterization, not JavaScript. Therefore:

- Absolute FPS here (~2) says nothing about real devices.
- Frame-time deltas below still measure *real* main-thread savings, but they are compressed by the
  dominant native raster cost; on real hardware (GPU raster in 2–6 ms) the same JS savings are a
  much larger share of the frame budget.
- CPU throttling (4×) saturates on top of SwiftShader, so the dynamic-resolution ladder cannot
  show its benefit here (it floors at pixel-ratio 1, still too slow for software rendering).
- Lighthouse was **not** run (no GPU/real display pipeline); no Lighthouse score is claimed.
- No smoothness or FPS target is *claimed as achieved* — see §5 for what is verified vs. deferred.

## 2. Loading (measured, same harness)

| Metric | Before | After | Δ |
|---|---:|---:|---|
| Document transfer size | 48,185 B | 15,980 B | **−66.8 %** |
| DOMContentLoaded | 448 ms | 378 ms | −16 % |
| First-party bytes over the wire (production bundle, gzipped) | 202.3 KB (three.module.js + RoomEnvironment from CDN) | 128.5 KB (single esbuild bundle) | **−36 %** |
| HTTP requests for JS (source/dev mode) | 1 inline (uncacheable) | 5 small cacheable modules | +4 (cached on repeat visits) |
| Console/page errors | 0 | 0 | — |

Notes: the production bundle collapses the two CDN files into one minified, tree-shaken request;
a build-manifest.json records sizes/sha256 per file. FCP/LCP numbers from the harness were
dominated by sandbox network warm-up and SwiftShader first-render respectively and are not
comparable run-to-run — they are omitted rather than presented as wins.

## 3. Render-loop hot path (code-level facts)

Per animation frame, before → after:

| Item | Before | After |
|---|---:|---:|
| Heap allocations | ~34/frame (≈2,000/s): `books.map()`, `new THREE.Vector3` ×32 + 2 virtual-cursor vectors | **0** (cached mesh list, 3 scratch vectors) |
| Raycasts | every frame (60 Hz) vs 32 meshes | every 2nd frame (≈30 Hz); clicks raycast immediately |
| `style.cursor` writes | every frame | on change only |
| Cover `emissive.setHex` writes | 32 per frame | on project change only |
| Web Animations alive after intro | 6 (`fill: forwards`, forever) | 0 (committed to inline styles, cancelled) |
| PMREMGenerator + RoomEnvironment | retained for page lifetime | disposed after baking |
| Resize handling | immediate | coalesced to one rAF |
| Quality fallback | none (CDN failure ⇒ page stays invisible) | boot flag + static reveal + `noscript` styles |

The spring integrator (`assets/js/spring.js`) is the same math, extracted and unit-tested for
convergence and stability at the dt clamp.

## 4. Runtime (measured, 8 s sampling window, identical harness)

| Metric (normal load) | Before | After | Δ |
|---|---:|---:|---|
| Long tasks: count | 34 | 31 | −8.8 % |
| Long tasks: total blocked time | 17,843 ms | 15,708 ms | **−12.0 %** |
| Frame interval mean | 499.98 ms | 487.23 ms | −2.6 % |
| Frame interval p95 | 599.9 ms | 533.3 ms | **−11.1 %** |
| Frame interval max | 666.7 ms | 550.0 ms | **−17.5 %** |
| JS heap growth over sample window | 0 | 0 | — (flat both; leak fixed is in localStorage, see below) |
| Console errors | 0 | 0 | — |

| Metric (4× CPU throttle) | Before | After | Δ |
|---|---:|---:|---|
| Frame interval mean | 686.1 ms | 687.5 ms | +0.2 % (saturated — see §1) |
| Long tasks total | 15,483 ms | 16,331 ms | +5.5 % (within run-to-run noise) |

V8 CPU profile (6 s, 100 µs sampling): both versions are dominated by native `(program)` time
(SwiftShader). `(garbage collector)` appears in the before top-25 (0.2 ms) and does not appear in
the after top-25 — consistent with the allocation elimination, but too small to be a headline
claim in this environment.

## 5. Verification summary (what is actually verified)

**Verified here (measured or deterministic):**
- Cover artwork is **byte-identical** to the original pipeline: FNV-1a hashes over all 32 rendered
  covers match goldens generated from the pristine code (`tests/js/fixtures/cover-golden.json`).
- Page identity: screenshots at rest (desktop 1280×800 and mobile 390×844, springs converged)
  match the original **99.97 %** of pixels (0.032 % differ >8/255, all sub-pixel font AA in the
  wordmark). Remaining diff when books are mid-settle is backdrop-filter sampling, not design.
- JS suites: **39/39 pass** — 100 % line / 98.1 % branch coverage on the extracted modules
  (`cover-art`, `catalog`, `cover-canvas`, `spring`) plus DOM-stub tests for `script.js`.
- Python suites: **59/59 pass** — 97 % coverage on `tools/` (build 99 %, serve 95 %).
- `tools/audit.py` gate: 0 errors, 0 warnings (budgets, loop-allocation lint, passive listeners,
  storage guards, required markup).
- Zero console/page errors in every measured run, both versions.
- Production build reproducible; `dist/` verified loadable (importmap-free bundle mode).

**Deferred (cannot be measured in this sandbox — not claimed):**
- 60 FPS on real hardware; DRS pixel-ratio ladder behavior; input latency; Lighthouse ≥ 90.
  These need a GPU machine; the harness scripts in this repo (`scripts/` of the delivery) run
  unchanged there.

## 6. Remaining issues

1. `scene.environmentIntensity = 0.55` is a silent no-op on three r160 (property added in r163).
   Kept for forward compatibility; visual parity is with r160 behavior either way.
2. Bundle mode requires `npm install` (esbuild + three as devDependencies). Without Node, the
   site still works in source mode (importmap + CDN) — just heavier on the wire.
3. The chat page (`chat.html`) was deleted from the repo history but `script.js`/`style.css`
   remain served; they are kept working and hardened (bounded history, quota-safe storage) but
   have no entry page in this repository.
4. Lighthouse/CWV scores on real hardware are unmeasured here (see §1).
5. Google Fonts remains a third-party render dependency (preconnected, `display=swap`); self-host
   would remove the dependency but adds font files to the repo — left as a product decision.
