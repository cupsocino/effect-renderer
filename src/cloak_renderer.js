import * as THREE from "three";

const MAX_MESH_REFS = 1024;
const MAX_CLOTH_LINKS = 4096;
const MAX_VERTICES = 1_000_000;
const MAX_FACES = 1_000_000;
const PC_MESH_REF_BYTES = 0x84;
const PC_LINK_BYTES = 0x20c;
const PC_ANCHOR_BYTES = 0x18;
const PC_ANCHOR_COUNT = 20;
const CLOAK_VERTEX_BYTES = 40;
const CLOTH_STEP_SECONDS = 1 / 60;

class Reader {
  constructor(buffer, label) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.offset = 0;
    this.label = label;
  }

  remaining() {
    return this.bytes.byteLength - this.offset;
  }

  require(length, field) {
    if (length < 0 || this.offset + length > this.bytes.byteLength) {
      throw new Error(`${this.label}: truncated while reading ${field}`);
    }
  }

  skip(length, field = "bytes") {
    this.require(length, field);
    this.offset += length;
  }

  u8(field = "u8") {
    this.require(1, field);
    return this.bytes[this.offset++];
  }

  u16(field = "u16") {
    this.require(2, field);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(field = "u32") {
    this.require(4, field);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(field = "i32") {
    this.require(4, field);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  f32(field = "f32") {
    this.require(4, field);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    if (!Number.isFinite(value)) throw new Error(`${this.label}: invalid float in ${field}`);
    return value;
  }

  vec3(field = "vec3") {
    return [this.f32(`${field}.x`), this.f32(`${field}.y`), this.f32(`${field}.z`)];
  }

  fixedString(length, field) {
    this.require(length, field);
    const start = this.offset;
    const end = start + length;
    let terminator = start;
    while (terminator < end && this.bytes[terminator] !== 0) terminator += 1;
    this.offset = end;
    return new TextDecoder("windows-1252").decode(this.bytes.subarray(start, terminator));
  }

  count(maximum, field) {
    const value = this.u32(field);
    if (value > maximum) throw new Error(`${this.label}: invalid ${field} count ${value}`);
    return value;
  }
}

function parseMeshRefs(reader, count, field) {
  return Array.from({ length: count }, (_, index) => {
    const start = reader.offset;
    const id = reader.i32(`${field}[${index}].id`);
    const filename = reader.fixedString(128, `${field}[${index}].filename`);
    if (!filename) throw new Error(`${reader.label}: empty ${field}[${index}] filename`);
    if (reader.offset - start !== PC_MESH_REF_BYTES) throw new Error(`${reader.label}: invalid mesh-ref size`);
    return { id, filename };
  });
}

export function parsePc(buffer, label = "cloak.pc") {
  const reader = new Reader(buffer, label);
  const flexibleMeshCount = reader.count(MAX_MESH_REFS, "flexible_mesh");
  const flexibleMeshes = parseMeshRefs(reader, flexibleMeshCount, "flexible_mesh");

  const linkCount = reader.count(MAX_CLOTH_LINKS, "cloth_link");
  const links = Array.from({ length: linkCount }, (_, linkIndex) => {
    const start = reader.offset;
    const link = {
      clothMeshIndex: reader.i32(`cloth_link[${linkIndex}].cloth_mesh_index`),
      textureIndex: reader.i32(`cloth_link[${linkIndex}].texture_index`),
      solverMode: reader.i32(`cloth_link[${linkIndex}].solver_mode`),
      rigidMeshIndex: reader.i32(`cloth_link[${linkIndex}].rigid_mesh_index`),
      columnSegments: reader.i32(`cloth_link[${linkIndex}].column_segments`),
      rowSegments: reader.i32(`cloth_link[${linkIndex}].row_segments`),
      sampleColumn: reader.i32(`cloth_link[${linkIndex}].sample_column`),
      sampleRow: reader.i32(`cloth_link[${linkIndex}].sample_row`),
      sampleRadiusColumn: reader.i32(`cloth_link[${linkIndex}].sample_radius_column`),
      sampleRadiusRow: reader.i32(`cloth_link[${linkIndex}].sample_radius_row`),
      padding: reader.u32(`cloth_link[${linkIndex}].padding`),
      anchors: [],
    };
    for (let anchorIndex = 0; anchorIndex < PC_ANCHOR_COUNT; anchorIndex += 1) {
      const anchorStart = reader.offset;
      const anchor = {
        active: reader.u32(`cloth_link[${linkIndex}].anchor[${anchorIndex}].active`) === 1,
        clothVertex: reader.i32(`cloth_link[${linkIndex}].anchor[${anchorIndex}].cloth_vertex`),
        skeletonBone: reader.i32(`cloth_link[${linkIndex}].anchor[${anchorIndex}].skeleton_bone`),
        boneLocalPosition: reader.vec3(`cloth_link[${linkIndex}].anchor[${anchorIndex}].position`),
      };
      if (reader.offset - anchorStart !== PC_ANCHOR_BYTES) throw new Error(`${label}: invalid anchor size`);
      link.anchors.push(anchor);
    }
    if (reader.offset - start !== PC_LINK_BYTES) throw new Error(`${label}: invalid cloth-link size`);
    if (link.columnSegments < 1 || link.rowSegments < 1) {
      throw new Error(`${label}: invalid grid in cloth link ${linkIndex}`);
    }
    return link;
  });

  const rigidMeshCount = reader.count(MAX_MESH_REFS, "rigid_mesh");
  const rigidMeshes = parseMeshRefs(reader, rigidMeshCount, "rigid_mesh");
  if (reader.remaining() !== 0) throw new Error(`${label}: ${reader.remaining()} trailing bytes`);

  for (const [index, link] of links.entries()) {
    if (link.clothMeshIndex < 0 || link.clothMeshIndex >= flexibleMeshes.length) {
      throw new Error(`${label}: cloth link ${index} has invalid flexible mesh ${link.clothMeshIndex}`);
    }
    if (link.rigidMeshIndex < 0 || link.rigidMeshIndex >= rigidMeshes.length) {
      throw new Error(`${label}: cloth link ${index} has invalid rigid mesh ${link.rigidMeshIndex}`);
    }
  }

  return { flexibleMeshes, links, rigidMeshes };
}

export function parseCtl(buffer, label = "cloak.ctl") {
  const reader = new Reader(buffer, label);
  const count = reader.count(4096, "texture");
  const filenames = Array.from({ length: count }, (_, index) =>
    reader.fixedString(256, `texture[${index}]`));
  if (reader.remaining() !== 0) throw new Error(`${label}: ${reader.remaining()} trailing bytes`);
  return { filenames };
}

function parseVertices(reader, vertexCount, field) {
  return Array.from({ length: vertexCount }, (_, index) => {
    const start = reader.offset;
    const position = reader.vec3(`${field}[${index}].position`);
    const weight = reader.f32(`${field}[${index}].weight`);
    const boneIndices = [
      reader.u8(`${field}[${index}].bone0`),
      reader.u8(`${field}[${index}].bone1`),
      reader.u8(`${field}[${index}].bone2`),
    ];
    reader.skip(1, `${field}[${index}].padding`);
    const normal = reader.vec3(`${field}[${index}].normal`);
    const uv = [reader.f32(`${field}[${index}].u`), reader.f32(`${field}[${index}].v`)];
    if (reader.offset - start !== CLOAK_VERTEX_BYTES) throw new Error(`${reader.label}: invalid vertex size`);
    return { position, weight, boneIndices, normal, uv };
  });
}

function parseFaces(reader, vertexCount, field) {
  const faceCount = reader.count(MAX_FACES, field);
  return Array.from({ length: faceCount }, (_, index) => {
    const face = [
      reader.u16(`${field}[${index}].a`),
      reader.u16(`${field}[${index}].b`),
      reader.u16(`${field}[${index}].c`),
    ];
    if (face.some((vertex) => vertex >= vertexCount)) {
      throw new Error(`${reader.label}: invalid face index in ${field}[${index}]`);
    }
    return face;
  });
}

export function parseFlexible3dc(buffer, label = "cloak-flexible.3dc") {
  const reader = new Reader(buffer, label);
  const boneCount = reader.u32("bone_count");
  if (boneCount !== 0) throw new Error(`${label}: expected a boneless flexible cloak, found ${boneCount} bones`);
  const vertexCount = reader.count(MAX_VERTICES, "vertex");
  if (vertexCount === 0) throw new Error(`${label}: empty flexible mesh`);
  const vertices = parseVertices(reader, vertexCount, "vertex");
  const faces = parseFaces(reader, vertexCount, "face");
  if (reader.remaining() !== 0) throw new Error(`${label}: ${reader.remaining()} trailing bytes`);
  return { vertices, faces };
}

export function parseRigid3dc(buffer, label = "cloak-rigid.3dc") {
  const reader = new Reader(buffer, label);
  const version = reader.i32("version");
  const boneCount = reader.count(4096, "bone");
  const inverseBindMatrices = Array.from({ length: boneCount }, (_, boneIndex) =>
    Array.from({ length: 16 }, (_, component) => reader.f32(`bone[${boneIndex}].matrix[${component}]`)));
  const vertexCount = reader.count(MAX_VERTICES, "vertex");
  const vertices = parseVertices(reader, vertexCount, "vertex");
  const faces = parseFaces(reader, vertexCount, "face");
  if (reader.remaining() !== 0) throw new Error(`${label}: ${reader.remaining()} trailing bytes`);
  return { version, inverseBindMatrices, vertices, faces };
}

function parentPath(path) {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function cloakRootFromPcPath(path) {
  const marker = path.indexOf("cloak/character/");
  return marker < 0 ? "cloak" : `${path.slice(0, marker)}cloak`;
}

function basename(path) {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function meshVariant(filename) {
  const match = filename.match(/_(hl|l|s)\.3dc$/i);
  return match?.[1]?.toUpperCase() ?? "?";
}

function createGeometry(model, dynamic = false) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(model.vertices.length * 3);
  const normals = new Float32Array(model.vertices.length * 3);
  const uvs = new Float32Array(model.vertices.length * 2);
  for (let index = 0; index < model.vertices.length; index += 1) {
    const vertex = model.vertices[index];
    positions.set(vertex.position, index * 3);
    normals.set(vertex.normal, index * 3);
    uvs.set(vertex.uv, index * 2);
  }
  const flatIndices = model.faces.flat();
  const IndexArray = model.vertices.length > 65535 ? Uint32Array : Uint16Array;
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(new IndexArray(flatIndices), 1));
  if (dynamic) geometry.getAttribute("position").setUsage(THREE.DynamicDrawUsage);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createCloakMaterial(texture, opacity = 1) {
  return new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xffffff,
    side: THREE.DoubleSide,
    transparent: true,
    opacity,
    alphaTest: 0.02,
    roughness: 0.72,
    metalness: 0,
  });
}

function constraint(a, b, restPositions) {
  const ax = restPositions[a * 3];
  const ay = restPositions[a * 3 + 1];
  const az = restPositions[a * 3 + 2];
  const dx = restPositions[b * 3] - ax;
  const dy = restPositions[b * 3 + 1] - ay;
  const dz = restPositions[b * 3 + 2] - az;
  return { a, b, length: Math.hypot(dx, dy, dz) };
}

class ClothSimulation {
  constructor(model, link, bindPins) {
    this.columns = link.columnSegments + 1;
    this.rows = link.rowSegments + 1;
    if (model.vertices.length !== this.columns * this.rows) {
      throw new Error(
        `Flexible mesh has ${model.vertices.length} vertices but PC grid requires ${this.columns}×${this.rows}`,
      );
    }
    this.vertexCount = model.vertices.length;
    this.rest = new Float32Array(this.vertexCount * 3);
    model.vertices.forEach((vertex, index) => this.rest.set(vertex.position, index * 3));
    this.positions = new Float32Array(this.rest);
    this.previous = new Float32Array(this.rest);
    this.pinBindings = bindPins;
    this.pinned = new Uint8Array(this.vertexCount);
    for (const pin of bindPins) {
      if (pin.vertex >= 0 && pin.vertex < this.vertexCount) this.pinned[pin.vertex] = 1;
    }
    this.constraints = [];
    this.collider = this.deriveCollider();
    this.buildConstraints();
  }

  deriveCollider() {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index < this.vertexCount; index += 1) {
      const offset = index * 3;
      minX = Math.min(minX, this.rest[offset]);
      maxX = Math.max(maxX, this.rest[offset]);
      minY = Math.min(minY, this.rest[offset + 1]);
      maxY = Math.max(maxY, this.rest[offset + 1]);
      minZ = Math.min(minZ, this.rest[offset + 2]);
      maxZ = Math.max(maxZ, this.rest[offset + 2]);
    }
    const halfWidth = Math.max(0.08, (maxX - minX) * 0.53);
    const height = Math.max(0.1, maxY - minY);
    return {
      center: new THREE.Vector3((minX + maxX) * 0.5, maxY - height * 0.53, minZ - halfWidth * 0.6),
      radii: new THREE.Vector3(halfWidth, height * 0.74, halfWidth * 0.75),
    };
  }

  buildConstraints() {
    const at = (row, column) => row * this.columns + column;
    for (let row = 0; row < this.rows; row += 1) {
      for (let column = 0; column < this.columns; column += 1) {
        const here = at(row, column);
        if (column + 1 < this.columns) this.constraints.push(constraint(here, at(row, column + 1), this.rest));
        if (row + 1 < this.rows) this.constraints.push(constraint(here, at(row + 1, column), this.rest));
        if (row + 1 < this.rows && column + 1 < this.columns) {
          this.constraints.push(constraint(here, at(row + 1, column + 1), this.rest));
          this.constraints.push(constraint(at(row, column + 1), at(row + 1, column), this.rest));
        }
        if (column + 2 < this.columns) this.constraints.push(constraint(here, at(row, column + 2), this.rest));
        if (row + 2 < this.rows) this.constraints.push(constraint(here, at(row + 2, column), this.rest));
      }
    }
  }

  reset(pinPositions) {
    this.positions.set(this.rest);
    this.previous.set(this.rest);
    this.applyPins(pinPositions);
    this.previous.set(this.positions);
  }

  step(dt, settings, pinPositions, rootMatrix, inverseRootMatrix) {
    const dtSquared = dt * dt;
    const damping = 0.992;
    const time = settings.time;
    for (let index = 0; index < this.vertexCount; index += 1) {
      if (this.pinned[index]) continue;
      const offset = index * 3;
      const x = this.positions[offset];
      const y = this.positions[offset + 1];
      const z = this.positions[offset + 2];
      const previousX = this.previous[offset];
      const previousY = this.previous[offset + 1];
      const previousZ = this.previous[offset + 2];
      this.previous[offset] = x;
      this.previous[offset + 1] = y;
      this.previous[offset + 2] = z;

      const row = Math.floor(index / this.columns);
      const exposure = row / Math.max(1, this.rows - 1);
      const gust = 0.68 + 0.32 * Math.sin(time * 1.7 + row * 0.38);
      const windX = settings.wind * exposure * 0.28 * Math.sin(time * 0.91 + row * 0.27);
      const windZ = settings.wind * exposure * gust;
      this.positions[offset] = x + (x - previousX) * damping + windX * dtSquared;
      this.positions[offset + 1] = y + (y - previousY) * damping - settings.gravity * dtSquared;
      this.positions[offset + 2] = z + (z - previousZ) * damping + windZ * dtSquared;
    }

    this.applyPins(pinPositions);
    for (let iteration = 0; iteration < settings.iterations; iteration += 1) {
      for (const item of this.constraints) this.solveConstraint(item);
      this.solveTorsoCollision(rootMatrix, inverseRootMatrix);
      this.applyPins(pinPositions);
    }
  }

  solveConstraint(item) {
    const aOffset = item.a * 3;
    const bOffset = item.b * 3;
    const dx = this.positions[bOffset] - this.positions[aOffset];
    const dy = this.positions[bOffset + 1] - this.positions[aOffset + 1];
    const dz = this.positions[bOffset + 2] - this.positions[aOffset + 2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 1e-7) return;
    const aFree = this.pinned[item.a] ? 0 : 1;
    const bFree = this.pinned[item.b] ? 0 : 1;
    const freeCount = aFree + bFree;
    if (freeCount === 0) return;
    const correction = (distance - item.length) / (distance * freeCount);
    const cx = dx * correction;
    const cy = dy * correction;
    const cz = dz * correction;
    if (aFree) {
      this.positions[aOffset] += cx;
      this.positions[aOffset + 1] += cy;
      this.positions[aOffset + 2] += cz;
    }
    if (bFree) {
      this.positions[bOffset] -= cx;
      this.positions[bOffset + 1] -= cy;
      this.positions[bOffset + 2] -= cz;
    }
  }

  solveTorsoCollision(rootMatrix, inverseRootMatrix) {
    const { center, radii } = this.collider;
    const point = new THREE.Vector3();
    for (let index = 0; index < this.vertexCount; index += 1) {
      if (this.pinned[index]) continue;
      const offset = index * 3;
      point.set(this.positions[offset], this.positions[offset + 1], this.positions[offset + 2]);
      point.applyMatrix4(inverseRootMatrix).sub(center);
      const normalizedSquared =
        (point.x * point.x) / (radii.x * radii.x)
        + (point.y * point.y) / (radii.y * radii.y)
        + (point.z * point.z) / (radii.z * radii.z);
      if (normalizedSquared >= 1 || normalizedSquared < 1e-8) continue;
      point.multiplyScalar(1 / Math.sqrt(normalizedSquared)).add(center).applyMatrix4(rootMatrix);
      this.positions[offset] = point.x;
      this.positions[offset + 1] = point.y;
      this.positions[offset + 2] = point.z;
    }
  }

  applyPins(pinPositions) {
    for (const pin of this.pinBindings) {
      const position = pinPositions.get(pin.vertex);
      if (!position) continue;
      const offset = pin.vertex * 3;
      this.positions[offset] = position.x;
      this.positions[offset + 1] = position.y;
      this.positions[offset + 2] = position.z;
    }
  }
}

