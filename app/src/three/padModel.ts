import * as THREE from 'three';

// ─── Dimensions (1 unit ≈ 19mm key pitch) ──────────────────────

export const KEY_PITCH = 1.0;
export const GRID_COLS = 3;
export const GRID_ROWS = 4;

const CAP = { w: 0.72, h: 0.40, bevel: 0.06, taper: 0.06 };

const BODY = {
  baseH: 0.10,
  gapH: 0.02,
  plateH: 0.14,
  pad: 0.42,
  cornerR: 0.20,
  filletR: 0.15,
};
const PLATE_Y = BODY.baseH + BODY.gapH;
export const TOP_Y = PLATE_Y + BODY.plateH;

export const KNOB_SPEC: Record<string, { r: number; h: number; ridges: number; x: number; z: number }> = {
  big:   { r: 0.68, h: 0.80, ridges: 24, x: 0.1,  z: 4.5 },
  mid:   { r: 0.50, h: 0.62, ridges: 20, x: 1.0,  z: 4.3 },
  small: { r: 0.38, h: 0.48, ridges: 16, x: 1.9,  z: 4.1 },
};
export const KNOB_IDS = ['big', 'mid', 'small'] as const;
export type KnobId = (typeof KNOB_IDS)[number];

// ─── Outline helper ────────────────────────────────────────────

interface Corner { x: number; y: number; r: number }

function roundedPath(pts: Corner[]): THREE.Shape {
  const n = pts.length;
  const arcs = pts.map((cur, i) => {
    const prev = pts[(i - 1 + n) % n];
    const next = pts[(i + 1) % n];
    const dIn = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const dOut = Math.hypot(next.x - cur.x, next.y - cur.y);
    return {
      sx: cur.x - ((cur.x - prev.x) / dIn) * cur.r,
      sy: cur.y - ((cur.y - prev.y) / dIn) * cur.r,
      ex: cur.x + ((next.x - cur.x) / dOut) * cur.r,
      ey: cur.y + ((next.y - cur.y) / dOut) * cur.r,
      cx: cur.x,
      cy: cur.y,
    };
  });
  const s = new THREE.Shape();
  s.moveTo(arcs[0].ex, arcs[0].ey);
  for (let i = 1; i <= n; i++) {
    const a = arcs[i % n];
    s.lineTo(a.sx, a.sy);
    s.quadraticCurveTo(a.cx, a.cy, a.ex, a.ey);
  }
  return s;
}

function roundedRect(w: number, h: number, r: number): THREE.Shape {
  const hw = w / 2, hh = h / 2;
  return roundedPath([
    { x: hw, y: -hh, r }, { x: hw, y: hh, r },
    { x: -hw, y: hh, r }, { x: -hw, y: -hh, r },
  ]);
}

// ─── Body outline ──────────────────────────────────────────────

function bodyOutline(): THREE.Shape {
  const p = BODY.pad, r = BODY.cornerR, f = BODY.filletR;
  const L = -p;
  const R = (GRID_COLS - 1) + p;
  const T = -p;
  const mainBot = KNOB_SPEC.small.z + KNOB_SPEC.small.r + p * 0.7;
  const tabBot = KNOB_SPEC.big.z + KNOB_SPEC.big.r + p * 0.7;
  const stepX = KNOB_SPEC.mid.x + KNOB_SPEC.mid.r + 0.15;

  return roundedPath([
    { x: R, y: T, r },
    { x: R, y: mainBot, r },
    { x: stepX, y: mainBot, r: f },
    { x: stepX, y: tabBot, r },
    { x: L, y: tabBot, r },
    { x: L, y: T, r },
  ]);
}

function extrudeFlat(
  shape: THREE.Shape, h: number, yOff: number, bevel = 0.012,
): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: h,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
  });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, h + yOff, 0);
  return geo;
}

// ─── Keycap ────────────────────────────────────────────────────

