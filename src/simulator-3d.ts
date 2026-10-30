import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS3DObject, CSS3DRenderer } from 'three/addons/renderers/CSS3DRenderer.js';
import { studioEnvironment, studioFloor } from './simulator-studio';
import { buildHardware, plate, roundedRect } from './simulator-hardware';
import { chosenFinish, modelSpec, type Finish, type ModelSpec } from './simulator-models';
import { buildDuo, DUO_FOLD, duoDisplays, type DuoModel, type DuoPose, type DuoSurface } from './simulator-duo';

export type { DuoPose } from './simulator-duo';

/* The simulator as a physical device: a lit, rotatable model whose display shows
 * the live frames. Dragging the frame or background orbits it; pressing the
 * display becomes taps, long presses and swipes in points; the side and home
 * buttons press their hardware counterparts. One unit is 100 points. */

/** For an iPhone Duo, `duo` holds both displays (inner in landscape points) and width/height are the active display's. */
export type DeviceShape = { width: number; height: number; homeButton: boolean; family: 'phone' | 'pad'; deviceType: string; duo?: { cover: { width: number; height: number }; inner: { width: number; height: number } } };
export type ScreenGesture =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'longPress'; x: number; y: number; durationMs: number }
  | { kind: 'swipe'; x: number; y: number; endX: number; endY: number; durationMs: number };
export type DeviceButton = 'home' | 'lock';
export type Device3D = {
  setShape(shape: DeviceShape): void;
  setFrame(image: CanvasImageSource & { width: number; height: number }): void;
  setMessage(text: string): void;
  /** A spinner on the display facing the user until the next frame or `setLoading(false)`. */
  setLoading(loading: boolean): void;
  setDark(dark: boolean): void;
  /** Repaint the body in one of the model's finishes. */
  setFinish(finish: Finish): void;
  resetView(animate?: boolean): void;
  /** Fold or unfold an iPhone Duo; a no-op for other devices. */
  setPose(pose: DuoPose, animate?: boolean): void;
  getPose(): DuoPose;
  setActive(active: boolean): void;
  /** A live page on the display: the element is laid out at the display's points and turns with the device. */
  setWeb(view: HTMLElement | null): void;
  dispose(): void;
};
type Options = {
  onGesture(gesture: ScreenGesture): void;
  onButton(button: DeviceButton): void;
  onScroll(dx: number, dy: number, at: { x: number; y: number }): void;
};

const UNIT = 100;
const TAP_SLOP = 8;
const LONG_PRESS = 450;
const FRONT = new THREE.Euler(0, 0, 0);
const INTRO = new THREE.Euler(0.12, -0.55, 0.02);
const FOLD_MS = 800;
/** The spinner turns in twelve steps a second and is painted at a quarter of the display's
 * texture size: repainting the full 2× texture every frame stalled the whole window. */
const SPIN_STEPS = 12, SPIN_SCALE = 0.5, FRAME_SCALE = 2;
// ponytail: unverified on Xcode 27.1 — a portrait inner screenshot is turned a quarter turn
// counterclockwise (its top to the display's left); calibrate against a live Duo.
const INNER_FRAME_TURN = -Math.PI / 2;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Proportions of the hardware around a display of `shape` points. */
function geometryOf(shape: DeviceShape) {
  const width = shape.width / UNIT, height = shape.height / UNIT, pad = shape.family === 'pad';
  const spec = modelSpec(shape.deviceType, shape.family);
  const side = spec.bezel ?? (pad ? 0.26 : shape.homeButton ? 0.22 : 0.17);
  const cap = shape.homeButton ? (pad ? 0.95 : 1.05) : side;
  const display = shape.homeButton ? 0 : spec.corner ?? (pad ? 0.19 : 0.55);
  const bodyWidth = width + side * 2;
  return { width, height, pad, side, cap, display, spec, body: { width: bodyWidth, height: height + cap * 2, radius: shape.homeButton ? (pad ? 0.45 : 0.62) : display + side, depth: Math.max(bodyWidth * spec.depth, 0.18) } };
}