export class CloakPreview {
  constructor(scene, assetStore, log) {
    this.scene = scene;
    this.assetStore = assetStore;
    this.log = log;
    this.group = new THREE.Group();
    this.group.name = "cloak-preview";
    this.scene.add(this.group);
    this.group.visible = false;
    this.pc = null;
    this.pcEntry = null;
    this.ctl = null;
    this.linkIndex = -1;
    this.simulation = null;
    this.flexibleMesh = null;
    this.rigidMesh = null;
    this.debugGroup = new THREE.Group();
    this.group.add(this.debugGroup);
    this.anchorMarkers = [];
    this.accumulator = 0;
    this.elapsed = 0;
    this.settings = {
      wind: 0.8,
      gravity: 1.2,
      iterations: 6,
      motionEnabled: true,
      debug: false,
    };
    this.rootMatrix = new THREE.Matrix4();
    this.inverseRootMatrix = new THREE.Matrix4();
    this.pinBindPositions = new Map();
    this.currentPinPositions = new Map();
    this.texturePath = null;
    this.flexiblePath = null;
    this.rigidPath = null;
  }

  setVisible(visible) {
    this.group.visible = visible;
  }

  setSettings(settings) {
    Object.assign(this.settings, settings);
    this.settings.iterations = Math.max(1, Math.min(16, Math.round(this.settings.iterations)));
    this.debugGroup.visible = Boolean(this.settings.debug);
  }

