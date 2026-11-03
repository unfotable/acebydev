/**
 * cover-art.js — procedural pixel-art book cover engine.
 *
 * Pure module: no DOM, no THREE, no globals. Painters write colors through a
 * `set(x, y, rgb)` callback, so they can run headless (Node tests) or against
 * a real ImageData buffer in the browser. Extracted verbatim from the original
 * inline implementation to keep the visual output byte-identical.
 */

export const COVER_W = 96;
export const COVER_H = 144;
export const BAND_H = 26;
export const SCENE_H = COVER_H - BAND_H; // 118 rows of scene art above the title band

export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Deterministic 32-bit PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = (seed + 1) >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
export const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
export const rgbCss = (c) => 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
export const bayerAt = (x, y) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

// Curated lo-fi sky gradients (top -> horizon)
export const PIXEL_SKIES = {
  dusk:   ['#191036', '#3b1d52', '#71285f', '#a83a64', '#d95d53', '#f28d4e', '#ffc46b'],
  ember:  ['#170b12', '#3d1220', '#701c26', '#a53028', '#d4572f', '#ef8b3c', '#f7bd5c'],
  rose:   ['#221040', '#471a54', '#7c2a64', '#b34577', '#dd6b8a', '#f4959f', '#fdc3ae'],
  ocean:  ['#0a1a33', '#123156', '#1c4d7a', '#2a6f97', '#4a97b4', '#7fc4c4', '#c8ecd9'],
  night:  ['#04081c', '#0a1230', '#141f4a', '#202e63', '#303e7f', '#47519b', '#6f6cc0'],
  forest: ['#07120e', '#0d2718', '#123c22', '#1c5a2e', '#2f7a3a', '#4f9c4e', '#8cc06a'],
  meadow: ['#173a4a', '#1d5c63', '#27856b', '#4fae72', '#8ed489', '#cfeba0', '#fbf3b9'],
  slate:  ['#0c1018', '#141d2e', '#20304a', '#33507a', '#4d729f', '#7195bd', '#a3bed6'],
  candy:  ['#2b1440', '#5a1e58', '#96307a', '#c94b8e', '#ec6fa0', '#fb9bb0', '#ffd2c2'],
  moss:   ['#101c26', '#16302a', '#1d4a2e', '#2a6a33', '#44893c', '#6aa848', '#a3cc64'],
};

export const PIXEL_ARCHETYPES = [
  { name: 'sunset', skies: ['dusk', 'ember', 'rose', 'candy'] },
  { name: 'ocean',  skies: ['ocean', 'slate', 'dusk', 'meadow'] },
  { name: 'night',  skies: ['night', 'slate', 'dusk', 'candy'] },
  { name: 'forest', skies: ['forest', 'moss', 'meadow', 'night'] },
  { name: 'city',   skies: ['dusk', 'night', 'ember', 'slate'] },
  { name: 'dunes',  skies: ['ember', 'rose', 'meadow', 'candy'] },
  { name: 'rain',   skies: ['slate', 'night', 'forest', 'dusk'] },
  { name: 'pastel', skies: ['candy', 'rose', 'meadow', 'ocean'] },
];

// 3x5 bitmap font for cover titles
export const FONT3X5 = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
  E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
  I: '111010010010111', J: '001001001101010', K: '101110100110101', L: '100100100100111',
  M: '101111101101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
  Q: '010101101010001', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101101111101', X: '101101010101101',
  Y: '101101010010010', Z: '111001010100111',
  0: '010101101101010', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100110101010', 7: '111001010010010',
  8: '010101010101010', 9: '010101011001110',
  "'": '010010000000000', '&': '110100110101011', '-': '000000111000000', '!': '010010010000010',
  '?': '110001010000010', '.': '000000000000010', ',': '000000000010100', ':': '000010000010000',
};