function keycapGeo(): THREE.BufferGeometry {
  const geo = extrudeFlat(roundedRect(CAP.w, CAP.w, CAP.bevel), CAP.h, 0, 0.022);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = Math.max(0, y / CAP.h);
    const s = 1 - t * CAP.taper;
    pos.setX(i, pos.getX(i) * s);
    pos.setZ(i, pos.getZ(i) * s);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// ─── Knob ──────────────────────────────────────────────────────

function knobGeo(id: KnobId): THREE.BufferGeometry {
  const { r, h, ridges } = KNOB_SPEC[id];
  const segs = ridges * 2;
  const geo = new THREE.CylinderGeometry(r * 0.92, r, h, segs, 1, false);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const d = Math.sqrt(x * x + z * z);
    if (d > r * 0.3) {
      const a = Math.atan2(z, x);
      const bump = Math.cos(a * ridges) > 0 ? 0.012 : -0.006;
      const sc = (d + bump) / d;
      pos.setX(i, x * sc);
      pos.setZ(i, z * sc);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// ─── Materials ─────────────────────────────────────────────────

function makeMaterials() {
  return {
    cap: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.65 }),
    plate: new THREE.MeshPhysicalMaterial({
      color: 0x777777, roughness: 0.3, metalness: 0.05,
      transmission: 0.35, thickness: BODY.plateH,
      transparent: true, opacity: 0.65,
    }),
    base: new THREE.MeshStandardMaterial({
      color: 0x111111, roughness: 0.85, metalness: 0.1,
    }),
    knob: new THREE.MeshStandardMaterial({
      color: 0x0e0e0e, roughness: 0.35, metalness: 0.65,
    }),
    indicator: new THREE.MeshStandardMaterial({
      color: 0xc0c0c0, roughness: 0.3, metalness: 0.8,
    }),
  };
}

// ─── Model assembly ────────────────────────────────────────────

export interface PadModel {
  group: THREE.Group;
  content: THREE.Group;
  base: THREE.Mesh;
  plate: THREE.Mesh;
  keys: Map<number, THREE.Mesh>;
  knobs: Map<string, THREE.Group>;
  dispose(): void;
}

export function findKeyRC(keyNum: number, rows: number[][]): [number, number] | null {
  for (let r = 0; r < rows.length; r++)
    for (let c = 0; c < rows[r].length; c++)
      if (rows[r][c] === keyNum) return [r, c];
  return null;
}

export function buildPadModel(physicalRows: number[][]): PadModel {
  const m = makeMaterials();
  const content = new THREE.Group();
  const disposables: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = Object.values(m);

  const bodyShape = bodyOutline();
  const baseGeo = extrudeFlat(bodyShape, BODY.baseH, 0);
  const plateGeo = extrudeFlat(bodyShape, BODY.plateH, PLATE_Y);
  disposables.push(baseGeo, plateGeo);

  const base = new THREE.Mesh(baseGeo, m.base);
  base.receiveShadow = true;
  base.userData = { part: 'base' };
  const plate = new THREE.Mesh(plateGeo, m.plate);
  plate.userData = { part: 'plate' };
  content.add(base, plate);

  const capGeo = keycapGeo();
  disposables.push(capGeo);
  const keys = new Map<number, THREE.Mesh>();
  for (let r = 0; r < physicalRows.length; r++) {
    for (let c = 0; c < physicalRows[r].length; c++) {
      const keyNum = physicalRows[r][c];
      const capMat = m.cap.clone();
      capMat.emissive = new THREE.Color(0xffffff);
      capMat.emissiveIntensity = 0;
      materials.push(capMat);
      const mesh = new THREE.Mesh(capGeo, capMat);
      mesh.position.set(c * KEY_PITCH, TOP_Y, r * KEY_PITCH);
      mesh.castShadow = true;
      mesh.userData = { type: 'key', keyNum, row: r, col: c };
      content.add(mesh);
      keys.set(keyNum, mesh);
    }
  }

  const knobs = new Map<string, THREE.Group>();
  for (const id of KNOB_IDS) {
    const spec = KNOB_SPEC[id];
    const kGeo = knobGeo(id);
    disposables.push(kGeo);
    const kMat = m.knob.clone();
    kMat.emissive = new THREE.Color(0xffffff);
    kMat.emissiveIntensity = 0;
    materials.push(kMat);
    const kMesh = new THREE.Mesh(kGeo, kMat);
    kMesh.castShadow = true;
    kMesh.userData = { type: 'knob', knobId: id };

    const iGeo = new THREE.BoxGeometry(spec.r * 0.06, 0.015, spec.r * 0.35);
    disposables.push(iGeo);
    const iMesh = new THREE.Mesh(iGeo, m.indicator);
    iMesh.position.set(0, spec.h / 2 + 0.008, -spec.r * 0.3);

    const kGroup = new THREE.Group();
    kGroup.add(kMesh, iMesh);
    kGroup.position.set(spec.x, TOP_Y + spec.h / 2, spec.z);
    kGroup.userData = { type: 'knob', knobId: id };
    content.add(kGroup);
    knobs.set(id, kGroup);
  }

  const box = new THREE.Box3().setFromObject(content);
  const ctr = box.getCenter(new THREE.Vector3());
  ctr.y = 0;
  content.position.set(-ctr.x, 0, -ctr.z);

  const group = new THREE.Group();
  group.add(content);

  return {
    group, content, base, plate, keys, knobs,
    dispose() {
      disposables.forEach(g => g.dispose());
      materials.forEach(mat => mat.dispose());
    },
  };
}