export function mountDevice3D(host: HTMLElement, options: Options): Device3D {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Khronos PBR Neutral keeps product colors true (Cosmic Orange stays orange).
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  const canvas = renderer.domElement;
  canvas.className = 'sim-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);

  const scene = new THREE.Scene();
  const environment = studioEnvironment(renderer);
  scene.environment = environment;
  const floor = studioFloor(scene);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 200);
  const controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.09, enablePan: false, rotateSpeed: 0.75, zoomSpeed: 0.8 });

  // A display: frames are drawn into a canvas so orientation is the same in every webview.
  // A Duo's inner display has its own, so each display keeps its last picture.
  function canvasDisplay() {
    const pixels = document.createElement('canvas');
    pixels.width = 2; pixels.height = 2;
    const texture = new THREE.CanvasTexture(pixels);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    return { pixels, paint: pixels.getContext('2d')!, texture, material: new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }) };
  }
  type CanvasDisplay = ReturnType<typeof canvasDisplay>;
  const main = canvasDisplay(), inside = canvasDisplay();

  const device = new THREE.Group();
  scene.add(device);
  // Cover glass: black, glossy, and it reflects the studio across the bezel.
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x020203, metalness: 0, roughness: 0.04, ior: 1.52, envMapIntensity: 0.18 });
  // The same glass over the lit display: only its reflections are added on top of the picture.
  const glare = new THREE.MeshPhysicalMaterial({ color: 0x000000, metalness: 0, roughness: 0.04, envMapIntensity: 1, transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending });
  const ink = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const touchMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  let screen: THREE.Mesh | undefined, touch: THREE.Mesh | undefined, surfaces: DuoSurface[] = [];
  let duo: DuoModel | undefined, pose: DuoPose = 'closed', fold = DUO_FOLD.closed, folding: { from: number; to: number; start: number } | undefined;
  const buttons = new Map<THREE.Object3D, DeviceButton>();
  let shape: DeviceShape = { width: 402, height: 874, homeButton: false, family: 'phone', deviceType: '' };
  let finish: Finish | undefined, hardware: THREE.Material[] = [];
  let fitDistance = 20;
  // Web apps: a DOM layer over the canvas, its element posed on the display plate.
  let css: CSS3DRenderer | undefined, web: CSS3DObject | undefined;
  function placeWeb(): void {
    if (!web || !screen) return;
    const g = geometryOf(shape), element = web.element;
    element.style.width = `${shape.width}px`; element.style.height = `${shape.height}px`;
    element.style.setProperty('--sim-corner', `${g.display * UNIT}px`);
    web.scale.setScalar(1 / UNIT); web.position.set(0, 0, 0.0025);
    screen.add(web);
  }

  function clear(): void {
    device.traverse(node => { if (node instanceof THREE.Mesh) node.geometry.dispose(); });
    hardware.forEach(material => material.dispose()); hardware = [];
    duo?.dispose(); duo = undefined; surfaces = []; screen = touch = undefined;
    device.clear(); buttons.clear();
  }
  /** The display that faces the user and its size in points. */
  const activeSurfaces = (): DuoSurface[] => duo ? (pose === 'closed' ? [duo.cover] : duo.inner) : surfaces;
  function displayPoints(): { width: number; height: number } {
    if (!shape.duo) return shape;
    const displays = duoDisplays(shape.duo);
    return pose === 'closed' ? displays.cover : displays.inner;
  }
  function buildDuoBody(): void {
    const spec = modelSpec('iPhone-Duo', 'phone');
    finish = finish && spec.finishes.some(item => item.id === finish!.id) ? finish : chosenFinish(spec);
    duo = buildDuo(device, finish, duoDisplays(shape.duo), { cover: main.material, inner: inside.material, ink, glass, glare });
    duo.setFold(fold); lightCover();
    const displays = duoDisplays(shape.duo);
    sizeDisplay(main, displays.cover); sizeDisplay(inside, displays.inner);
    duo.buttons.forEach((name, mesh) => buttons.set(mesh, name));
    touch = new THREE.Mesh(new THREE.CircleGeometry(0.2, 32), touchMaterial);
    touch.position.z = 0.003; touch.renderOrder = 3; activeSurfaces()[0].mesh.add(touch);
    device.traverse(node => { if (node instanceof THREE.Mesh && !node.userData.noShadow && node.material !== glare && node.material !== touchMaterial) node.castShadow = true; });
    const { width, height } = duo.extent();
    floor.place(-height / 2, Math.max(width, height) * 1.6);
    fit();
  }
  /** A real Duo turns its cover display off while open. */
  const lightCover = () => main.material.color.setScalar(duo && pose !== 'closed' ? 0 : 1);
  function build(): void {
    clear();
    lightCover();
    if (shape.duo) { buildDuoBody(); return; }
    const g = geometryOf(shape), { body, spec } = g, bevel = Math.min(0.07, body.depth / 4);
    const look = finish && spec.finishes.some(item => item.id === finish!.id) ? finish : chosenFinish(spec);
    finish = look;
    const made = buildHardware(device, spec, look, body, { width: g.width, height: g.height, side: g.side, cap: g.cap }, ink);
    hardware = made.materials;
    const [frame, panel] = made.materials as THREE.MeshPhysicalMaterial[];
    const slab = new THREE.ExtrudeGeometry(roundedRect(body.width - bevel * 2, body.height - bevel * 2, body.radius - bevel), { depth: body.depth - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 8, curveSegments: 40 });
    slab.translate(0, 0, -(body.depth - bevel * 2) / 2);
    device.add(new THREE.Mesh(slab, [panel, frame]));
    const front = body.depth / 2;
    const cover = new THREE.Mesh(plate(body.width - bevel * 1.2, body.height - bevel * 1.2, body.radius - bevel * 0.6), glass);
    cover.position.z = front + 0.002; device.add(cover);
    screen = new THREE.Mesh(plate(g.width, g.height, g.display), main.material);
    screen.position.z = front + 0.004; device.add(screen);
    surfaces = [{ mesh: screen, u0: 0, u1: 1, width: g.width, height: g.height }];
    const sheen = new THREE.Mesh(plate(g.width, g.height, g.display), glare);
    sheen.position.z = 0.0015; sheen.renderOrder = 1; screen.add(sheen);
    touch = new THREE.Mesh(new THREE.CircleGeometry(0.2, 32), touchMaterial);
    touch.position.z = 0.003; touch.renderOrder = 2; screen.add(touch);
    // Android: a punch-hole camera centered near the top of the display.
    if (spec.front === 'punch') {
      const punch = new THREE.Mesh(new THREE.CircleGeometry(0.055, 32), ink);
      punch.position.set(0, g.height / 2 - 0.26, 0.001); screen.add(punch);
    }
    if (spec.front === 'island' && !shape.homeButton) {
      const island = new THREE.Mesh(plate(1.25, 0.37, 0.185), ink);
      island.position.set(0, g.height / 2 - 0.3, 0.001); screen.add(island);
    }
    if (shape.homeButton) {
      const home = new THREE.Mesh(new THREE.CylinderGeometry(g.pad ? 0.3 : 0.34, g.pad ? 0.3 : 0.34, 0.02, 48), glass);
      home.rotation.x = Math.PI / 2; home.position.set(0, -g.height / 2 - g.cap / 2, front + 0.004);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(g.pad ? 0.3 : 0.34, 0.012, 8, 64), frame);
      ring.position.set(0, -g.height / 2 - g.cap / 2, front + 0.012);
      device.add(home, ring); buttons.set(home, 'home');
    }
    made.buttons.forEach((name, mesh) => buttons.set(mesh, name));
    device.traverse(node => { if (node instanceof THREE.Mesh && node.material !== glare && node.material !== touchMaterial) node.castShadow = true; });
    floor.place(-Math.max(body.height, body.width) / 2, Math.max(body.height, body.width));
    placeWeb();
    fit();
  }

  let fitted = false;
  function fit(): void {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false); css?.setSize(width, height);
    camera.aspect = width / height;
    frameCamera();
  }
  /** Fit the posed device in view, keeping the user's zoom. */
  function frameCamera(): void {
    const body = duo ? duo.extent() : geometryOf(shape).body, half = THREE.MathUtils.degToRad(camera.fov / 2);
    const byHeight = (body.height / 2) / Math.tan(half), byWidth = (body.width / 2) / (Math.tan(half) * camera.aspect);
    const distance = Math.max(byHeight, byWidth) / 0.84;
    // Keep the user's zoom relative to the fitted distance across resizes.
    const zoom = fitted ? THREE.MathUtils.clamp(camera.position.length() / fitDistance, 0.45, 2.6) : 1;
    fitDistance = distance; fitted = true;
    controls.minDistance = distance * 0.45; controls.maxDistance = distance * 2.6;
    if (!camera.position.lengthSq()) camera.position.set(0, 0, 1);
    camera.position.setLength(distance * zoom);
    camera.updateProjectionMatrix(); dirty = true;
  }

  /* Rendering runs only while visible and stops when nothing moves. */
  let frame = 0, dirty = true, active = false, turning: { from: THREE.Quaternion; to: THREE.Quaternion; start: number; duration: number } | undefined;
  let touchFade = 0, loading = false, spinStep = -1;
  const tick = (now: number) => {
    frame = 0;
    if (!active) return;
    let moving = controls.update();
    const step = Math.floor((now / 1000) * SPIN_STEPS);
    if (loading && step !== spinStep) { spinStep = step; paintSpinner(step); dirty = true; }
    if (folding) {
      const t = Math.min(1, (now - folding.start) / FOLD_MS), eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      fold = THREE.MathUtils.lerp(folding.from, folding.to, eased);
      duo?.setFold(fold); frameCamera();
      if (t >= 1) folding = undefined;
      moving = true;
    }
    if (turning) {
      const t = Math.min(1, (now - turning.start) / turning.duration), eased = 1 - Math.pow(1 - t, 3);
      device.quaternion.slerpQuaternions(turning.from, turning.to, eased);
      if (t >= 1) turning = undefined;
      moving = true;
    }
    if (touchFade && touchMaterial.opacity > 0) { touchMaterial.opacity = Math.max(0, touchMaterial.opacity - 0.06); moving = true; }
    if (moving || dirty) { renderer.render(scene, camera); css?.render(scene, camera); dirty = false; }
    // Idle, nothing is drawn or scheduled; `wake` starts the loop again.
    if (moving || loading) frame = requestAnimationFrame(tick);
  };
  const wake = () => { dirty = true; if (active && !frame) frame = requestAnimationFrame(tick); };
  controls.addEventListener('change', wake);

  function turnTo(euler: THREE.Euler, duration: number): void {
    const to = new THREE.Quaternion().setFromEuler(euler);
    if (reduceMotion() || !duration) { device.quaternion.copy(to); turning = undefined; wake(); return; }
    turning = { from: device.quaternion.clone(), to, start: performance.now(), duration }; wake();
  }

  /* Picking: the display maps to points; buttons press hardware; anything else orbits. */
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2();
  function ray(event: { clientX: number; clientY: number }): void {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
  }
  /** A point on a display plate, through its UVs, in the active display's points. */
  function toPoints(surface: DuoSurface, local: THREE.Vector3): { x: number; y: number } {
    const size = displayPoints();
    const u = surface.u0 + (local.x / surface.width + 0.5) * (surface.u1 - surface.u0), v = local.y / surface.height + 0.5;
    return { x: THREE.MathUtils.clamp(u * size.width, 0, size.width), y: THREE.MathUtils.clamp((1 - v) * size.height, 0, size.height) };
  }
  const normalOf = (mesh: THREE.Object3D) => new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.getWorldQuaternion(new THREE.Quaternion()));
  function pick(event: { clientX: number; clientY: number }): { kind: 'screen'; surface: DuoSurface; point: { x: number; y: number }; local: THREE.Vector3 } | { kind: 'button'; name: DeviceButton; mesh: THREE.Object3D } | undefined {
    if (!screen && !duo) return;
    ray(event);
    const hit = raycaster.intersectObjects(duo ? duo.pickables : device.children, false)[0];
    if (!hit) return;
    // The bend at the hinge belongs to the inner half it is nearer.
    const bend = duo && pose !== 'closed' && hit.object === duo.bend ? duo.inner[(hit.uv?.x ?? 0.5) < 0.5 ? 0 : 1] : undefined;
    const surface = bend ?? activeSurfaces().find(item => item.mesh === hit.object);
    if (surface) {
      // Only a display that looks at the camera, and not mid-fold, is a touch surface.
      if (folding || normalOf(surface.mesh).dot(raycaster.ray.direction) >= 0) return;
      const local = surface.mesh.worldToLocal(hit.point.clone());
      return { kind: 'screen', surface, point: toPoints(surface, local), local };
    }
    const name = buttons.get(hit.object);
    return name ? { kind: 'button', name, mesh: hit.object } : undefined;
  }
  /** Where the pointer meets the display's plane, even past its edge, while a finger is down. */
  function onPlane(event: { clientX: number; clientY: number }, surface: DuoSurface): { x: number; y: number; local: THREE.Vector3 } | undefined {
    ray(event);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normalOf(surface.mesh), surface.mesh.getWorldPosition(new THREE.Vector3()));
    const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!point) return;
    const local = surface.mesh.worldToLocal(point);
    return { ...toPoints(surface, local), local };
  }
  function showTouch(surface: DuoSurface, local: THREE.Vector3, opacity: number): void {
    if (!touch) return;
    if (touch.parent !== surface.mesh) surface.mesh.add(touch);
    touch.position.set(local.x, local.y, 0.002);
    touchMaterial.opacity = opacity; touchFade = opacity < 0.3 ? 1 : 0; wake();
  }

  let gesture: { id: number; surface: DuoSurface; start: { x: number; y: number }; last: { x: number; y: number }; at: number } | undefined;
  /** The web app takes its own pointer and wheel events. */
  const onWeb = (event: Event) => Boolean(css && event.target instanceof Node && css.domElement.contains(event.target));
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || onWeb(event)) return;
    const hit = pick(event);
    if (!hit) return;
    // Handled here, before OrbitControls on the canvas sees the press.
    event.stopPropagation(); event.preventDefault();
    host.focus({ preventScroll: true });
    if (hit.kind === 'button') {
      const original = hit.mesh.position.clone(), inward = hit.mesh.position.x === 0 ? new THREE.Vector3(0, -0.03, 0) : new THREE.Vector3(Math.sign(hit.mesh.position.x) * -0.03, 0, 0);
      if (hit.name === 'home') inward.set(0, 0, -0.01);
      hit.mesh.position.add(inward); wake();
      window.setTimeout(() => { hit.mesh.position.copy(original); wake(); }, 140);
      options.onButton(hit.name); return;
    }
    canvas.setPointerCapture(event.pointerId);
    gesture = { id: event.pointerId, surface: hit.surface, start: hit.point, last: hit.point, at: performance.now() };
    showTouch(hit.surface, hit.local, 0.42);
  };
  const onMove = (event: PointerEvent) => {
    if (gesture && event.pointerId === gesture.id) {
      const at = onPlane(event, gesture.surface); if (!at) return;
      gesture.last = { x: at.x, y: at.y }; showTouch(gesture.surface, at.local, 0.42); return;
    }
    if (event.buttons) return;
    const hit = pick(event);
    canvas.style.cursor = hit?.kind === 'screen' ? 'pointer' : hit?.kind === 'button' ? 'pointer' : 'grab';
  };
  const onUp = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.id) return;
    const { start, last, at } = gesture; gesture = undefined;
    const held = performance.now() - at, moved = Math.hypot(last.x - start.x, last.y - start.y);
    touchFade = 1;
    if (event.type === 'pointercancel' || folding) return;
    if (moved < TAP_SLOP) options.onGesture(held >= LONG_PRESS ? { kind: 'longPress', x: start.x, y: start.y, durationMs: Math.round(held) } : { kind: 'tap', x: start.x, y: start.y });
    else options.onGesture({ kind: 'swipe', x: start.x, y: start.y, endX: last.x, endY: last.y, durationMs: Math.round(THREE.MathUtils.clamp(held, 80, 2000)) });
  };
  /* The wheel scrolls the app over the display and zooms elsewhere; pinch always zooms. */
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || onWeb(event)) return;
    const hit = pick(event);
    if (hit?.kind !== 'screen') return;
    event.stopPropagation(); event.preventDefault();
    options.onScroll(event.deltaX, event.deltaY, hit.point);
  };
  const onDouble = (event: MouseEvent) => { if (!onWeb(event) && !pick(event)) { resetView(true); } };
  host.addEventListener('pointerdown', onDown, { capture: true });
  host.addEventListener('wheel', onWheel, { capture: true, passive: false });
  host.addEventListener('dblclick', onDouble);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  const resize = new ResizeObserver(() => fit());
  resize.observe(host);

  /** The display texture stays at 2× points; resizing a live texture's canvas leaves the GPU copy at its old size. */
  function sizeDisplay(display: CanvasDisplay, size: { width: number; height: number }, scale = FRAME_SCALE): void {
    const width = Math.round(size.width * scale), height = Math.round(size.height * scale);
    if (display.pixels.width === width && display.pixels.height === height) return;
    display.pixels.width = width; display.pixels.height = height;
    display.texture.dispose();
  }
  /** The canvas of the display facing the user, at its size. */
  function activeDisplay(scale = FRAME_SCALE): CanvasDisplay {
    const display = duo && pose !== 'closed' ? inside : main;
    sizeDisplay(display, displayPoints(), scale);
    return display;
  }
  function setMessage(text: string): void {
    loading = false;
    const { pixels, paint, texture } = activeDisplay();
    paint.fillStyle = '#000'; paint.fillRect(0, 0, pixels.width, pixels.height);
    if (text) {
      paint.fillStyle = 'rgba(255,255,255,.62)'; paint.textAlign = 'center'; paint.textBaseline = 'middle';
      paint.font = `500 ${Math.round(pixels.width / 15)}px -apple-system, BlinkMacSystemFont, sans-serif`;
      paint.fillText(text, pixels.width / 2, pixels.height / 2, pixels.width * 0.86);
    }
    texture.needsUpdate = true; wake();
  }
  /** A looping status spinner: twelve spokes, the brightest one turning once a second. */
  function paintSpinner(step: number): void {
    const { pixels, paint, texture } = activeDisplay(SPIN_SCALE);
    const cx = pixels.width / 2, cy = pixels.height / 2, radius = Math.min(pixels.width, pixels.height) / 18, lead = step % SPIN_STEPS;
    paint.fillStyle = '#000'; paint.fillRect(0, 0, pixels.width, pixels.height);
    paint.lineWidth = radius / 4; paint.lineCap = 'round';
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2, sin = Math.sin(angle), cos = Math.cos(angle);
      paint.strokeStyle = `rgba(255,255,255,${0.15 + 0.7 * (1 - ((lead - i + 12) % 12) / 11)})`;
      paint.beginPath(); paint.moveTo(cx + sin * radius * 0.5, cy - cos * radius * 0.5); paint.lineTo(cx + sin * radius, cy - cos * radius); paint.stroke();
    }
    texture.needsUpdate = true;
  }
  function resetView(animate = true): void {
    camera.position.set(0, 0, fitDistance); controls.target.set(0, 0, 0); controls.update();
    turnTo(FRONT, animate ? 520 : 0);
  }

  build();
  device.quaternion.setFromEuler(INTRO);
  setMessage('');

  return {
    setShape(next) {
      const same = next.homeButton === shape.homeButton && next.family === shape.family && next.deviceType === shape.deviceType && JSON.stringify(next.duo) === JSON.stringify(shape.duo);
      if (same && next.width === shape.width && next.height === shape.height) return;
      const wasDuo = Boolean(shape.duo);
      shape = next;
      // A Duo announcing its other display keeps its model; the panel follows with setPose.
      if (same && next.duo) { activeDisplay(); wake(); return; }
      if (!next.duo || !wasDuo || !same) { pose = 'closed'; fold = DUO_FOLD.closed; folding = undefined; sizeDisplay(inside, { width: 1, height: 1 }); }
      build(); wake();
    },
    setFrame(image) {
      loading = false;
      const { pixels, paint, texture } = activeDisplay();
      // Frames arrive at whatever scale the producer chose; each one fills the display.
      // A Duo's inner screenshot may arrive portrait for the landscape display: turn it a quarter.
      if (pixels === inside.pixels && (image.width > image.height) !== (pixels.width > pixels.height)) {
        paint.save(); paint.translate(pixels.width / 2, pixels.height / 2); paint.rotate(INNER_FRAME_TURN);
        paint.drawImage(image, -pixels.height / 2, -pixels.width / 2, pixels.height, pixels.width); paint.restore();
      } else paint.drawImage(image, 0, 0, pixels.width, pixels.height);
      texture.needsUpdate = true; wake();
    },
    setMessage,
    setLoading(next) { loading = next; spinStep = -1; wake(); },
    setDark() { wake(); },
    setFinish(next) { finish = next; build(); wake(); },
    resetView,
    setPose(next, animate = true) {
      if (!duo || next === pose) return;
      pose = next; gesture = undefined; lightCover();
      const to = DUO_FOLD[next];
      if (!animate || reduceMotion()) { fold = to; folding = undefined; duo.setFold(fold); frameCamera(); wake(); return; }
      folding = { from: fold, to, start: performance.now() }; wake();
    },
    getPose: () => pose,
    setWeb(view) {
      if (web) { web.removeFromParent(); web.element.remove(); web = undefined; }
      if (view) {
        if (!css) {
          css = new CSS3DRenderer(); css.domElement.className = 'sim-css';
          host.append(css.domElement); fit();
        }
        web = new CSS3DObject(view); placeWeb();
      }
      if (css) css.domElement.hidden = !web;
      wake();
    },
    setActive(next) {
      if (active === next) return;
      active = next;
      if (active) { fit(); if (device.quaternion.angleTo(new THREE.Quaternion()) > 0.3 && !turning) turnTo(FRONT.clone().set(0.04, -0.18, 0), 900); wake(); }
      else if (frame) { cancelAnimationFrame(frame); frame = 0; }
    },
    dispose() {
      active = false; if (frame) cancelAnimationFrame(frame);
      resize.disconnect(); controls.dispose(); web?.element.remove(); css?.domElement.remove(); clear();
      host.removeEventListener('pointerdown', onDown, { capture: true });
      host.removeEventListener('wheel', onWheel, { capture: true });
      host.removeEventListener('dblclick', onDouble);
      for (const material of [glass, glare, ink, main.material, inside.material, touchMaterial]) material.dispose();
      floor.dispose();
      main.texture.dispose(); inside.texture.dispose(); environment.dispose(); renderer.dispose(); canvas.remove();
    },
  };
}