export function scenePalette(skyHexes) {
  const sky = skyHexes.map(hexRgb);
  const horizon = sky[sky.length - 1];
  const mid = sky[Math.floor(sky.length / 2)];
  const dark = sky[0];
  return {
    sky,
    sun: mixRgb(horizon, [255, 246, 220], 0.5),
    glow: mixRgb(horizon, [255, 255, 255], 0.4),
    far: mixRgb(mid, [10, 7, 22], 0.6),
    near: mixRgb(dark, [5, 4, 12], 0.5),
    band: mixRgb(dark, [0, 0, 0], 0.55),
    accent: mixRgb(horizon, [255, 255, 255], 0.3),
    text: lum(horizon) < 92 ? mixRgb(horizon, [255, 255, 255], 0.85) : mixRgb(horizon, [255, 255, 245], 0.42),
    cloudL: mixRgb(sky[3], [255, 252, 246], 0.55),
    cloudD: mixRgb(sky[3], [15, 10, 30], 0.5),
  };
}

// ---- low-level painters (write into a set() callback) ----

export function pxRect(set, x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) set(x, y, c);
}

export function paintSky(set, sky, y0, y1) {
  const stops = sky.length - 1;
  for (let y = y0; y < y1; y += 1) {
    const f = ((y - y0) / Math.max(1, y1 - 1 - y0)) * stops;
    const i = Math.min(stops - 1, Math.floor(f));
    const frac = f - i;
    const q = Math.min(1, Math.max(0, (frac - 0.4) / 0.2)); // crisp dithered band edges
    for (let x = 0; x < COVER_W; x += 1) set(x, y, q > bayerAt(x, y) ? sky[i + 1] : sky[i]);
  }
}

export function paintSun(set, cx, cy, r, col, glow) {
  const r2 = r * r;
  const g1 = Math.round(r * 0.28);
  const g2 = Math.round(r * 0.6);
  for (let dy = -r; dy <= r; dy += 1) {
    if (dy === g1 || dy === g2) continue;
    for (let dx = -r; dx <= r; dx += 1) if (dx * dx + dy * dy <= r2) set(cx + dx, cy + dy, col);
  }
  for (let dy = -r - 2; dy <= r + 2; dy += 1) for (let dx = -r - 2; dx <= r + 2; dx += 1) {
    const d = dx * dx + dy * dy;
    if (d > r2 && d <= (r + 2) * (r + 2) && BAYER[(((cy + dy) & 3) * 4 + ((cx + dx) & 3))] / 16 < 0.2) set(cx + dx, cy + dy, glow);
  }
}

export function paintMoon(set, cx, cy, r, col, dark) {
  const r2 = r * r;
  const rb = Math.round(r * 0.85);
  const ox = Math.round(r * 0.55);
  const oy = -Math.round(r * 0.4);
  const lit = (dx, dy) => {
    if (dx * dx + dy * dy > r2) return false;
    const ax = dx - ox, ay = dy - oy;
    return ax * ax + ay * ay > rb * rb;
  };
  for (let dy = -r; dy <= r; dy += 1) for (let dx = -r; dx <= r; dx += 1) if (lit(dx, dy)) set(cx + dx, cy + dy, col);
  for (const [dx, dy] of [[-1, -2], [-3, 0], [0, 2]]) if (lit(dx, dy)) set(cx + dx, cy + dy, dark);
}

export function paintStars(set, rng, count, yMax, bright, dim) {
  for (let k = 0; k < count; k += 1) {
    const x = 2 + Math.floor(rng() * (COVER_W - 4));
    const y = Math.floor(rng() * yMax);
    if (rng() < 0.7) set(x, y, dim);
    else { set(x, y, bright); set(x - 1, y, dim); set(x + 1, y, dim); set(x, y - 1, dim); set(x, y + 1, dim); }
  }
}

export function ridgeLine(rng, base, amp, count) {
  const peaks = [];
  for (let k = 0; k < count; k += 1) {
    peaks.push({ x: ((k + 0.15 + rng() * 0.7) / count) * COVER_W, y: base - amp * (0.3 + rng() * 0.7), s: 0.45 + rng() * 0.6 });
  }
  const h = new Array(COVER_W);
  for (let x = 0; x < COVER_W; x += 1) {
    let m = base + 6;
    for (const p of peaks) m = Math.min(m, p.y + Math.abs(x - p.x) * p.s);
    h[x] = m;
  }
  return h;
}