  async loadPc(entry) {
    this.clearModel();
    this.pc = null;
    this.ctl = null;
    this.pcEntry = entry;
    this.pc = parsePc(await entry.file.arrayBuffer(), basename(entry.path));
    this.linkIndex = -1;
    const firstMesh = this.pc.flexibleMeshes[0]?.filename ?? "";
    const prefix = basename(firstMesh).split("_")[0].slice(0, 2).toLowerCase();
    this.raceCode = prefix;
    this.pcDirectory = parentPath(entry.path);
    this.cloakRoot = cloakRootFromPcPath(entry.path);
    const loadedCtl = await this.assetStore.readBuffer([
      `${this.cloakRoot}/clothtexture/cloth_texthre_${prefix}.ctl`,
      `cloak/clothtexture/cloth_texthre_${prefix}.ctl`,
      `cloth_texthre_${prefix}.ctl`,
    ]);
    if (loadedCtl) {
      this.ctl = parseCtl(loadedCtl.buffer, loadedCtl.file.name);
      this.log(`cloak textures: ${loadedCtl.path}`);
    } else {
      this.ctl = null;
      this.log(`cloak ${basename(entry.path)}: missing texture table for ${prefix}`);
    }
    return this.pc;
  }

  linkLabel(index) {
    const link = this.pc?.links[index];
    if (!link) return `${index}: invalid`;
    const flexible = this.pc.flexibleMeshes[link.clothMeshIndex]?.filename ?? "missing flexible mesh";
    const rigid = this.pc.rigidMeshes[link.rigidMeshIndex]?.filename ?? "missing rigid mesh";
    const texture = this.ctl?.filenames[link.textureIndex] ?? `texture ${link.textureIndex}`;
    return `${index}: ${texture} · ${meshVariant(flexible)} · ${basename(rigid)}`;
  }

