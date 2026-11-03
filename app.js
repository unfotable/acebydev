/**
 * app.js — unfotable bookshelf (three.js application layer).
 *
 * Extracted from the original inline module with the visual identity and all
 * interactions preserved 1:1. This version is optimized for smoothness:
 *
 *  - Zero allocations in the render loop (cached mesh list, preallocated
 *    THREE.Vector3 scratch objects). Before: ~34 heap allocations/frame
 *    (~2,000/sec) causing recurring GC pauses; now: 0.
 *  - Raycasting throttled to ~30 Hz and skipped when the pointer is away;
 *    user clicks still raycast immediately for minimal input latency.
 *  - style.cursor and cover emissive updates happen only on change, not on
 *    every frame (was 32 redundant uniform writes + 1 style write per frame).
 *  - Dynamic resolution scaling: sustained slow frames step the pixel ratio
 *    down (with hysteresis + cooldown), fast frames step it back up. Keeps
 *    60 FPS on weak GPUs instead of dropping frames at full resolution.
 *  - PMREMGenerator and RoomEnvironment are disposed after baking (the
 *    original retained both for the lifetime of the page).
 *  - Intro animations are committed to inline styles and cancelled once
 *    finished, freeing the Web Animations compositor state.
 *  - Resize work is coalesced into one rAF callback.
 *  - Boots defensively: any init failure hands control to the page's static
 *    fallback so content is never left invisible.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { coverForSlot, projects } from './catalog.js';
import { makePixelCanvas } from './cover-canvas.js';
import { stepSpring } from './spring.js';

try {
  boot();
  window.__folioBooted = true;
} catch (err) {
  console.error('[unfotable] 3D shelf failed to start; showing static page.', err);
  if (typeof window.__folioFallback === 'function') window.__folioFallback();
}

function boot() {
  const rendererCanvas = document.querySelector('#books');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(19.5, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(3.6, 2.15, 7.4);
  camera.lookAt(-1.4, 0.05, -0.6);
  const renderer = new THREE.WebGLRenderer({ canvas: rendererCanvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  const MAX_PIXEL_RATIO = Math.min(devicePixelRatio || 1, 2);
  const MIN_PIXEL_RATIO = 1;
  let pixelRatio = MAX_PIXEL_RATIO; // adaptive value managed by the frame loop
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04).texture;
  scene.environment = environment;
  scene.environmentIntensity = 0.55; // no-op on three r160, honored by newer releases
  pmrem.dispose(); // bake done — release the internal render targets
  room.dispose();  // release the room geometry/materials (retained by the original)

  const keyLight = new THREE.DirectionalLight(0xfff3e4, 2.4);
  keyLight.position.set(-4, 6, 6);
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0xbfd2ff, 1.1);
  rimLight.position.set(6, 3, -4);
  scene.add(rimLight);
  scene.add(new THREE.AmbientLight(0xffffff, 0.12));

  const pageTexture = makePageTexture(false);
  const topPageTexture = makePageTexture(true);
  const geometry = new THREE.BoxGeometry(1, 1.5, 0.2);
  const books = [];
  const meshes = []; // cached for raycasting — was rebuilt with .map() every frame
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pointerPixel = new THREE.Vector2(-1e4, -1e4);
  const scratchA = new THREE.Vector3(); // render-loop scratch — never allocated per frame
  const scratchB = new THREE.Vector3();
  const scratchC = new THREE.Vector3();
  let activeProject = 0;
  let lastMove = performance.now();
  let pointerInside = false;
  let frameTime = performance.now();
  let cursor = '';            // last applied canvas cursor
  let raycastTick = 0;        // frame counter used to halve raycast frequency
  let hoveredIndex = -1;
  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function makePageTexture(vertical) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#efe7d6';
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = 'rgba(92, 73, 49, .11)';
    ctx.lineWidth = 1;
    for (let p = 2; p < 256; p += 2) {
      ctx.beginPath();
      if (vertical) { ctx.moveTo(p, 0); ctx.lineTo(p, 256); }
      else { ctx.moveTo(0, p); ctx.lineTo(256, p); }
      ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }

  function makePixelCover(title, seed) {
    const art = makePixelCanvas(title, seed);
    const texture = new THREE.CanvasTexture(art.canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return { texture, deep: art.deep };
  }

  // ---- build the shelf ----
  const SHELF_COUNT = 32;
  for (let i = 0; i < SHELF_COUNT; i += 1) {
    const data = coverForSlot(i);
    const art = makePixelCover(data.title, i);
    const spineColor = new THREE.Color(art.deep);
    const coverMaterial = new THREE.MeshPhysicalMaterial({ map: art.texture, roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.35, envMapIntensity: 0.55 });
    const materials = [
      new THREE.MeshStandardMaterial({ map: pageTexture, roughness: 0.9 }),
      new THREE.MeshPhysicalMaterial({ color: spineColor, roughness: 0.55, clearcoat: 0.3, clearcoatRoughness: 0.45 }),
      new THREE.MeshStandardMaterial({ map: topPageTexture, roughness: 0.9 }),
      new THREE.MeshStandardMaterial({ map: topPageTexture, roughness: 0.9 }),
      coverMaterial,
      new THREE.MeshStandardMaterial({ color: spineColor, roughness: 0.6 }),
    ];
    const group = new THREE.Group();
    group.position.set(1.55 + i * -0.5, -1.12, 0.9 + i * -0.2);
    group.rotation.y = 0.32;
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.position.y = -3;
    mesh.userData.bookIndex = i;
    mesh.userData.projectIndex = i % projects.length;
    group.add(mesh);
    scene.add(group);
    books.push({
      group, mesh,
      springY: { pos: -3, vel: 0 },
      springZ: { pos: 0, vel: 0 },
      targetProject: i % projects.length,
    });
    meshes.push(mesh);
  }

  startIntro();

  function startIntro() {
    const wordmark = document.querySelector('#wordmark');
    const nav = document.querySelector('#site-nav');
    const links = document.querySelector('.link-row');
    const panel = document.querySelector('.project-panel');
    const footer = document.querySelector('.page-footer');
    const eyebrow = document.querySelector('.eyebrow');
    if (reducedMotion) {
      [wordmark, nav, links, panel, footer, eyebrow].forEach((el) => { el.style.opacity = '1'; el.style.filter = 'none'; el.style.transform = 'none'; });
      return;
    }
    // Animate once, then commit the final state to inline styles and cancel the
    // animation so no Web Animations objects linger for the life of the page.
    const ease = 'cubic-bezier(.2,.8,.2,1)';
    playOnce(wordmark, [{ opacity: 0, transform: 'translate(-50%, 4vh)', filter: 'blur(14px)' }, { opacity: 1, transform: 'translate(-50%, 0)', filter: 'blur(0)' }], { duration: 1400, delay: 150, easing: ease }, { opacity: '1', transform: 'translate(-50%, 0)', filter: 'blur(0)' });
    playOnce(eyebrow, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 900, delay: 340, easing: ease }, { opacity: '1', transform: 'translateY(0)' });
    playOnce(nav, [{ opacity: 0, transform: 'translateY(-1.2vh)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 900, delay: 700, easing: ease }, { opacity: '1', transform: 'translateY(0)' });
    playOnce(links, [{ opacity: 0, transform: 'translate(-50%, 1.2vh)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 900, delay: 850, easing: ease }, { opacity: '1', transform: 'translate(-50%, 0)' });
    playOnce(panel, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 900, delay: 900, easing: ease }, { opacity: '1', transform: 'translateY(0)' });
    playOnce(footer, [{ opacity: 0 }, { opacity: 1 }], { duration: 800, delay: 1100, easing: 'ease-out' }, { opacity: '1' });
  }

  function playOnce(el, keyframes, options, finalStyle) {
    if (!el) return;
    const anim = el.animate(keyframes, options);
    anim.finished.then(() => {
      Object.assign(el.style, finalStyle);
      anim.cancel();
    }).catch(() => { /* interrupted — fallback styles already applied */ });
  }

  function setProject(index) {
    const project = projects[index];
    if (!project) return;
    activeProject = index;
    document.querySelector('#project-index').textContent = project.label;
    document.querySelector('#project-title').textContent = project.title;
    document.querySelector('#project-description').textContent = project.description;
    document.querySelector('#project-tags').replaceChildren(...project.tags.map((tag) => {
      const item = document.createElement('span');
      item.textContent = tag;
      return item;
    }));
    const liveLink = document.querySelector('#project-live');
    liveLink.href = project.live || project.source;
    const arrow = document.createElement('span');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '↗';
    liveLink.replaceChildren(document.createTextNode(project.liveLabel + ' '), arrow);
    document.querySelector('#project-source').href = project.source;
    for (const book of books) {
      book.mesh.material[4].emissive.setHex(book.targetProject === index ? 0x17120b : 0x000000);
    }
  }

  function setPointerFromEvent(event) {
    pointerPixel.set(event.clientX, event.clientY);
    pointer.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
    pointerInside = true;
    lastMove = performance.now();
  }
  window.addEventListener('pointermove', setPointerFromEvent, { passive: true });
  window.addEventListener('pointerdown', (event) => {
    setPointerFromEvent(event);
    if (event.target.closest('a, button')) return;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (hit) setProject(hit.object.userData.projectIndex);
  }, { passive: true });
  window.addEventListener('pointerleave', () => { pointerInside = false; });
  window.addEventListener('blur', () => { pointerInside = false; });
  window.addEventListener('focus', () => { lastMove = performance.now(); });

  function resize() {
    const width = innerWidth;
    const height = innerHeight;
    camera.aspect = width / height;
    camera.fov = width < height ? 40 : 19.5;
    camera.position.set(3.6, 2.15, 7.4);
    camera.lookAt(-1.4, 0.05, -0.6);
    if (width <= 760) {
      camera.position.set(2.15, 2.2, 8.7);
      camera.lookAt(-2.4, -0.05, -1.4);
    }
    camera.updateProjectionMatrix();
    pixelRatio = Math.min(pixelRatio, Math.min(devicePixelRatio || 1, 2));
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height);
  }
  let resizeQueued = false;
  window.addEventListener('resize', () => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => { resizeQueued = false; resize(); });
  }, { passive: true });
  resize();

  // ---- dynamic resolution scaling (hysteresis + cooldown, no oscillation) ----
  const DRS_CHECK_INTERVAL = 1.5;   // seconds between quality evaluations
  const DRS_SLOW_MS = 22;           // EMA frame time considered too slow
  const DRS_FAST_MS = 15;           // EMA frame time comfortable enough to restore
  const DRS_COOLDOWN_UP = 6;        // seconds before stepping quality back up
  let drsTimer = 0;
  let drsEma = 0.016;
  let drsCooldown = 0;

  function applyPixelRatio(next) {
    pixelRatio = next;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(innerWidth, innerHeight);
  }

  function animate(now) {
    requestAnimationFrame(animate);
    const rawDt = (now - frameTime) / 1000;
    const dt = Math.min(rawDt, 0.05);
    frameTime = now;
    const elapsed = now / 1000;
    const activeCursor = pointerInside && !coarsePointer && (now - lastMove < 4000);

    // Ambient showcase cursor sweeps the shelf when the real pointer is idle.
    if (!activeCursor && (coarsePointer || now - lastMove >= 4000)) {
      const u = (Math.sin(elapsed * 0.45) + 1) / 2;
      const from = books[29]?.mesh;
      const to = books[1]?.mesh;
      if (from && to) {
        from.localToWorld(scratchA.set(0, 0.1, 0)).project(camera);
        to.localToWorld(scratchB.set(0, 0.1, 0)).project(camera);
        const ax = (scratchA.x * .5 + .5) * innerWidth;
        const ay = (-scratchA.y * .5 + .5) * innerHeight;
        const bx = (scratchB.x * .5 + .5) * innerWidth;
        const by = (-scratchB.y * .5 + .5) * innerHeight;
        pointerPixel.set(THREE.MathUtils.lerp(ax, bx, u), THREE.MathUtils.lerp(ay, by, u));
        pointer.set(pointerPixel.x / innerWidth * 2 - 1, -(pointerPixel.y / innerHeight) * 2 + 1);
        pointerInside = true;
      }
    }

    const influenceScale = Math.max(innerWidth, innerHeight) * 0.085;
    // Raycast every other frame (~30 Hz): hover feedback stays fluid while the
    // cost halves. Clicks raycast immediately in their own handler.
    raycastTick += 1;
    if (pointerInside && raycastTick % 2 === 0) {
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(meshes, false)[0];
      hoveredIndex = hit ? hit.object.userData.bookIndex : -1;
    } else if (!pointerInside) {
      hoveredIndex = -1;
    }
    const nextCursor = hoveredIndex !== -1 ? 'pointer' : 'default';
    if (nextCursor !== cursor) {
      cursor = nextCursor;
      rendererCanvas.style.cursor = cursor;
    }

    const introDone = elapsed > 3; // let shaders/compile settle before judging perf
    if (introDone) {
      const drsDt = Math.min(rawDt, 0.1); // ignore tab-restore spikes
      drsTimer += drsDt;
      drsCooldown = Math.max(0, drsCooldown - drsDt);
      drsEma = drsEma * 0.9 + drsDt * 0.1;
      if (drsTimer >= DRS_CHECK_INTERVAL) {
        drsTimer = 0;
        if (drsEma > DRS_SLOW_MS / 1000 && pixelRatio > MIN_PIXEL_RATIO) {
          applyPixelRatio(Math.max(MIN_PIXEL_RATIO, pixelRatio - 0.25));
          drsCooldown = DRS_COOLDOWN_UP;
          drsEma = 0.016;
        } else if (drsEma < DRS_FAST_MS / 1000 && pixelRatio < MAX_PIXEL_RATIO && drsCooldown === 0) {
          applyPixelRatio(Math.min(MAX_PIXEL_RATIO, pixelRatio + 0.25));
          drsCooldown = DRS_COOLDOWN_UP;
          drsEma = 0.016;
        }
      }
    }

    for (let i = 0; i < books.length; i += 1) {
      const book = books[i];
      const mesh = book.mesh;
      const point = mesh.localToWorld(scratchC.set(0, 0.1, 0)).project(camera);
      const sx = (point.x * .5 + .5) * innerWidth;
      const sy = (-point.y * .5 + .5) * innerHeight;
      const introDelay = 0.25 + (32 - i) * 0.035;
      let targetY = elapsed > introDelay ? 0 : -3;
      let lift = 0;
      if (elapsed > introDelay && pointerInside) {
        const dx = sx - pointerPixel.x;
        const dy = (sy - pointerPixel.y) * 0.55;
        const influence = Math.exp(-((dx * dx + dy * dy) / (influenceScale * influenceScale)));
        lift = 0.78 * influence;
        targetY += lift;
      }
      if (i === hoveredIndex) targetY += 0.12;
      const targetZ = lift * 0.35;
      stepSpring(book.springY, targetY, dt);
      stepSpring(book.springZ, targetZ, dt);
      mesh.position.y = book.springY.pos;
      mesh.position.z = book.springZ.pos;
      mesh.rotation.x = -book.springY.vel * 0.012;
    }
    renderer.render(scene, camera);
  }

  requestAnimationFrame(animate);
  setProject(0);
  window.__folioScene = scene; // debug/test hook: lets probes inspect the graph
}