export function paintRidge(set, h, col, yBottom, crest) {
  for (let x = 0; x < COVER_W; x += 1) {
    const top = Math.max(0, Math.round(h[x]));
    for (let y = top; y <= yBottom; y += 1) set(x, y, col);
    if (crest) set(x, top, crest);
  }
}

export function paintFog(set, y0, y1, col) {
  for (let y = y0; y <= y1; y += 1) for (let x = 0; x < COVER_W; x += 1) {
    if (y === y0 || y === y1) { if (bayerAt(x, y) < 0.5) set(x, y, col); }
    else set(x, y, col);
  }
}

export function paintCloud(set, cx, cy, w, hgt, light, shade) {
  for (let dy = -hgt; dy <= hgt; dy += 1) {
    const half = Math.round((w / 2) * Math.sqrt(Math.max(0, 1 - (dy / (hgt + 0.6)) ** 2)));
    if (half < 1) continue;
    const col = dy < 0 ? light : shade;
    for (let x = cx - half; x <= cx + half; x += 1) set(x, cy + dy, col);
  }
  const w2 = Math.round(w / 2) - 1;
  for (let x = cx - w2; x <= cx + w2; x += 2) set(x, cy + hgt + 1, shade);
}

export function paintPine(set, x, baseY, hgt, col) {
  for (let r = 0; r <= hgt; r += 1) {
    const half = Math.round((r / hgt) * 2.4);
    for (let dx = -half; dx <= half; dx += 1) set(x + dx, baseY - hgt + r, col);
  }
}

export function paintSea(set, y0, y1, top, bot, sunX, glow, rng) {
  for (let y = y0; y <= y1; y += 1) {
    const f = (y - y0) / Math.max(1, y1 - y0);
    const base = mixRgb(top, bot, Math.floor(f * 4) / 3);
    for (let x = 0; x < COVER_W; x += 1) set(x, y, base);
    const spread = 3 + f * 26;
    const n = 1 + Math.floor(rng() * 2);
    for (let k = 0; k < n; k += 1) {
      if (rng() < 0.45) continue;
      const x = Math.round(sunX + (rng() * 2 - 1) * spread);
      const len = 1 + Math.floor(rng() * 3);
      pxRect(set, x, y, len, 1, mixRgb(glow, base, 0.25 + f * 0.45));
    }
  }
}