  async selectLink(index) {
    if (!this.pc || !this.pcEntry) throw new Error("Load a PC file before selecting a cloth link");
    const link = this.pc.links[index];
    if (!link) throw new Error(`Invalid cloth link ${index}`);
    this.clearModel();
    this.linkIndex = index;
    const flexibleRef = this.pc.flexibleMeshes[link.clothMeshIndex];
    const rigidRef = this.pc.rigidMeshes[link.rigidMeshIndex];
    const [flexibleLoaded, rigidLoaded] = await Promise.all([
      this.assetStore.readBuffer([
        `${this.pcDirectory}/3dc/${flexibleRef.filename}`,
        flexibleRef.filename,
      ]),
      this.assetStore.readBuffer([
        `${this.pcDirectory}/3dc/static/${rigidRef.filename}`,
        rigidRef.filename,
      ]),
    ]);
    if (!flexibleLoaded) throw new Error(`Missing flexible cloak mesh ${flexibleRef.filename}`);
    if (!rigidLoaded) throw new Error(`Missing rigid cloak mesh ${rigidRef.filename}`);
    const flexible = parseFlexible3dc(flexibleLoaded.buffer, flexibleLoaded.file.name);
    const rigid = parseRigid3dc(rigidLoaded.buffer, rigidLoaded.file.name);
    this.flexiblePath = flexibleLoaded.path;
    this.rigidPath = rigidLoaded.path;

    const textureName = this.ctl?.filenames[link.textureIndex] ?? "";
    const textureLoaded = textureName
      ? await this.assetStore.loadTexture([
        `${this.cloakRoot}/clothtexture/${this.raceCode}/${textureName}`,
        `cloak/clothtexture/${this.raceCode}/${textureName}`,
        textureName,
      ])
      : { texture: this.assetStore.fallbackTexture, path: null };
    this.texturePath = textureLoaded.path;

    const bindPins = this.reconstructBindPins(link, rigid, flexible);
    this.simulation = new ClothSimulation(flexible, link, bindPins);
    const flexibleGeometry = createGeometry(flexible, true);
    const rigidGeometry = createGeometry(rigid);
    this.flexibleMesh = new THREE.Mesh(flexibleGeometry, createCloakMaterial(textureLoaded.texture));
    this.flexibleMesh.name = flexibleRef.filename;
    this.flexibleMesh.frustumCulled = false;
    this.rigidMesh = new THREE.Mesh(rigidGeometry, createCloakMaterial(textureLoaded.texture));
    this.rigidMesh.name = rigidRef.filename;
    this.group.add(this.flexibleMesh, this.rigidMesh);
    this.createDebugObjects(bindPins);
    this.reset();
    this.log(`cloak flexible mesh: ${flexibleLoaded.path}`);
    this.log(`cloak rigid mesh: ${rigidLoaded.path}`);
    if (textureLoaded.path) this.log(`cloak texture: ${textureLoaded.path}`);
    return this.summary();
  }

