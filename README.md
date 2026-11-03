# unfotable — selected projects

A small, dependency-light portfolio: an interactive 3D bookshelf (three.js) whose
books are procedurally generated pixel-art covers, wired to a project panel.
Ships as plain static files — no framework, no runtime build required.

## Structure

```
index.html              page + inline critical CSS + boot fallback
assets/js/app.js        three.js application layer (render loop, interactions)
assets/js/catalog.js    covers / shelf order / project data
assets/js/cover-art.js  pure pixel-art engine (no DOM — runs in Node tests)
assets/js/cover-canvas.js  DOM bridge of the cover engine
assets/js/spring.js     damped-spring integrator for the book physics
script.js, style.css    legacy chat page assets (chat.html was removed from the
                        repo but these are still served; kept working + hardened)
tools/                  Python toolkit (stdlib only): serve / build / audit
tests/js/               node:test suites (art, catalog, spring, chat logic)
tests/test_*.py         unittest suites for the Python toolkit
dist/                   production build output (generated; see below)
```

## Develop

```bash
python3 tools/serve.py --port 8000        # asyncio dev server (gzip, ETag/304)
# open http://127.0.0.1:8000/
```

## Test

```bash
npm install                                # esbuild + three (devDependencies)
node --test --experimental-test-coverage tests/js/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
python3 tools/audit.py                     # perf/quality gate (budgets, lint)
```

Coverage targets (enforced in CI): ≥ 91% on `tools/` (measured: 97%) and the
JS modules (measured: 100% line / 98% branch). The `tests/js/fixtures/cover-golden.json`
file pins the exact cover artwork produced by the original implementation.

## Build for production

```bash
python3 tools/build.py        # bundles three.js + app with esbuild → dist/
```

The bundle is ~36% lighter over the wire than fetching three.js from a CDN and
collapses the request waterfall into one file. Deploy `dist/` to any static
host; the unminified source tree works without any build step too.

## Performance

See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for measured before/after
numbers, methodology and the render-loop rules enforced by `tools/audit.py`.