// ---- the eight scene archetypes ----
export const SCENE_PAINTERS = {
  sunset(set, rng, pal) {
    paintSky(set, pal.sky, 0, SCENE_H);
    const cx = 22 + Math.floor(rng() * 52);
    paintSun(set, cx, 30 + Math.floor(rng() * 16), 9 + Math.floor(rng() * 5), pal.sun, pal.glow);
    const far = ridgeLine(rng, 84, 20 + rng() * 10, 4 + Math.floor(rng() * 2));
    paintRidge(set, far, pal.far, SCENE_H - 1, mixRgb(pal.far, pal.glow, 0.3));
    paintFog(set, 82, 87, mixRgb(pal.sky[3], pal.glow, 0.35));
    const near = ridgeLine(rng, 96, 22 + rng() * 12, 3 + Math.floor(rng() * 2));
    paintRidge(set, near, pal.near, SCENE_H - 1, mixRgb(pal.near, pal.accent, 0.25));
  },

  ocean(set, rng, pal) {
    paintSky(set, pal.sky, 0, SCENE_H);
    const horizon = 58 + Math.floor(rng() * 10);
    const cx = 26 + Math.floor(rng() * 44);
    if (lum(pal.sky[1]) < 38) paintStars(set, rng, 14, horizon - 22, pal.glow, mixRgb(pal.sky[4], pal.glow, 0.35));
    if (rng() < 0.3) paintMoon(set, cx, horizon - 16 - Math.floor(rng() * 8), 7 + Math.floor(rng() * 4), pal.glow, mixRgb(pal.glow, pal.sky[1], 0.5));
    else paintSun(set, cx, horizon - 3, 8 + Math.floor(rng() * 4), pal.sun, pal.glow);
    paintCloud(set, 16 + Math.floor(rng() * 20), 14 + Math.floor(rng() * 14), 18 + Math.floor(rng() * 14), 2 + Math.floor(rng() * 2), pal.cloudL, pal.cloudD);
    if (rng() < 0.6) paintCloud(set, 62 + Math.floor(rng() * 18), 20 + Math.floor(rng() * 16), 14 + Math.floor(rng() * 12), 2, pal.cloudL, pal.cloudD);
    for (let x = 0; x < COVER_W; x += 1) set(x, horizon, mixRgb(pal.glow, pal.sky[4], 0.3));
    const seaTop = mixRgb(pal.sky[3], [8, 6, 20], 0.55);
    const seaBot = mixRgb(pal.sky[0], [0, 0, 0], 0.45);
    paintSea(set, horizon + 1, SCENE_H - 1, seaTop, seaBot, cx, pal.glow, rng);
  },

  night(set, rng, pal) {
    paintSky(set, pal.sky, 0, SCENE_H);
    paintStars(set, rng, 34, 78, pal.glow, mixRgb(pal.sky[4], pal.glow, 0.35));
    paintMoon(set, 26 + Math.floor(rng() * 44), 18 + Math.floor(rng() * 20), 8 + Math.floor(rng() * 4), pal.glow, mixRgb(pal.sky[3], pal.glow, 0.3));
    if (rng() < 0.5) paintCloud(set, 20 + Math.floor(rng() * 56), 30 + Math.floor(rng() * 18), 16 + Math.floor(rng() * 12), 2, mixRgb(pal.sky[2], pal.glow, 0.25), mixRgb(pal.sky[1], [0, 0, 0], 0.2));
    const farHills = ridgeLine(rng, 86, 10 + rng() * 6, 3);
    paintRidge(set, farHills, pal.far, SCENE_H - 1, null);
    const hills = ridgeLine(rng, 96, 12 + rng() * 8, 3);
    paintRidge(set, hills, pal.near, SCENE_H - 1, mixRgb(pal.near, pal.accent, 0.25));
    for (let k = 0; k < 8; k += 1) set(6 + Math.floor(rng() * 84), 88 + Math.floor(rng() * 22), k % 3 ? pal.accent : pal.glow);
  },

  forest(set, rng, pal) {
    paintSky(set, pal.sky, 0, SCENE_H);
    if (rng() < 0.7) paintSun(set, 40 + Math.floor(rng() * 16), 24, 6 + Math.floor(rng() * 3), pal.sun, pal.glow);
    let e = 62 + Math.floor(rng() * 8);
    for (let x = 0; x < COVER_W; x += 1) {
      e = Math.max(54, Math.min(76, e + Math.floor(rng() * 3) - 1));
      for (let y = e; y < SCENE_H; y += 1) set(x, y, pal.far);
      set(x, e, mixRgb(pal.far, pal.glow, 0.3));
    }
    paintFog(set, 82, 90, mixRgb(pal.sky[3], pal.glow, 0.4));
    const groundY = 100;
    pxRect(set, 0, groundY, COVER_W, SCENE_H - groundY, pal.near);
    let x = 3;
    while (x < COVER_W - 2) { paintPine(set, x, groundY, 14 + Math.floor(rng() * 16), pal.near); x += 5 + Math.floor(rng() * 5); }
    for (let k = 0; k < 6; k += 1) set(8 + Math.floor(rng() * 80), 86 + Math.floor(rng() * 26), k % 2 ? pal.accent : pal.glow);
  },

  city(set, rng, pal) {
    paintSky(set, pal.sky, 0, SCENE_H);
    paintStars(set, rng, 18, 50, pal.glow, mixRgb(pal.sky[4], pal.glow, 0.3));
    const baseY = 102;
    let x = -2;
    while (x < COVER_W) {
      const w = 5 + Math.floor(rng() * 7);
      const hgt = 12 + Math.floor(rng() * 26);
      pxRect(set, x, baseY - hgt, w, hgt, pal.far);
      x += w + 1;
    }
    x = -3;
    const warm = mixRgb(pal.sun, [255, 224, 130], 0.35);
    while (x < COVER_W) {
      const w = 7 + Math.floor(rng() * 9);
      const hgt = 24 + Math.floor(rng() * 42);
      const top = baseY - hgt;
      pxRect(set, x, top, w, hgt, pal.near);
      for (let wy = top + 2; wy <= baseY - 3; wy += 3) {
        for (let wx = x + 2; wx <= x + w - 2; wx += 3) if (rng() < 0.22) set(wx, wy, warm);
      }
      if (rng() < 0.4) {
        const ax = x + 1 + Math.floor(rng() * Math.max(1, w - 2));
        const ph = 3 + Math.floor(rng() * 3);
        pxRect(set, ax, top - ph, 1, ph, pal.near);
        set(ax, top - ph - 1, [224, 72, 72]);
      }
      x += w + 1;
    }
    pxRect(set, 0, baseY, COVER_W, SCENE_H - baseY, mixRgb(pal.near, [0, 0, 0], 0.4));
  },

  dunes(set, rng, pal) {
    paintSky(set, pal.sky, 0, SCENE_H);
    paintSun(set, 28 + Math.floor(rng() * 40), 26 + Math.floor(rng() * 12), 12 + Math.floor(rng() * 4), pal.sun, pal.glow);
    const bases = [70, 88, 106];
    for (let k = 0; k < 3; k += 1) {
      const f1 = 0.05 + rng() * 0.045;
      const L = {
        base: bases[k] + Math.floor(rng() * 4),
        a1: 5 + rng() * 5, a2: 1.2 + rng() * 1.6,
        f1, f2: f1 * (2.2 + rng() * 0.7),
        p1: rng() * 6.28, p2: rng() * 6.28,
        col: mixRgb(pal.far, pal.near, 0.28 + k * 0.36),
      };
      for (let x = 0; x < COVER_W; x += 1) {
        const y = Math.max(0, Math.round(L.base + L.a1 * Math.sin(x * L.f1 + L.p1) + L.a2 * Math.sin(x * L.f2 + L.p2)));
        for (let yy = y; yy < SCENE_H; yy += 1) set(x, yy, L.col);
        set(x, y, mixRgb(L.col, pal.glow, 0.24));
      }
    }
  },

  rain(set, rng, pal) {
    paintSky(set, pal.sky, 0, SCENE_H);
    paintCloud(set, 24 + Math.floor(rng() * 48), 22 + Math.floor(rng() * 14), 22 + Math.floor(rng() * 16), 3, pal.cloudD, mixRgb(pal.cloudD, [0, 0, 0], 0.3));
    const hills = ridgeLine(rng, 94, 14 + rng() * 8, 3);
    paintRidge(set, hills, pal.near, SCENE_H - 1, null);
    paintFog(set, 86, 92, mixRgb(pal.sky[3], pal.glow, 0.35));
    const streak = mixRgb(pal.sky[4], pal.glow, 0.5);
    const n = 84 + Math.floor(rng() * 40);
    for (let k = 0; k < n; k += 1) {
      const x = Math.floor(rng() * (COVER_W + 8)) - 8;
      const y = Math.floor(rng() * (SCENE_H - 8));
      const len = 4 + Math.floor(rng() * 3);
      for (let j = 0; j < len; j += 1) set(x + Math.round(j * 0.45), y + j, streak);
    }
    for (let k = 0; k < 6; k += 1) pxRect(set, 6 + Math.floor(rng() * 78), 106 + Math.floor(rng() * 10), 3 + Math.floor(rng() * 4), 1, mixRgb(pal.near, pal.glow, 0.35));
  },

  pastel(set, rng, pal) {
    paintSky(set, pal.sky, 0, SCENE_H);
    paintSun(set, 30 + Math.floor(rng() * 36), 30 + Math.floor(rng() * 14), 12 + Math.floor(rng() * 4), pal.sun, pal.glow);
    const n = 4 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k += 1) paintCloud(set, 10 + Math.floor(rng() * 76), 16 + Math.floor(rng() * 52), 18 + Math.floor(rng() * 20), 3 + Math.floor(rng() * 2), pal.cloudL, pal.cloudD);
    const b = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < b; k += 1) {
      const bx = 14 + Math.floor(rng() * 68);
      const by = 24 + Math.floor(rng() * 40);
      set(bx, by, pal.far); set(bx + 1, by - 1, pal.far); set(bx + 2, by, pal.far);
    }
    const cy0 = 102;
    for (let x = 0; x < COVER_W; x += 1) {
      const e = cy0 - 2 + Math.floor(rng() * 5);
      for (let y = e; y < SCENE_H; y += 1) set(x, y, y === e ? pal.cloudL : mixRgb(pal.cloudL, pal.cloudD, (y - e) / 20));
      if (bayerAt(x, e - 1) < 0.5) set(x, e - 1, pal.cloudL);
    }
  },
};