  reconstructBindPins(link, rigid, flexible) {
    const pins = [];
    for (const anchor of link.anchors) {
      if (!anchor.active) break;
      if (anchor.clothVertex < 0 || anchor.clothVertex >= flexible.vertices.length) continue;
      const rawMatrix = rigid.inverseBindMatrices[anchor.skeletonBone];
      let position;
      if (rawMatrix) {
        // Shaiya serializes DirectX row-vector matrices. fromArray interprets
        // the bytes as the transposed column-vector matrix; inversion then
        // converts the PC's bone-local point back into model bind space.
        const bindMatrix = new THREE.Matrix4().fromArray(rawMatrix).invert();
        position = new THREE.Vector3(...anchor.boneLocalPosition).applyMatrix4(bindMatrix);
      } else {
        position = new THREE.Vector3(...flexible.vertices[anchor.clothVertex].position);
      }
      pins.push({ vertex: anchor.clothVertex, bone: anchor.skeletonBone, bindPosition: position });
    }
    if (pins.length === 0) {
      const columns = link.columnSegments + 1;
      for (let vertex = 0; vertex < Math.min(columns, flexible.vertices.length); vertex += 1) {
        pins.push({ vertex, bone: -1, bindPosition: new THREE.Vector3(...flexible.vertices[vertex].position) });
      }
    }
    this.pinBindPositions = new Map(pins.map((pin) => [pin.vertex, pin.bindPosition.clone()]));
    return pins;
  }

