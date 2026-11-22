import { ref, watch, onUnmounted, type Ref, readonly } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildPadModel, KNOB_IDS, KNOB_SPEC, TOP_Y, type PadModel } from '@/three/padModel';
import type { Orientation, LayerLightingConfig } from '@shared/types';

// ─── Spring physics ────────────────────────────────────────────

interface Spring { value: number; target: number; vel: number }

function spring(v = 0): Spring { return { value: v, target: v, vel: 0 }; }

function tick(s: Spring, stiff: number, damp: number, dt: number) {
  const f = -stiff * (s.value - s.target) - damp * s.vel;
  s.vel += f * dt;
  s.value += s.vel * dt;
}

const SK = 220;   // default stiffness
const SD = 22;    // default damping
const FK = 350;   // flash stiffness (faster decay)
const FD = 28;

// ─── Composable ────────────────────────────────────────────────

export function usePadScene(
  container: Ref<HTMLElement | null>,
  physicalRows: Ref<number[][]>,
) {
  const hoveredPart = ref<string | null>(null);
  const hoveredZone = ref<string | null>(null);
  const selectedPart = ref<string | null>(null);

  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let camera: THREE.PerspectiveCamera | null = null;
  let controls: OrbitControls | null = null;
  let model: PadModel | null = null;
  let animId = 0;
  let disposed = false;
  let ready = false;
  const clock = new THREE.Clock();

  // Springs per key/knob id ("K1" … "K12", "big", "mid", "small")
  const yOffsets = new Map<string, Spring>();     // press / explode Y
  const hoverY = new Map<string, Spring>();       // hover lift
  const hoverEm = new Map<string, Spring>();      // hover glow
  const emSprings = new Map<string, Spring>();    // selection glow
  const flashEm = new Map<string, Spring>();      // hardware flash
  const knobRot = new Map<string, Spring>();      // knob rotation
  const plateLift = spring();

  const restY = new Map<string, number>();

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  // Click-vs-drag tracking
  let downX = 0, downY = 0;
  type HitResult =
    | { type: 'key'; keyNum: number }
    | { type: 'knob'; knobId: string; zone: 'left' | 'right' | 'press' }
    | null;
  let downHit: HitResult = null;

  // Deferred init state (orientation / colors to apply once scene is up)
  let pendingOrientation: Orientation | null = null;
  let pendingLighting: LayerLightingConfig | undefined;

  function getSpring(map: Map<string, Spring>, key: string): Spring {
    let s = map.get(key);
    if (!s) { s = spring(); map.set(key, s); }
    return s;
  }

  // ── Init ────────────────────────────────────────────────────

  function init(el: HTMLElement) {
    const { clientWidth: w, clientHeight: h } = el;
    if (w === 0 || h === 0) return;

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    el.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0d0d);

    camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2.15;
    controls.minDistance = 3;
    controls.maxDistance = 15;
    controls.update();

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight.position.set(3, 8, 5);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(1024, 1024);
    dirLight.shadow.camera.near = 1;
    dirLight.shadow.camera.far = 20;
    const s = 5;
    dirLight.shadow.camera.left = -s;
    dirLight.shadow.camera.right = s;
    dirLight.shadow.camera.top = s;
    dirLight.shadow.camera.bottom = -s;
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0xaaccff, 0.2);
    fillLight.position.set(-3, 2, -3);
    scene.add(fillLight);

    rebuildModel();

    const canvas = renderer.domElement;
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    el.addEventListener('keydown', onKeyDown);
    new ResizeObserver(onResize).observe(el);

    ready = true;

    // Apply anything that was queued before init
    if (pendingOrientation !== null) setOrientation(pendingOrientation);
    if (pendingLighting !== undefined) updateColors(pendingLighting);

    frameModel();

    clock.start();
    animate();
  }

  function rebuildModel() {
    if (model) { model.dispose(); scene!.remove(model.group); }
    model = buildPadModel(physicalRows.value);
    scene!.add(model.group);

    yOffsets.clear(); hoverY.clear(); hoverEm.clear();
    emSprings.clear(); flashEm.clear(); knobRot.clear();
    restY.clear();
    plateLift.target = 0; plateLift.value = 0; plateLift.vel = 0;

    model.keys.forEach((mesh, keyNum) => {
      restY.set(`K${keyNum}`, mesh.position.y);
    });
    model.knobs.forEach((g, id) => {
      restY.set(id, g.position.y);
    });
  }

  // ── Resize ──────────────────────────────────────────────────

  function onResize() {
    if (!container.value || !renderer || !camera) return;
    const { clientWidth: w, clientHeight: h } = container.value;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  // ── Raycasting ──────────────────────────────────────────────

  function pickableObjects(): THREE.Object3D[] {
    if (!model) return [];
    const objs: THREE.Object3D[] = [];
    model.keys.forEach(m => objs.push(m));
    model.knobs.forEach(g => {
      g.children.forEach(c => { if ((c as THREE.Mesh).isMesh) objs.push(c); });
    });
    return objs;
  }

  function hitTest(x: number, y: number): HitResult {
    if (!camera || !model || !renderer) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((x - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((y - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickableObjects(), false);
    if (hits.length === 0) return null;

    const obj = hits[0].object;
    const ud = obj.userData;
    if (ud.type === 'key') return { type: 'key', keyNum: ud.keyNum };
    if (ud.type === 'knob') {
      const spec = KNOB_SPEC[ud.knobId];
      const localPt = obj.parent!.worldToLocal(hits[0].point.clone());
      const dist = Math.hypot(localPt.x, localPt.z);
      let zone: 'left' | 'right' | 'press' = 'press';
      if (dist > spec.r * 0.3) zone = localPt.x < 0 ? 'left' : 'right';
      return { type: 'knob', knobId: ud.knobId, zone };
    }
    return null;
  }

  // ── Pointer events ──────────────────────────────────────────

  function onPointerMove(e: PointerEvent) {
    const hit = hitTest(e.clientX, e.clientY);
    const prevHovered = hoveredPart.value;

    if (!hit) {
      hoveredPart.value = null;
      hoveredZone.value = null;
      renderer!.domElement.style.cursor = '';
    } else {
      renderer!.domElement.style.cursor = 'pointer';
      if (hit.type === 'key') {
        hoveredPart.value = `K${hit.keyNum}`;
        hoveredZone.value = null;
      } else {
        hoveredPart.value = hit.knobId;
        hoveredZone.value = hit.zone;
      }
    }

    // Update hover springs when the hovered part changes
    if (hoveredPart.value !== prevHovered) {
      applyHover(hoveredPart.value);
    }
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    downX = e.clientX;
    downY = e.clientY;
    downHit = hitTest(e.clientX, e.clientY);

    if (downHit) {
      // Immediate visual press feedback
      if (downHit.type === 'key') {
        animatePress(`K${downHit.keyNum}`, -0.12);
      } else if (downHit.zone === 'press') {
        animatePress(downHit.knobId, -0.08);
      } else {
        animateKnobTurn(downHit.knobId, downHit.zone);
      }
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (e.button !== 0) return;
    const dx = e.clientX - downX;
    const dy = e.clientY - downY;
    const wasDrag = dx * dx + dy * dy > 36;

    if (wasDrag) {
      downHit = null;
      return;
    }

    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) { deselect(); return; }

    if (hit.type === 'key') {
      selectPart(`K${hit.keyNum}`);
    } else {
      selectPart(`${hit.knobId}.${hit.zone}`);
    }
    downHit = null;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') deselect();
  }

  // ── Hover ───────────────────────────────────────────────────

  function applyHover(partId: string | null) {
    if (!model) return;

    // Set hover targets for all parts
    model.keys.forEach((_, keyNum) => {
      const k = `K${keyNum}`;
      const on = partId === k;
      getSpring(hoverY, k).target = on ? 0.06 : 0;
      getSpring(hoverEm, k).target = on ? 0.18 : 0;
    });
    for (const id of KNOB_IDS) {
      const on = partId === id;
      getSpring(hoverY, id).target = on ? 0.04 : 0;
      getSpring(hoverEm, id).target = on ? 0.15 : 0;
    }
  }

  // ── Selection / explode ─────────────────────────────────────

  function selectPart(partId: string) {
    selectedPart.value = partId;
    applyExplode(partId);
  }

  function deselect() {
    selectedPart.value = null;
    applyExplode(null);
  }

  function applyExplode(partId: string | null) {
    if (!model) return;

    model.keys.forEach((_, keyNum) => {
      const k = `K${keyNum}`;
      const sel = partId === k;
      getSpring(yOffsets, k).target = sel ? 0.5 : 0;
      getSpring(emSprings, k).target = partId == null ? 0 : (sel ? 0.35 : 0);
    });

    for (const id of KNOB_IDS) {
      const sel = partId?.startsWith(id) ?? false;
      getSpring(yOffsets, id).target = sel ? 0.4 : 0;
      getSpring(emSprings, id).target = partId == null ? 0 : (sel ? 0.3 : 0);
    }

    plateLift.target = partId ? 0.18 : 0;
  }

  // ── Press / turn animations ─────────────────────────────────

  function animatePress(partId: string, depth: number) {
    const s = getSpring(yOffsets, partId);
    s.target = depth;
    const isKey = partId.startsWith('K');
    setTimeout(() => {
      const selTarget = isKey
        ? (selectedPart.value === partId ? 0.5 : 0)
        : (selectedPart.value?.startsWith(partId) ? 0.4 : 0);
      s.target = selTarget;
    }, 130);
  }

  function animateKnobTurn(knobId: string, dir: 'left' | 'right') {
    const rot = getSpring(knobRot, knobId);
    rot.target = dir === 'left' ? -0.3 : 0.3;
    setTimeout(() => { rot.target = 0; }, 220);
  }

  function flash(partId: string) {
    const s = getSpring(flashEm, partId);
    s.value = 0.6;
    s.target = 0;
  }

  // ── Press from hardware ─────────────────────────────────────

  function pressInput(inputId: string) {
    // Key: "L1.K5"
    const keyMatch = /^L\d+\.K(\d+)$/.exec(inputId);
    if (keyMatch) {
      const k = `K${keyMatch[1]}`;
      animatePress(k, -0.12);
      flash(k);
      return;
    }
    // Knob: "L1.big.left", "L1.small.press", etc.
    const knobMatch = /^L\d+\.(big|mid|small)\.(left|right|press)$/.exec(inputId);
    if (knobMatch) {
      const [, knobId, action] = knobMatch;
      if (action === 'press') {
        animatePress(knobId, -0.08);
      } else {
        animateKnobTurn(knobId, action as 'left' | 'right');
      }
      flash(knobId);
    }
  }

  // ── Animation loop ──────────────────────────────────────────

  function animate() {
    if (disposed) return;
    animId = requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);

    yOffsets.forEach(s => tick(s, SK, SD, dt));
    hoverY.forEach(s => tick(s, SK, SD, dt));
    hoverEm.forEach(s => tick(s, SK, SD, dt));
    emSprings.forEach(s => tick(s, SK, SD, dt));
    flashEm.forEach(s => tick(s, FK, FD, dt));
    knobRot.forEach(s => tick(s, SK, SD, dt));
    tick(plateLift, SK, SD, dt);

    applyAnimations();
    controls?.update();
    renderer!.render(scene!, camera!);
  }

  function applyAnimations() {
    if (!model) return;

    model.keys.forEach((mesh, keyNum) => {
      const k = `K${keyNum}`;
      const ry = restY.get(k) ?? TOP_Y;
      const yo = yOffsets.get(k)?.value ?? 0;
      const hy = hoverY.get(k)?.value ?? 0;
      mesh.position.y = ry + yo + hy;

      const selEm = emSprings.get(k)?.value ?? 0;
      const hovEm = hoverEm.get(k)?.value ?? 0;
      const flaEm = flashEm.get(k)?.value ?? 0;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = Math.max(selEm, hovEm, flaEm);

      if (selectedPart.value && selectedPart.value !== k) {
        mat.opacity = 0.55;
        mat.transparent = true;
      } else {
        mat.opacity = 1;
        mat.transparent = false;
      }
    });

    model.knobs.forEach((g, id) => {
      const ry = restY.get(id) ?? TOP_Y;
      const yo = yOffsets.get(id)?.value ?? 0;
      const hy = hoverY.get(id)?.value ?? 0;
      g.position.y = ry + yo + hy;

      const rot = knobRot.get(id)?.value ?? 0;
      g.rotation.y = rot;

      const selEm = emSprings.get(id)?.value ?? 0;
      const hovEm = hoverEm.get(id)?.value ?? 0;
      const flaEm = flashEm.get(id)?.value ?? 0;
      const kMesh = g.children[0] as THREE.Mesh;
      const mat = kMesh.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = Math.max(selEm, hovEm, flaEm);

      if (selectedPart.value && !selectedPart.value.startsWith(id)) {
        mat.opacity = 0.55;
        mat.transparent = true;
      } else {
        mat.opacity = 1;
        mat.transparent = false;
      }
    });

    model.plate.position.y = plateLift.value;
  }

  // ── LED colours ─────────────────────────────────────────────

  function updateColors(lighting: LayerLightingConfig | undefined) {
    if (!model) { pendingLighting = lighting; return; }
    model.keys.forEach((mesh) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!lighting || lighting.mode === 'off') {
        mat.emissive.set(0xffffff);
        return;
      }
      const keyNum = mesh.userData.keyNum as number;
      const perKey = lighting.keys?.[`K${keyNum}`];
      const color = perKey ?? lighting.color;
      mat.emissive.set(color ? new THREE.Color(color) : 0xffffff);
    });
  }

  // ── Orientation ─────────────────────────────────────────────

  function setOrientation(o: Orientation) {
    if (!model) { pendingOrientation = o; return; }
    model.group.rotation.y = -o * (Math.PI / 180);
    frameModel();
  }

  // ── Camera ──────────────────────────────────────────────────

  function frameModel() {
    if (!model || !camera || !controls || !scene) return;
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model.group);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.z);

    camera.position.set(
      center.x + maxDim * 0.3,
      center.y + maxDim * 1.0,
      center.z + maxDim * 1.2,
    );
    controls.target.copy(center);
    controls.update();
  }

  function resetCamera() {
    frameModel();
  }

  // ── Lifecycle ───────────────────────────────────────────────

  function dispose() {
    disposed = true;
    cancelAnimationFrame(animId);
    model?.dispose();
    controls?.dispose();
    if (renderer) {
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      if (renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
      renderer.dispose();
    }
  }

  watch(container, (el) => {
    if (el && !renderer) init(el);
  }, { flush: 'post' });

  watch(physicalRows, () => {
    if (scene) rebuildModel();
  });

  onUnmounted(dispose);

  return {
    hoveredPart: readonly(hoveredPart),
    hoveredZone: readonly(hoveredZone),
    selectedPart,
    pressInput,
    selectPart,
    deselect,
    updateColors,
    setOrientation,
    resetCamera,
    dispose,
    get ready() { return ready; },
  };
}