export function wrapTitle(text, maxChars) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const cand = cur ? cur + ' ' + w : w;
    if (cand.length <= maxChars) cur = cand;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

export function drawDiamond(ctx, x, y, col) {
  ctx.fillStyle = col;
  ctx.fillRect(x, y + 1, 1, 1);
  ctx.fillRect(x + 1, y, 1, 3);
  ctx.fillRect(x + 2, y + 1, 1, 1);
}

export function paintBand(ctx, pal, title) {
  ctx.fillStyle = rgbCss(pal.band);
  ctx.fillRect(0, SCENE_H, COVER_W, BAND_H);
  ctx.fillStyle = rgbCss(pal.accent);
  ctx.fillRect(0, SCENE_H, COVER_W, 1);
  ctx.fillStyle = rgbCss(mixRgb(pal.band, pal.accent, 0.4));
  for (let x = 0; x < COVER_W; x += 2) ctx.fillRect(x, SCENE_H + 1, 1, 1);
  const lines = wrapTitle(String(title || 'UNTITLED').toUpperCase(), 21);
  const lineH = 7;
  const blockH = lines.length * lineH - 2;
  let ty = SCENE_H + Math.round((BAND_H - blockH) / 2);
  ctx.fillStyle = rgbCss(pal.text);
  for (const line of lines) {
    const wpx = line.length * 4 - 1;
    let x = Math.round((COVER_W - wpx) / 2);
    for (const ch of line) {
      const g = FONT3X5[ch];
      if (g) for (let r = 0; r < 5; r += 1) for (let c = 0; c < 3; c += 1) if (g[r * 3 + c] === '1') ctx.fillRect(x + c, ty + r, 1, 1);
      x += 4;
    }
    ty += lineH;
  }
  if (lines.length === 1) {
    const wpx = lines[0].length * 4 - 1;
    const dx = Math.round((COVER_W - wpx) / 2) - 7;
    if (dx >= 4) {
      drawDiamond(ctx, dx, SCENE_H + Math.floor(BAND_H / 2) - 1, rgbCss(pal.accent));
      drawDiamond(ctx, COVER_W - dx - 3, SCENE_H + Math.floor(BAND_H / 2) - 1, rgbCss(pal.accent));
    }
  }
}

/**
 * Pick the archetype + sky for a seed exactly as the browser pipeline does.
 * Returns { archetypeName, skyName, pal } so tests can drive painters headless.
 */
export function coverStyleForSeed(seed) {
  const arch = PIXEL_ARCHETYPES[(seed * 5 + (seed >> 3)) % PIXEL_ARCHETYPES.length];
  const skyName = arch.skies[Math.floor(seed / 8) % arch.skies.length];
  return { archetypeName: arch.name, skyName, pal: scenePalette(PIXEL_SKIES[skyName]) };
}