  createDebugObjects(pins) {
    this.debugGroup.clear();
    this.anchorMarkers = pins.map(() => {
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.018, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xffb45f, depthTest: false }),
      );
      marker.renderOrder = 5;
      this.debugGroup.add(marker);
      return marker;
    });
    const collider = new THREE.Mesh(
      new THREE.SphereGeometry(1, 18, 12),
      new THREE.MeshBasicMaterial({ color: 0x67b7ff, wireframe: true, transparent: true, opacity: 0.34 }),
    );
    collider.position.copy(this.simulation.collider.center);
    collider.scale.copy(this.simulation.collider.radii);
    collider.name = "cloak-torso-collider";
    this.debugGroup.add(collider);
    this.debugGroup.visible = Boolean(this.settings.debug);
  }

  reset() {
    if (!this.simulation) return;
    this.accumulator = 0;
    this.elapsed = 0;
    this.updateRootTransform(0);
    this.updatePins();
    this.simulation.reset(this.currentPinPositions);
    this.updateGeometry();
  }

  update(deltaSeconds) {
    if (!this.group.visible || !this.simulation || !this.flexibleMesh) return;
    const delta = Math.min(0.1, Math.max(0, deltaSeconds));
    this.accumulator = Math.min(0.25, this.accumulator + delta);
    while (this.accumulator >= CLOTH_STEP_SECONDS) {
      this.elapsed += CLOTH_STEP_SECONDS;
      this.updateRootTransform(this.elapsed);
      this.updatePins();
      this.simulation.step(CLOTH_STEP_SECONDS, {
        wind: this.settings.wind,
        gravity: this.settings.gravity,
        iterations: this.settings.iterations,
        time: this.elapsed,
      }, this.currentPinPositions, this.rootMatrix, this.inverseRootMatrix);
      this.accumulator -= CLOTH_STEP_SECONDS;
    }
    this.updateGeometry();
  }

  updateRootTransform(time) {
    const enabled = this.settings.motionEnabled;
    const x = enabled ? Math.sin(time * 0.85) * 0.055 : 0;
    const z = enabled ? (Math.cos(time * 0.58) - 1) * 0.028 : 0;
    const yaw = enabled ? Math.sin(time * 0.66) * 0.085 : 0;
    const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const translation = new THREE.Vector3(x, 0, z);
    this.rootMatrix.compose(translation, rotation, new THREE.Vector3(1, 1, 1));
    this.inverseRootMatrix.copy(this.rootMatrix).invert();
    if (this.rigidMesh) {
      this.rigidMesh.position.copy(translation);
      this.rigidMesh.quaternion.copy(rotation);
    }
    const collider = this.debugGroup.getObjectByName("cloak-torso-collider");
    if (collider) {
      collider.position.copy(this.simulation.collider.center).applyMatrix4(this.rootMatrix);
      collider.quaternion.copy(rotation);
    }
  }

  updatePins() {
    this.currentPinPositions = new Map();
    let markerIndex = 0;
    for (const [vertex, bindPosition] of this.pinBindPositions) {
      const current = bindPosition.clone().applyMatrix4(this.rootMatrix);
      this.currentPinPositions.set(vertex, current);
      const marker = this.anchorMarkers[markerIndex++];
      if (marker) marker.position.copy(current);
    }
  }

  updateGeometry() {
    if (!this.simulation || !this.flexibleMesh) return;
    const geometry = this.flexibleMesh.geometry;
    const attribute = geometry.getAttribute("position");
    attribute.array.set(this.simulation.positions);
    attribute.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  }

  frameCamera(camera, controls) {
    if (!this.flexibleMesh || !this.rigidMesh) return;
    const box = new THREE.Box3().setFromObject(this.group);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(0.6, size.length() * 0.75);
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(radius * 0.7, radius * 0.35, radius * 2.2));
    camera.near = Math.max(0.01, radius / 100);
    camera.far = Math.max(100, radius * 30);
    camera.updateProjectionMatrix();
    controls.update();
  }

  summary() {
    if (!this.pc || this.linkIndex < 0 || !this.simulation) return null;
    const link = this.pc.links[this.linkIndex];
    return {
      linkIndex: this.linkIndex,
      grid: `${this.simulation.columns}×${this.simulation.rows}`,
      vertices: this.simulation.vertexCount,
      anchors: this.simulation.pinBindings.length,
      textureIndex: link.textureIndex,
      flexiblePath: this.flexiblePath,
      rigidPath: this.rigidPath,
      texturePath: this.texturePath,
    };
  }

  clearModel() {
    for (const mesh of [this.flexibleMesh, this.rigidMesh]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    for (const child of [...this.debugGroup.children]) {
      child.geometry?.dispose();
      child.material?.dispose();
      this.debugGroup.remove(child);
    }
    this.flexibleMesh = null;
    this.rigidMesh = null;
    this.simulation = null;
    this.anchorMarkers = [];
    this.pinBindPositions.clear();
    this.currentPinPositions.clear();
    this.accumulator = 0;
  }

  dispose() {
    this.clearModel();
    this.scene.remove(this.group);
  }
}
