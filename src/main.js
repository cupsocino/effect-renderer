import "./styles.css";
import skillCatalogue from "./skill_effect_catalogue.json";
import { parseSkillSdataNames } from "./skill_sdata.js";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { DDSLoader } from "three/examples/jsm/loaders/DDSLoader.js";

const maxParticleLevel = 20;
const maxRenderedParticlesPerComponent = 300;
const simulationStepSeconds = 1 / 60;
const maxCatchUpSeconds = 0.5;
// Shaiya model/effect strings are stored as Korean codepage bytes. Browser
// TextDecoder exposes CP949-compatible decoding under the EUC-KR label.
const textDecoder = new TextDecoder("euc-kr");
const archiveTextDecoder = new TextDecoder("windows-1252");
const defaultPlacementBasis = {
  right: [1, 0, 0],
  up: [0, 1, 0],
  forward: [0, 0, 1],
};
const defaultPlacement = {
  position: [0, 0, 0],
  ...defaultPlacementBasis,
};

class BinaryReader {
  constructor(buffer, label = "buffer") {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.offset = 0;
    this.label = label;
  }

  remaining() {
    return this.bytes.byteLength - this.offset;
  }

  take(length, field) {
    if (length < 0 || this.offset + length > this.bytes.byteLength) {
      throw new Error(`${this.label}: truncated while reading ${field}`);
    }
    const start = this.offset;
    this.offset += length;
    return this.bytes.subarray(start, start + length);
  }

  u16(field = "u16") {
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(field = "u32") {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(field = "i32") {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i64(field = "i64") {
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    if (value < 0 || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${this.label}: invalid ${field} ${value}`);
    }
    return Number(value);
  }

  f32(field = "f32") {
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    if (!Number.isFinite(value)) throw new Error(`${this.label}: invalid float in ${field}`);
    return value;
  }

  vec3(field = "vec3") {
    return [this.f32(`${field}.x`), this.f32(`${field}.y`), this.f32(`${field}.z`)];
  }

  count(maximum, field) {
    const value = this.u32(field);
    if (value > maximum) throw new Error(`${this.label}: invalid ${field} count ${value}`);
    return value;
  }

  modelString(field = "string") {
    const length = this.count(4096, `${field}.length`);
    const bytes = this.take(length, field);
    const end = bytes.length > 0 && bytes[bytes.length - 1] === 0 ? bytes.length - 1 : bytes.length;
    return textDecoder.decode(bytes.subarray(0, end));
  }
}

class ArchiveAsset {
  constructor(safFile, entry) {
    this.safFile = safFile;
    this.entry = entry;
    this.name = entry.path.split("/").at(-1) || entry.path;
    this.webkitRelativePath = entry.path;
    this.size = entry.length;
    this.type = "";
  }

  blob() {
    return this.safFile.slice(this.entry.offset, this.entry.offset + this.entry.length);
  }

  arrayBuffer() {
    return this.blob().arrayBuffer();
  }
}

function parseSah(buffer, label, safSize) {
  const reader = new BinaryReader(buffer, label);
  const signature = archiveTextDecoder.decode(reader.take(3, "signature"));
  if (signature !== "SAH") throw new Error(`${label}: invalid SAH signature ${signature}`);

  const version = reader.i32("version");
  const expectedFileCount = reader.i32("file_count");
  reader.take(40, "reserved");

  const entries = [];
  const rootName = readSahDirectory(reader, "", true, entries, safSize);
  const trailingBytes = reader.remaining();
  return { version, expectedFileCount, rootName, entries, trailingBytes };
}

function readSahDirectory(reader, parent, isRoot, entries, safSize) {
  const name = readSahString(reader, "directory.name");
  const current = isRoot ? "" : joinArchivePath(parent, name);

  const fileCount = readSahCount(reader, "file_count");
  for (let index = 0; index < fileCount; index += 1) {
    const filename = readSahString(reader, `file[${index}].name`);
    const offset = reader.i64(`file[${index}].offset`);
    const length = reader.i32(`file[${index}].length`);
    const version = reader.i32(`file[${index}].version`);
    if (length < 0) throw new Error(`${reader.label}: invalid file length ${length}`);
    if (offset + length > safSize) {
      throw new Error(`${reader.label}: ${joinArchivePath(current, filename)} exceeds SAF size`);
    }
    entries.push({ path: joinArchivePath(current, filename), offset, length, version });
  }

  const directoryCount = readSahCount(reader, "directory_count");
  for (let index = 0; index < directoryCount; index += 1) {
    readSahDirectory(reader, current, false, entries, safSize);
  }

  return name;
}

function readSahCount(reader, field) {
  const value = reader.i32(field);
  if (value < 0 || value > 1_000_000) throw new Error(`${reader.label}: invalid ${field} ${value}`);
  return value;
}

function readSahString(reader, field) {
  const length = reader.i32(`${field}.length`);
  if (length < 0 || length > 4096) throw new Error(`${reader.label}: invalid ${field} length ${length}`);
  const bytes = reader.take(length, field);
  const end = bytes.length > 0 && bytes[bytes.length - 1] === 0 ? bytes.length - 1 : bytes.length;
  return archiveTextDecoder.decode(bytes.subarray(0, end));
}

function joinArchivePath(parent, name) {
  const path = normalizePath(parent ? `${parent}/${name}` : name);
  const parts = path.split("/");
  if (path.startsWith("/") || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Unsafe archive path ${path}`);
  }
  return path;
}

function parseEft(buffer, label = "effect") {
  const reader = new BinaryReader(buffer, label);
  const signature = textDecoder.decode(reader.take(3, "signature"));
  if (!["EFT", "EF2", "EF3"].includes(signature)) {
    throw new Error(`${label}: invalid EFT signature ${signature}`);
  }

  const meshCount = reader.count(256, "mesh");
  const meshes = Array.from({ length: meshCount }, (_, index) => reader.modelString(`mesh[${index}]`));

  const textureCount = reader.count(512, "texture");
  const textures = Array.from({ length: textureCount }, (_, index) => reader.modelString(`texture[${index}]`));

  const effectCount = reader.count(1024, "effect");
  const effects = Array.from({ length: effectCount }, (_, index) => parseEftEffect(reader, signature, index));

  const sequenceCount = reader.count(256, "sequence");
  const sequences = Array.from({ length: sequenceCount }, (_, sequenceIndex) => {
    const name = reader.modelString(`sequence[${sequenceIndex}].name`);
    const recordCount = reader.count(100000, `sequence[${sequenceIndex}].record`);
    const records = Array.from({ length: recordCount }, () => ({
      effectId: reader.i32("sequence.effect_id"),
      time: reader.f32("sequence.time"),
    }));
    return { name, records };
  });

  const warnings = [];
  for (const sequence of sequences) {
    sequence.records = sequence.records.filter((record) => {
      if (record.effectId >= 0 && record.effectId < effects.length) return true;
      warnings.push(`${label}: sequence ${sequence.name} references invalid component ${record.effectId}`);
      return false;
    });
  }

  return { format: signature, meshes, textures, effects, sequences, warnings };
}

function parseEftEffect(reader, format, index) {
  const effect = {
    index,
    name: reader.modelString(`effect[${index}].name`),
    velocityRandomEnabled: [
      reader.i32("velocity_random_x") !== 0,
      reader.i32("velocity_random_y") !== 0,
      reader.i32("velocity_random_z") !== 0,
    ],
    loop: reader.i32("loop") !== 0,
    destinationBlend: reader.i32("destination_blend"),
    velocityMode: reader.i32("velocity_mode"),
    sourceBlend: reader.i32("source_blend"),
    textureLoop: reader.i32("texture_loop") !== 0,
    meshIndex: reader.i32("mesh_index"),
    motionPathEnabled: reader.i32("motion_path") !== 0,
    delayPerFrame: reader.f32("delay_per_frame"),
    emitRateMax: reader.f32("emit_rate_max"),
    lifeMax: reader.f32("life_max"),
    emitRateMin: reader.f32("emit_rate_min"),
    lifeMin: reader.f32("life_min"),
    emitterDuration: reader.f32("emitter_duration"),
    swirlSpeed: reader.f32("swirl_speed"),
    unknown18: reader.f32("unknown18"),
    emitPositionSpread: reader.vec3("emit_position_spread"),
    acceleration: reader.vec3("acceleration"),
    emitOrigin: reader.vec3("emit_origin"),
    velocityMin: reader.vec3("velocity_min"),
    velocityMax: reader.vec3("velocity_max"),
    baseAxis: reader.i32("base_axis"),
    gravityEnabled: reader.i32("gravity_enabled") !== 0,
    attractEnabled: reader.i32("attract_enabled") !== 0,
    attractPoint: reader.vec3("attract_point"),
    attractStrength: reader.f32("attract_strength"),
    angularVelocityRandom: reader.i32("angular_velocity_random") !== 0,
    rotationEnabled: reader.i32("rotation_enabled") !== 0,
    angularVelocity: reader.f32("angular_velocity"),
    rotationAxis: reader.i32("rotation_axis"),
    distanceScaleMode: 0,
  };

  if (format === "EF3") {
    reader.i32("ef3_unknown");
    effect.distanceScaleMode = reader.i32("distance_scale_mode");
  }

  effect.colorFrames = Array.from({ length: reader.count(100000, "color_frame") }, () => ({
    color: {
      r: reader.f32("color.r"),
      g: reader.f32("color.g"),
      b: reader.f32("color.b"),
      a: reader.f32("color.a"),
    },
    time: reader.f32("color.time"),
  }));

  effect.velocityScaleFrames = Array.from({ length: reader.count(100000, "velocity_scale_frame") }, () => ({
    value: reader.f32("velocity_scale.value"),
    time: reader.f32("velocity_scale.time"),
  }));

  effect.scaleFrames = Array.from({ length: reader.count(100000, "scale_frame") }, () => ({
    min: reader.f32("scale.min"),
    max: reader.f32("scale.max"),
    time: reader.f32("scale.time"),
  }));

  effect.mirrorTexture = reader.i32("mirror_texture") !== 0;
  effect.initialRotationAxis = reader.i32("initial_rotation_axis");
  effect.initialRotationMinDegrees = reader.i32("initial_rotation_min");
  effect.initialRotationMaxDegrees = reader.i32("initial_rotation_max");
  effect.textureIds = Array.from({ length: reader.count(100000, "texture_id") }, () => reader.i32("texture_id"));

  return effect;
}

function parse3de(buffer, label = "mesh") {
  const reader = new BinaryReader(buffer, label);
  const textureName = reader.modelString("texture_name");
  const vertexCount = reader.count(1000000, "vertex");
  const vertices = Array.from({ length: vertexCount }, () => ({
    position: reader.vec3("vertex.position"),
    boneId: reader.i32("vertex.bone_id"),
    uv: [reader.f32("vertex.u"), reader.f32("vertex.v")],
  }));

  const faceCount = reader.count(1000000, "face");
  const faces = Array.from({ length: faceCount }, () => {
    const face = [reader.u16("face.a"), reader.u16("face.b"), reader.u16("face.c")];
    if (face.some((index) => index >= vertexCount)) throw new Error(`${label}: invalid face index`);
    return face;
  });

  let maxKeyframe = 0;
  let frames = [];
  if (reader.remaining() > 0) {
    maxKeyframe = reader.i32("max_keyframe");
    if (maxKeyframe < 0) throw new Error(`${label}: invalid max keyframe ${maxKeyframe}`);
  }
  if (reader.remaining() > 0) {
    const frameCount = reader.count(100000, "frame");
    frames = Array.from({ length: frameCount }, (_, frameIndex) => ({
      key: reader.i32(`frame[${frameIndex}].key`),
      vertices: Array.from({ length: vertexCount }, () => ({
        position: reader.vec3("frame.vertex.position"),
        uv: [reader.f32("frame.vertex.u"), reader.f32("frame.vertex.v")],
      })),
    }));
  }
  if (reader.remaining() !== 0) throw new Error(`${label}: trailing bytes in 3DE`);
  return { textureName, vertices, faces, maxKeyframe, frames };
}

class AssetStore {
  constructor(log) {
    this.files = new Map();
    this.textureCache = new Map();
    this.log = log;
    this.fallbackTexture = makeFallbackTexture();
  }

  async addFiles(fileList) {
    const files = Array.from(fileList ?? []);
    for (const file of files) {
      this.indexFile(file);
    }

    const sahFiles = files.filter((file) => normalizePath(file.name).endsWith(".sah"));
    for (const sahFile of sahFiles) {
      const safFile = findMatchingSafFile(sahFile, files);
      if (!safFile) {
        this.log(`archive ${sahFile.name}: matching .saf was not selected`);
        continue;
      }
      await this.addArchive(sahFile, safFile);
    }
  }

  indexFile(file, path = file.webkitRelativePath || file.name) {
    const normalized = normalizePath(path);
    this.files.set(normalized, file);
    this.files.set(normalizePath(file.name), file);
  }

  async addArchive(sahFile, safFile) {
    const archive = parseSah(await sahFile.arrayBuffer(), sahFile.name, safFile.size);
    for (const entry of archive.entries) {
      this.indexFile(new ArchiveAsset(safFile, entry), entry.path);
    }
    const countNote = archive.expectedFileCount === archive.entries.length
      ? ""
      : `; header expected ${archive.expectedFileCount}`;
    const trailingNote = archive.trailingBytes === 0
      ? ""
      : `; ignored ${archive.trailingBytes} trailing SAH bytes`;
    this.log(
      `indexed ${archive.entries.length} files from ${sahFile.name}/${safFile.name}${countNote}${trailingNote}`,
    );
  }

  listEffectLibraries() {
    const seen = new Set();
    const libraries = [];
    for (const [path, file] of this.files.entries()) {
      if (!/\.(eft|ef2|ef3)$/.test(path)) continue;
      if (seen.has(file)) continue;
      seen.add(file);
      libraries.push({ path, displayPath: displayAssetPath(path), file });
    }
    libraries.sort((a, b) => a.displayPath.localeCompare(b.displayPath));
    return libraries;
  }

  findFile(candidates) {
    for (const candidate of candidates) {
      const suffix = normalizePath(candidate);
      if (this.files.has(suffix)) return this.files.get(suffix);
      for (const [path, file] of this.files.entries()) {
        if (path.endsWith(`/${suffix}`) || path.endsWith(suffix)) return file;
      }
    }
    return null;
  }

  async readBuffer(candidates) {
    const file = this.findFile(candidates);
    if (!file) return null;
    const path = assetPath(file);
    return { file, path: displayAssetPath(path), fullPath: path, buffer: await file.arrayBuffer() };
  }

  async loadTexture(candidates, mirror = false) {
    const file = this.findFile(candidates);
    if (!file) return { texture: this.fallbackTexture, file: null, path: null };
    const path = assetPath(file);
    const key = `${path}:${mirror ? "mirror" : "repeat"}`;
    if (this.textureCache.has(key)) return this.textureCache.get(key);
    const url = URL.createObjectURL(assetBlob(file));
    try {
      const loader = file.name.toLowerCase().endsWith(".dds") ? new DDSLoader() : new THREE.TextureLoader();
      const texture = await loader.loadAsync(url);
      texture.name = file.name;
      texture.wrapS = mirror ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
      texture.wrapT = mirror ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      const result = { texture, file, path: displayAssetPath(path), fullPath: path };
      this.textureCache.set(key, result);
      return result;
    } catch (error) {
      this.log(`texture ${file.name}: ${error.message}`);
      return { texture: this.fallbackTexture, file: null, path: null };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function findMatchingSafFile(sahFile, files) {
  const sahPath = assetPath(sahFile);
  const expectedPath = sahPath.replace(/\.sah$/i, ".saf");
  const expectedName = normalizePath(sahFile.name).replace(/\.sah$/i, ".saf");

  return files.find((file) => assetPath(file) === expectedPath)
    || files.find((file) => normalizePath(file.name) === expectedName)
    || null;
}

function assetPath(file) {
  return normalizePath(file.webkitRelativePath || file.name);
}

function assetBlob(file) {
  return file instanceof Blob ? file : file.blob();
}

class EffectPreview {
  constructor(scene, camera, assetStore, log) {
    this.scene = scene;
    this.camera = camera;
    this.assetStore = assetStore;
    this.log = log;
    this.group = new THREE.Group();
    this.group.name = "effect-preview";
    this.scene.add(this.group);
    this.library = null;
    this.objects = [];
    this.startedAt = performance.now();
    this.playbackDuration = 1;
    this.replayDelaySeconds = 1;
    this.paused = false;
    this.placement = defaultPlacement;
  }

  setLibrary(library) {
    this.library = library;
    this.startedAt = performance.now();
  }

  setPlacement(placement) {
    this.placement = placement;
  }

  setReplayDelaySeconds(seconds) {
    this.replayDelaySeconds = Math.max(0, seconds);
  }

  clear() {
    for (const object of this.objects) object.dispose();
    this.objects = [];
    this.group.clear();
  }

  async rebuild(selection, particleLevel) {
    this.clear();
    if (!this.library) return;
    const records = selectedEffectRecords(this.library, selection);
    this.playbackDuration = effectRecordsDuration(records);
    for (const record of records) {
      const effect = this.library.effects[record.effectId];
      const resources = await this.loadResources(effect);
      const particleCount = Math.min(effectParticleCount(effect, particleLevel), maxRenderedParticlesPerComponent);
      if (particleCount <= 0) continue;
      const emitter = new RenderedEffectEmitter(effect, resources, record.startTime, particleCount, record.effectId * 977 + 1);
      this.objects.push(emitter);
      emitter.addTo(this.group);
    }
    this.startedAt = performance.now();
  }

  async loadResources(effect) {
    let mesh = null;
    let meshPath = null;
    if (effect.meshIndex >= 0 && effect.meshIndex < this.library.meshes.length) {
      const meshName = this.library.meshes[effect.meshIndex];
      const loaded = await this.assetStore.readBuffer([
        `effect/3de/${meshName}`,
        meshName,
      ]);
      if (loaded) {
        try {
          mesh = parse3de(loaded.buffer, loaded.file.name);
          meshPath = loaded.path;
        } catch (error) {
          this.log(`mesh ${loaded.file.name}: ${error.message}`);
        }
      } else {
        this.log(`missing mesh ${meshName} for component ${effect.index}: ${effect.name || "(unnamed)"}`);
      }
    }

    const textures = [];
    const texturePaths = [];
    for (const textureId of effect.textureIds) {
      if (textureId < 0 || textureId >= this.library.textures.length) {
        textures.push(this.assetStore.fallbackTexture);
        texturePaths.push("fallback");
        continue;
      }
      const name = this.library.textures[textureId];
      const loaded = await this.assetStore.loadTexture([
        `effect/dds/${name}`,
        name,
      ], effect.mirrorTexture);
      textures.push(loaded.texture);
      texturePaths.push(loaded.path || `missing:${name}`);
    }

    if (textures.length === 0 && mesh?.textureName) {
      const loaded = await this.assetStore.loadTexture([
        `effect/dds/${mesh.textureName}`,
        `entity/texture/${mesh.textureName}`,
        mesh.textureName,
      ], effect.mirrorTexture);
      textures.push(loaded.texture);
      texturePaths.push(loaded.path || `missing:${mesh.textureName}`);
    }

    if (textures.length === 0) {
      textures.push(this.assetStore.fallbackTexture);
      texturePaths.push("fallback");
    }
    if (meshPath) this.log(`component ${effect.index} mesh: ${meshPath}`);
    if (texturePaths.some((path) => path?.startsWith("missing:"))) {
      this.log(`component ${effect.index} textures: ${texturePaths.join(", ")}`);
    }
    return { mesh, textures };
  }

  update() {
    if (this.paused) return;
    const elapsed = (performance.now() - this.startedAt) / 1000;
    const cycleDuration = Math.max(0.001, this.playbackDuration + this.replayDelaySeconds);
    const seconds = positiveMod(elapsed, cycleDuration);
    if (seconds >= this.playbackDuration) {
      for (const object of this.objects) object.hide();
      return;
    }
    const basis = cameraBasis(this.camera);
    for (const object of this.objects) object.update(seconds, basis, this.placement);
  }
}

class RenderedEffectEmitter {
  constructor(effect, resources, startTime, particleCount, seed) {
    this.effect = effect;
    this.resources = resources;
    this.startTime = startTime;
    this.seed = seed;
    this.elapsed = 0;
    this.lastLocalSeconds = null;
    this.remainingDuration = effect.emitterDuration;
    this.emitAccumulator = 0;
    this.spawnCounter = 0;
    this.oneShotEmitted = false;
    this.particles = Array.from({ length: particleCount }, (_, index) => (
      new RenderedEffectParticle(effect, resources, seed + index * 1009)
    ));
    this.states = Array.from({ length: particleCount }, () => null);
  }

  addTo(group) {
    for (const particle of this.particles) group.add(particle.object);
  }

  update(seconds, cameraBasis, placementBasis) {
    const localSeconds = seconds - this.startTime;
    if (localSeconds < 0) {
      this.hide();
      return;
    }

    if (this.lastLocalSeconds === null || localSeconds < this.lastLocalSeconds) {
      this.reset();
    }

    let remaining = Math.min(localSeconds - this.lastLocalSeconds, maxCatchUpSeconds);
    while (remaining > 0) {
      const step = Math.min(simulationStepSeconds, remaining);
      this.step(step);
      remaining -= step;
    }
    this.lastLocalSeconds = localSeconds;

    for (let index = 0; index < this.particles.length; index += 1) {
      const state = this.states[index];
      if (state?.active) {
        this.particles[index].show(state, cameraBasis, placementBasis, localSeconds);
      } else {
        this.particles[index].hide();
      }
    }
  }

  step(delta) {
    this.elapsed += delta;
    for (const state of this.states) {
      if (state?.active) updateParticleState(state, this.effect, delta);
    }

    if (!emitsParticles(this.effect)) {
      if (!this.oneShotEmitted) {
        this.spawnParticle(sampledParticleLife(this.effect, this.seed));
        this.oneShotEmitted = true;
      }
      return;
    }

    const previousDuration = this.remainingDuration;
    this.remainingDuration -= delta;
    let count = 0;

    if (isOneShotEmitter(this.effect)) {
      const crossedDuration = previousDuration > 0 && this.remainingDuration <= 0;
      if (this.effect.loop || (!this.oneShotEmitted && (crossedDuration || this.effect.emitterDuration <= 0))) {
        count = 1;
        this.oneShotEmitted = true;
      }
    } else {
      if (!this.effect.loop && previousDuration <= 0) return;
      const rate = randomRange(this.effect.emitRateMin, this.effect.emitRateMax, this.seed + this.elapsed * 97.13);
      const produced = Math.max(0, rate) * delta + this.emitAccumulator;
      count = Math.floor(produced);
      this.emitAccumulator = produced - count;
      if (!this.effect.loop && this.remainingDuration <= 0) count = 0;
      count = Math.min(count, 200);
    }

    for (let index = 0; index < count; index += 1) {
      this.spawnParticle(sampledParticleLife(this.effect, this.seed + this.spawnCounter * 37.17));
    }
  }

  spawnParticle(life) {
    const index = this.states.findIndex((state) => !state?.active);
    if (index < 0) return;
    const seed = this.seed + this.spawnCounter * 37.17 + index * 1009;
    this.spawnCounter += 1;
    this.states[index] = createParticleState(this.effect, seed, life, this.resources.mesh, this.elapsed);
  }

  reset() {
    this.elapsed = 0;
    this.lastLocalSeconds = 0;
    this.remainingDuration = this.effect.emitterDuration;
    this.emitAccumulator = 0;
    this.spawnCounter = 0;
    this.oneShotEmitted = false;
    this.states.fill(null);
    this.hide();
  }

  hide() {
    for (const particle of this.particles) particle.hide();
  }

  dispose() {
    for (const particle of this.particles) particle.dispose();
  }
}

class RenderedEffectParticle {
  constructor(effect, resources, seed) {
    this.effect = effect;
    this.resources = resources;
    this.seed = seed;
    this.usesMesh = Boolean(resources.mesh && !effect.motionPathEnabled && effect.meshIndex >= 0);

    if (this.usesMesh) {
      const geometry = create3deGeometry(resources.mesh, sample3de(resources.mesh, 0));
      this.geometry = geometry;
      this.material = createEffectMaterial(effect, resources.textures[0]);
      this.object = new THREE.Mesh(geometry, this.material);
    } else {
      this.geometry = createBillboardGeometry(effect.mirrorTexture);
      this.material = createEffectMaterial(effect, resources.textures[0]);
      this.object = new THREE.Mesh(this.geometry, this.material);
    }
    this.object.visible = false;
  }

  show(state, cameraBasis, placementBasis, textureSeconds) {
    const effect = this.effect;
    const renderPosition = effect.velocityMode === 0 ? state.position : add3(state.position, state.velocity);
    const scale = Math.max(0.001, scaleAt(effect, state.age, state.seed));
    const color = colorAt(effect, state.age);
    const opacity = clamp(color.a, 0, 1);
    const texture = selectTexture(effect, this.resources.textures, textureSeconds);
    if (this.material.map !== texture) {
      this.material.map = texture;
      this.material.needsUpdate = true;
    }

    this.material.color.setRGB(clamp(color.r, 0, 4), clamp(color.g, 0, 4), clamp(color.b, 0, 4));
    this.material.opacity = opacity;

    const worldOffset = add3(placementBasis.position, renderPosition);
    const orientation = effectUsesPlacementBasis(effect.baseAxis)
      ? placementBasis
      : effectOrientationBasis(effect.baseAxis, cameraBasis);
    const spinAxis = effect.rotationEnabled ? axisVector(effect.rotationAxis) : null;
    const initialAxis = axisVector(effect.initialRotationAxis);
    if (this.usesMesh && this.resources.mesh.frames.length > 0) {
      update3deGeometry(this.geometry, this.resources.mesh, sample3de(this.resources.mesh, textureSeconds * 30));
    }

    const billboardRotationSign = this.usesMesh ? 1 : -1;
    const initial = initialAxis
      ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...initialAxis), state.initialRotation * billboardRotationSign)
      : new THREE.Quaternion();
    const spin = spinAxis
      ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...spinAxis), state.rotation * billboardRotationSign)
      : new THREE.Quaternion();
    const localRotation = initial.multiply(spin);
    const basisRotation = quaternionFromBasis(orientation);

    this.object.position.set(worldOffset[0], worldOffset[1], worldOffset[2]);
    this.object.scale.setScalar(scale);
    this.object.quaternion.copy(basisRotation.multiply(localRotation));
    this.object.visible = true;
  }

  dispose() {
    this.geometry?.dispose();
    this.material?.dispose();
  }

  hide() {
    this.object.visible = false;
  }
}

function selectedEffectIds(library, selection) {
  return [...new Set(selectedEffectRecords(library, selection).map((record) => record.effectId))];
}

function selectedEffectRecords(library, selection) {
  if (selection.effectIndex >= 0) {
    const effect = library.effects[selection.effectIndex];
    return [{ effectId: selection.effectIndex, startTime: 0, duration: effectPlaybackDuration(effect) }];
  }
  const sequence = library.sequences[selection.sequenceIndex] ?? library.sequences[0];
  if (!sequence) {
    const effect = library.effects[0];
    return effect ? [{ effectId: 0, startTime: 0, duration: effectPlaybackDuration(effect) }] : [];
  }
  return sequence.records
    .map((record, order) => ({
      effectId: record.effectId,
      startTime: Math.max(0, record.time),
      order,
    }))
    .sort((a, b) => a.startTime - b.startTime || a.order - b.order)
    .map((record) => {
      const effect = library.effects[record.effectId];
      const duration = effectPlaybackDuration(effect);
      return { effectId: record.effectId, startTime: record.startTime, duration };
    });
}

function effectRecordsDuration(records) {
  return Math.max(1, ...records.map((record) => record.startTime + record.duration));
}

function create3deGeometry(model, sample) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(model.vertices.length * 3);
  const uvs = new Float32Array(model.vertices.length * 2);
  const indices = new Uint32Array(model.faces.flat());
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  update3deGeometry(geometry, model, sample);
  return geometry;
}

function createEffectMaterial(effect, texture) {
  return new THREE.MeshBasicMaterial({
    map: texture,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

function createBillboardGeometry(mirrorTexture) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    -0.5, 0.5, 0,
    0.5, 0.5, 0,
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
  ]), 3));
  const uv = mirrorTexture ? [
    -1, 0,
    1, 0,
    -1, 2,
    1, 2,
  ] : [
    0, 0,
    1, 0,
    0, 1,
    1, 1,
  ];
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 2, 1, 3]), 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function update3deGeometry(geometry, model, sample) {
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  for (let index = 0; index < model.vertices.length; index += 1) {
    const vertex = sample3deVertex(model, sample, index);
    position.setXYZ(index, vertex.position[0], vertex.position[1], vertex.position[2]);
    uv.setXY(index, vertex.uv[0], vertex.uv[1]);
  }
  position.needsUpdate = true;
  uv.needsUpdate = true;
  geometry.computeBoundingSphere();
}

function sample3de(model, tick) {
  if (model.frames.length === 0) return null;
  if (model.frames.length === 1 || model.maxKeyframe === 0) return { current: 0, next: 0, amount: 0 };
  const period = model.maxKeyframe + 1;
  const localTick = positiveMod(Math.max(0, tick), period);
  const firstKey = model.frames[0].key;
  if (localTick < firstKey) {
    const last = model.frames.length - 1;
    return {
      current: last,
      next: 0,
      amount: interpolationAmount(model.frames[last].key - period, firstKey, localTick),
    };
  }
  for (let index = 1; index < model.frames.length; index += 1) {
    const nextKey = model.frames[index].key;
    if (localTick < nextKey) {
      return {
        current: index - 1,
        next: index,
        amount: interpolationAmount(model.frames[index - 1].key, nextKey, localTick),
      };
    }
  }
  const last = model.frames.length - 1;
  return {
    current: last,
    next: 0,
    amount: interpolationAmount(model.frames[last].key, firstKey + period, localTick),
  };
}

function sample3deVertex(model, sample, index) {
  if (!sample) return model.vertices[index];
  const current = model.frames[sample.current].vertices[index];
  const next = model.frames[sample.next].vertices[index];
  return {
    position: [
      lerp(current.position[0], next.position[0], sample.amount),
      lerp(current.position[1], next.position[1], sample.amount),
      lerp(current.position[2], next.position[2], sample.amount),
    ],
    uv: [
      lerp(current.uv[0], next.uv[0], sample.amount),
      lerp(current.uv[1], next.uv[1], sample.amount),
    ],
  };
}

function selectTexture(effect, textures, seconds) {
  if (textures.length <= 1) return textures[0];
  const frameTime = Math.max(0.033, Math.abs(effect.delayPerFrame));
  const frame = Math.floor(seconds / frameTime);
  const index = effect.textureLoop ? frame % textures.length : Math.min(frame, textures.length - 1);
  return textures[index];
}

function effectParticleCount(effect, level) {
  level = clamp(level, 0, maxParticleLevel);
  // Some EFT components are authored as a single stamped mesh/billboard rather
  // than as particle emitters. The retail client still draws those components
  // even when their emission rate or lifetime is zero.
  if (!emitsParticles(effect)) return 1;
  if (level === 0) return 0;
  if (isOneShotEmitter(effect)) return 1;
  const multiplier = level / 5;
  const averageRate = averageEmissionRate(effect);
  const averageLife = Math.max(1 / 30, (Math.max(0, effect.lifeMin) + Math.max(0, effect.lifeMax)) * 0.5);
  const emissionWindow = effect.loop
    ? averageLife
    : Math.max(averageLife, effect.emitterDuration);
  return Math.floor(clamp(Math.ceil(averageRate * emissionWindow * multiplier), 1, Math.floor(200 * multiplier)));
}

function emitsParticles(effect) {
  return Math.max(effect.emitRateMin, effect.emitRateMax) > 0
    && Math.max(effect.lifeMin, effect.lifeMax) > 0;
}

function effectDuration(effect) {
  let duration = 1;
  if (effect.colorFrames.length > 0) duration = Math.max(duration, effect.colorFrames.at(-1).time);
  if (effect.velocityScaleFrames.length > 0) duration = Math.max(duration, effect.velocityScaleFrames.at(-1).time);
  if (effect.scaleFrames.length > 0) duration = Math.max(duration, effect.scaleFrames.at(-1).time);
  return duration;
}

function effectPlaybackDuration(effect) {
  let duration = effectDuration(effect);
  if (effect.lifeMax > 0) duration = Math.max(duration, effect.lifeMax);
  if (effect.emitterDuration > 0) {
    duration = Math.max(duration, effect.emitterDuration + Math.max(0, effect.lifeMax));
  }
  return Math.max(0.25, duration);
}

function colorAt(effect, time) {
  const frames = effect.colorFrames;
  if (frames.length === 0) return { r: 1, g: 1, b: 1, a: 1 };
  if (time <= frames[0].time) return frames[0].color;
  for (let index = 1; index < frames.length; index += 1) {
    if (time <= frames[index].time) {
      const previous = frames[index - 1];
      const next = frames[index];
      const amount = clamp((time - previous.time) / Math.max(0.0001, next.time - previous.time), 0, 1);
      return {
        r: lerp(previous.color.r, next.color.r, amount),
        g: lerp(previous.color.g, next.color.g, amount),
        b: lerp(previous.color.b, next.color.b, amount),
        a: lerp(previous.color.a, next.color.a, amount),
      };
    }
  }
  return frames.at(-1).color;
}

function scaleAt(effect, time, seed) {
  const frames = effect.scaleFrames;
  if (frames.length === 0) return 0.3;
  const value = (frame, index) => lerp(frame.min, frame.max, randomValue(seed + 157.3 + index * 23.7));
  if (time <= frames[0].time) return value(frames[0], 0);
  for (let index = 1; index < frames.length; index += 1) {
    if (time <= frames[index].time) {
      const previous = frames[index - 1];
      const next = frames[index];
      return lerp(
        value(previous, index - 1),
        value(next, index),
        clamp((time - previous.time) / Math.max(0.0001, next.time - previous.time), 0, 1),
      );
    }
  }
  return value(frames.at(-1), frames.length - 1);
}

function velocityScaleAt(effect, time) {
  const frames = effect.velocityScaleFrames;
  if (frames.length === 0) return 0;
  if (time <= frames[0].time) return frames[0].value;
  for (let index = 1; index < frames.length; index += 1) {
    if (time <= frames[index].time) {
      const previous = frames[index - 1];
      const next = frames[index];
      return lerp(previous.value, next.value, clamp((time - previous.time) / Math.max(0.0001, next.time - previous.time), 0, 1));
    }
  }
  return frames.at(-1).value;
}

function createParticleState(effect, seed, life, pathMesh, spawnSeconds) {
  const randomAmount = [
    randomValue(seed),
    randomValue(seed + 19.1),
    randomValue(seed + 47.7),
  ];
  let position = [...effect.emitOrigin];
  if (pathMesh && effect.motionPathEnabled && pathMesh.vertices.length > 0) {
    const pathSample = sample3de(pathMesh, spawnSeconds * 30);
    const pathVertex = sample3deVertex(pathMesh, pathSample, pathMesh.vertices.length - 1);
    position = add3(position, pathVertex.position);
  }
  position = add3(position, [
    (randomAmount[0] * 2 - 1) * effect.emitPositionSpread[0],
    (randomAmount[1] * 2 - 1) * effect.emitPositionSpread[1],
    (randomAmount[2] * 2 - 1) * effect.emitPositionSpread[2],
  ]);

  const angularVelocity = effect.angularVelocityRandom
    ? randomRange(Math.min(0, effect.angularVelocity), Math.max(0, effect.angularVelocity), seed + 131.1)
    : effect.angularVelocity;

  return {
    active: true,
    seed,
    age: 0,
    life,
    position,
    velocity: randomVelocity(effect, seed),
    rotation: 0,
    angularVelocity,
    initialRotation: initialRotation(effect, seed),
  };
}

function updateParticleState(state, effect, delta) {
  state.age += delta;
  if (state.age > state.life) {
    state.active = false;
    return;
  }

  for (let axis = 0; axis < 3; axis += 1) {
    if (effect.velocityRandomEnabled[axis]) {
      state.velocity[axis] = randomRange(
        effect.velocityMin[axis],
        effect.velocityMax[axis],
        state.seed + state.age * 997.3 + axis * 31.7,
      );
    }
  }

  applyVelocityMode(state, effect, delta);
  const velocityScale = velocityScaleAt(effect, state.age);
  if (Math.abs(velocityScale) > 0.0001) {
    state.velocity = add3(state.velocity, mul3(state.velocity, velocityScale * delta));
  }

  if (effect.attractEnabled) {
    const direction = normalize3([
      effect.attractPoint[0] - state.position[0],
      effect.attractPoint[1] - state.position[1],
      effect.attractPoint[2] - state.position[2],
    ], [0, 0, 0]);
    state.velocity = add3(state.velocity, mul3(direction, effect.attractStrength * delta));
  }

  if (effect.gravityEnabled) {
    state.velocity = add3(state.velocity, mul3(effect.acceleration, delta));
  }

  if (effect.rotationEnabled) {
    state.rotation += state.angularVelocity * delta;
  }
}

function applyVelocityMode(state, effect, delta) {
  const swirl = effect.swirlSpeed * delta;
  switch (effect.velocityMode) {
    case 0:
      state.position = add3(state.position, mul3(state.velocity, delta));
      break;
    case 1:
      state.velocity = rotateXZ(state.velocity, swirl);
      state.velocity = add3(state.velocity, mul3(randomVelocity(effect, state.seed + state.age * 313.1), delta));
      break;
    case 2:
      state.velocity = rotateXY(state.velocity, swirl);
      state.velocity = add3(state.velocity, mul3(randomVelocity(effect, state.seed + state.age * 313.1), delta));
      break;
    case 3:
      state.velocity = rotateYZ(state.velocity, swirl);
      state.velocity = add3(state.velocity, mul3(randomVelocity(effect, state.seed + state.age * 313.1), delta));
      break;
    default:
      state.position = add3(state.position, mul3(state.velocity, delta));
      break;
  }
}

function randomVelocity(effect, seed) {
  return [
    randomRange(effect.velocityMin[0], effect.velocityMax[0], seed + 3.1),
    randomRange(effect.velocityMin[1], effect.velocityMax[1], seed + 7.7),
    randomRange(effect.velocityMin[2], effect.velocityMax[2], seed + 11.3),
  ];
}

function sampledParticleLife(effect, seed) {
  const min = Math.max(0, effect.lifeMin);
  const max = Math.max(min, effect.lifeMax);
  if (max <= 0) return effectPlaybackDuration(effect);
  return lerp(min, max, randomValue(seed + 71.3));
}

function averageEmissionRate(effect) {
  return Math.max(0, (effect.emitRateMin + effect.emitRateMax) * 0.5);
}

function isOneShotEmitter(effect) {
  return !effect.loop
    && Math.abs(effect.emitRateMin - 1) < 0.0001
    && Math.abs(effect.emitRateMax - 1) < 0.0001;
}

function threeBlendFactor(blend, role) {
  // ps0198 indexes a 32-byte table at game.exe VA 0x7138BC. That table starts
  // one D3DBLEND enum after ZERO, so the effective D3D value is `blend + 1`.
  if (blend === 0) return THREE.ZeroFactor;
  if (blend === 1) return THREE.OneFactor;
  if (blend === 2) return THREE.SrcColorFactor;
  if (blend === 3) return THREE.OneMinusSrcColorFactor;
  if (blend === 4) return THREE.SrcAlphaFactor;
  if (blend === 5) return THREE.OneMinusSrcAlphaFactor;
  if (blend === 6) return THREE.DstAlphaFactor;
  if (blend === 7) return THREE.OneMinusDstAlphaFactor;
  if (blend === 8) return THREE.DstColorFactor;
  if (blend === 9) return THREE.OneMinusDstColorFactor;
  if (blend === 10) return role === "source" ? THREE.SrcAlphaSaturateFactor : THREE.OneFactor;
  if (blend === 11) return role === "source" ? THREE.SrcAlphaFactor : THREE.OneFactor;
  return THREE.OneFactor;
}

function axisVector(axis) {
  if (axis === 1) return [1, 0, 0];
  if (axis === 2) return [0, 1, 0];
  if (axis === 3) return [0, 0, 1];
  return null;
}

function cameraBasis(camera) {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  return {
    right: normalize3([e[0], e[1], e[2]], [1, 0, 0]),
    up: normalize3([e[4], e[5], e[6]], [0, 1, 0]),
    // Three.js cameras look down local -Z. The effect quad's local +Z should
    // face the camera, so use the camera's world +Z column for inverse-view
    // billboards instead of getWorldDirection().
    forward: normalize3([e[8], e[9], e[10]], [0, 0, 1]),
  };
}

function placementFromEulerDegrees(position, yawDegrees, pitchDegrees, rollDegrees) {
  const euler = new THREE.Euler(
    degreesToRadians(pitchDegrees),
    degreesToRadians(yawDegrees),
    degreesToRadians(rollDegrees),
    "YXZ",
  );
  const matrix = new THREE.Matrix4().makeRotationFromEuler(euler);
  const e = matrix.elements;
  return {
    position,
    right: normalize3([e[0], e[1], e[2]], defaultPlacementBasis.right),
    up: normalize3([e[4], e[5], e[6]], defaultPlacementBasis.up),
    forward: normalize3([e[8], e[9], e[10]], defaultPlacementBasis.forward),
  };
}

function effectOrientationBasis(baseAxis, camera) {
  if (baseAxis === 1) {
    return {
      right: [1, 0, 0],
      up: [0, 0, 1],
      forward: [0, -1, 0],
    };
  }

  if (baseAxis === 2) {
    const horizontalForward = normalize3([camera.forward[0], 0, camera.forward[2]], [0, 0, 1]);
    const horizontalRight = normalize3([camera.right[0], 0, camera.right[2]], [horizontalForward[2], 0, -horizontalForward[0]]);
    return {
      right: horizontalRight,
      up: [0, 1, 0],
      forward: horizontalForward,
    };
  }

  if (baseAxis === 3) {
    return defaultPlacementBasis;
  }

  return camera;
}

function effectUsesPlacementBasis(baseAxis) {
  return baseAxis === 3;
}

function quaternionFromBasis(basis) {
  const matrix = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...basis.right),
    new THREE.Vector3(...basis.up),
    new THREE.Vector3(...basis.forward),
  );
  return new THREE.Quaternion().setFromRotationMatrix(matrix);
}

function initialRotation(effect, seed) {
  const min = effect.initialRotationMinDegrees;
  const max = effect.initialRotationMaxDegrees;
  const amount = randomValue(seed + 103.7);
  let degrees;
  if (max >= min) {
    degrees = lerp(min, max, amount);
  } else if (amount < 0.5) {
    degrees = lerp(0, max, amount * 2);
  } else {
    degrees = lerp(min, 360, (amount - 0.5) * 2);
  }
  return THREE.MathUtils.degToRad(degrees);
}

function makeFallbackTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.45, "rgba(80,190,255,0.65)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.?\//, "").toLowerCase();
}

function displayAssetPath(path) {
  for (const marker of ["effect/", "entity/texture/"]) {
    const index = path.indexOf(marker);
    if (index >= 0) return path.slice(index);
  }
  return path;
}

function randomValue(value) {
  return fract(Math.sin(value * 12.9898) * 43758.5453);
}

function randomRange(min, max, seed) {
  if (max < min) return lerp(max, min, randomValue(seed));
  return lerp(min, max, randomValue(seed));
}

function fract(value) {
  return value - Math.floor(value);
}

function lerp(a, b, amount) {
  return a + (b - a) * amount;
}

function degreesToRadians(degrees) {
  return degrees * Math.PI / 180;
}

function interpolationAmount(previous, next, value) {
  return clamp((value - previous) / Math.max(0.0001, next - previous), 0, 1);
}

function positiveMod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function mul3(a, scalar) {
  return [a[0] * scalar, a[1] * scalar, a[2] * scalar];
}

function rotateXZ(value, radians) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    cos * value[0] - sin * value[2],
    value[1],
    sin * value[0] + cos * value[2],
  ];
}

function rotateXY(value, radians) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    sin * value[1] + cos * value[0],
    cos * value[1] - sin * value[0],
    value[2],
  ];
}

function rotateYZ(value, radians) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    value[0],
    sin * value[2] + cos * value[1],
    cos * value[2] - sin * value[1],
  ];
}

function lengthSq3(value) {
  return value[0] * value[0] + value[1] * value[1] + value[2] * value[2];
}

function normalize3(value, fallback) {
  const lengthSq = lengthSq3(value);
  if (lengthSq < 0.000001) return fallback;
  const inv = 1 / Math.sqrt(lengthSq);
  return [value[0] * inv, value[1] * inv, value[2] * inv];
}

const viewport = document.querySelector("#viewport");
const logElement = document.querySelector("#log");
const libraryStats = document.querySelector("#libraryStats");
const renderStats = document.querySelector("#renderStats");
const effectStats = document.querySelector("#effectStats");
const assetStatus = document.querySelector("#assetStatus");
const assetStatusTitle = document.querySelector("#assetStatusTitle");
const assetStatusDetail = document.querySelector("#assetStatusDetail");
const directoryModeButton = document.querySelector("#directoryModeButton");
const archiveModeButton = document.querySelector("#archiveModeButton");
const dataRootLabel = document.querySelector("#dataRootLabel");
const dataArchiveLabel = document.querySelector("#dataArchiveLabel");
const dataRootInput = document.querySelector("#dataRootInput");
const dataArchiveInput = document.querySelector("#dataArchiveInput");
const libraryTabButton = document.querySelector("#libraryTabButton");
const skillTabButton = document.querySelector("#skillTabButton");
const libraryTab = document.querySelector("#libraryTab");
const skillTab = document.querySelector("#skillTab");
const libraryFileSelect = document.querySelector("#libraryFileSelect");
const sequenceSelect = document.querySelector("#sequenceSelect");
const effectSelect = document.querySelector("#effectSelect");
const skillClassSelect = document.querySelector("#skillClassSelect");
const skillSelect = document.querySelector("#skillSelect");
const skillSequenceSelect = document.querySelector("#skillSequenceSelect");
const skillEffectDetail = document.querySelector("#skillEffectDetail");
const skillRoleButtons = Array.from(document.querySelectorAll("[data-skill-role]"));
const particleLevel = document.querySelector("#particleLevel");
const particleLevelLabel = document.querySelector("#particleLevelLabel");
const replayDelaySeconds = document.querySelector("#replayDelaySeconds");
const placementInputs = {
  x: document.querySelector("#placementX"),
  y: document.querySelector("#placementY"),
  z: document.querySelector("#placementZ"),
  yaw: document.querySelector("#placementYaw"),
  pitch: document.querySelector("#placementPitch"),
  roll: document.querySelector("#placementRoll"),
};
let indexedLibraries = [];
let activeBrowserTab = "library";
let selectedSkillRole = "startCast";
let skillNameOverrides = new Map();
const defaultSkillRolePriority = [
  "secondaryOrStop",
  "startCast",
  "casting",
  "castProjectile",
  "area",
  "target",
];
const skillRoleLabels = new Map([
  ["secondaryOrStop", "Secondary/Status"],
]);

function log(message) {
  logElement.textContent = `${new Date().toLocaleTimeString()} ${message}\n${logElement.textContent}`.slice(0, 6000);
}

function setAssetStatus(kind, title, detail) {
  assetStatus.className = `status-card status-${kind}`;
  assetStatusTitle.textContent = title;
  assetStatusDetail.textContent = detail;
}

function updateIndexedEffectStatus(sourceLabel) {
  if (indexedLibraries.length === 0) {
    setAssetStatus("empty", "No effects found", `${sourceLabel}; no EFT, EF2, or EF3 files were indexed.`);
    return;
  }

  const noun = indexedLibraries.length === 1 ? "effect library" : "effect libraries";
  setAssetStatus(
    "ready",
    `${indexedLibraries.length} ${noun} available`,
    `${sourceLabel}; choose one from the EFT list below.`,
  );
}

async function refreshSkillNamesFromIndexedData() {
  const selectedId = Number(skillSelect.value);
  const loaded = await assetStore.readBuffer([
    "data/character/skill.sdata",
    "character/skill.sdata",
    "skill.sdata",
  ]);

  if (!loaded) {
    skillNameOverrides = new Map();
    populateSkillSelect(selectedId);
    updateSkillEffectDetail(selectedRole());
    log("skill names: no skill.sdata found; using built-in catalogue names");
    return "using built-in skill names";
  }

  try {
    const names = parseSkillSdataNames(loaded.buffer);
    skillNameOverrides = names;
    populateSkillSelect(selectedId);
    updateSkillEffectDetail(selectedRole());
    const visibleNameCount = skillCatalogue.skills
      .filter((skill) => skillHasAnyEffect(skill) && names.has(skill.id))
      .length;
    log(`loaded ${visibleNameCount} displayed skill names from ${loaded.path}`);
    return `loaded ${visibleNameCount} skill names from ${loaded.path}`;
  } catch (error) {
    skillNameOverrides = new Map();
    populateSkillSelect(selectedId);
    updateSkillEffectDetail(selectedRole());
    log(`skill names: ${loaded.path}: ${error.message}; using built-in catalogue names`);
    return "using built-in skill names";
  }
}

function effectLoadSummary(library) {
  return `${library.format}: ${library.effects.length} components, ${library.sequences.length} sequences, ${library.meshes.length} meshes, ${library.textures.length} textures`;
}

function setDataSourceMode(mode) {
  const archiveMode = mode === "archive";
  directoryModeButton.classList.toggle("active", !archiveMode);
  archiveModeButton.classList.toggle("active", archiveMode);
  directoryModeButton.setAttribute("aria-pressed", String(!archiveMode));
  archiveModeButton.setAttribute("aria-pressed", String(archiveMode));
  dataRootLabel.hidden = archiveMode;
  dataArchiveLabel.hidden = !archiveMode;
}

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0x0d0f13, 1);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x101114, 80, 220);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
camera.position.set(0, 18, 42);
camera.lookAt(0, 6, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 5, 0);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x20222a, 1.2));
const grid = new THREE.GridHelper(60, 30, 0x445064, 0x242a34);
scene.add(grid);

const assetStore = new AssetStore(log);
const preview = new EffectPreview(scene, camera, assetStore, log);
preview.setPlacement(readPlacementControls());
preview.setReplayDelaySeconds(readNumericInput(replayDelaySeconds));
resetSelectors("Load an EFT file first");
populateLibraryFileSelect([]);
populateSkillBrowser();
setBrowserTab("library");

directoryModeButton.addEventListener("click", () => setDataSourceMode("directory"));
archiveModeButton.addEventListener("click", () => setDataSourceMode("archive"));
libraryTabButton.addEventListener("click", () => setBrowserTab("library"));
skillTabButton.addEventListener("click", () => setBrowserTab("skill"));
skillClassSelect.addEventListener("change", () => {
  populateSkillSelect();
  selectDefaultSkillRole();
});
skillSelect.addEventListener("change", () => selectDefaultSkillRole());
skillSequenceSelect.addEventListener("change", () => loadSelectedSkillEffect());
for (const button of skillRoleButtons) {
  button.addEventListener("click", () => selectSkillRole(button.dataset.skillRole));
}

dataRootInput.addEventListener("change", async (event) => {
  await assetStore.addFiles(event.target.files);
  const skillNameStatus = await refreshSkillNamesFromIndexedData();
  indexedLibraries = assetStore.listEffectLibraries();
  populateLibraryFileSelect(indexedLibraries);
  updateIndexedEffectStatus(`Indexed ${event.target.files.length} data files; ${skillNameStatus}`);
  log(`indexed ${event.target.files.length} files from data directory; found ${indexedLibraries.length} EFT libraries`);
  if (preview.library) await rebuild();
});

dataArchiveInput.addEventListener("change", async (event) => {
  await assetStore.addFiles(event.target.files);
  const skillNameStatus = await refreshSkillNamesFromIndexedData();
  indexedLibraries = assetStore.listEffectLibraries();
  populateLibraryFileSelect(indexedLibraries);
  updateIndexedEffectStatus(`Indexed ${event.target.files.length} archive files; ${skillNameStatus}`);
  log(`indexed ${event.target.files.length} archive files; found ${indexedLibraries.length} EFT libraries`);
  if (preview.library) await rebuild();
});

libraryFileSelect.addEventListener("change", async () => {
  const entry = indexedLibraries[Number(libraryFileSelect.value)];
  if (!entry) return;
  await loadEftFile(entry.file, entry.path);
});

document.querySelector("#eftInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  await assetStore.addFiles(event.target.files);
  indexedLibraries = assetStore.listEffectLibraries();
  populateLibraryFileSelect(indexedLibraries);
  await loadEftFile(file, file.name);
});

async function loadEftFile(file, label, selectorOptions = {}) {
  try {
    const library = parseEft(await file.arrayBuffer(), file.name);
    preview.setLibrary(library);
    populateSelectors(library);
    applySelectorOptions(library, selectorOptions);
    const summary = effectLoadSummary(library);
    const warnings = library.warnings ?? [];
    const detail = warnings.length === 0
      ? summary
      : `${summary}; skipped ${warnings.length} invalid sequence ${warnings.length === 1 ? "record" : "records"}`;
    libraryStats.textContent = detail;
    setAssetStatus("loaded", `Loaded ${label}`, detail);
    log(`loaded ${label}: ${library.effects.length} components, ${library.sequences.length} sequences`);
    for (const warning of warnings) log(`warning: ${warning}`);
    await rebuild();
  } catch (error) {
    resetSelectors("EFT parse failed");
    setAssetStatus("error", "Could not load EFT", error.message);
    log(error.message);
  }
}

sequenceSelect.addEventListener("change", rebuild);
effectSelect.addEventListener("change", rebuild);
document.querySelector("#rebuildButton").addEventListener("click", rebuild);
document.querySelector("#pauseButton").addEventListener("click", () => {
  preview.paused = !preview.paused;
  document.querySelector("#pauseButton").textContent = preview.paused ? "Resume" : "Pause";
});
document.querySelector("#resetPlacementButton").addEventListener("click", () => {
  for (const input of Object.values(placementInputs)) input.value = "0";
  preview.setPlacement(readPlacementControls());
});

for (const input of Object.values(placementInputs)) {
  input.addEventListener("input", () => preview.setPlacement(readPlacementControls()));
}

particleLevel.addEventListener("input", () => {
  particleLevelLabel.textContent = particleLevel.value;
});
particleLevel.addEventListener("change", rebuild);

replayDelaySeconds.addEventListener("input", () => {
  preview.setReplayDelaySeconds(readNumericInput(replayDelaySeconds));
});

function setBrowserTab(tab) {
  activeBrowserTab = tab;
  const skillMode = tab === "skill";
  libraryTab.hidden = skillMode;
  skillTab.hidden = !skillMode;
  libraryTabButton.classList.toggle("active", !skillMode);
  skillTabButton.classList.toggle("active", skillMode);
  libraryTabButton.setAttribute("aria-selected", String(!skillMode));
  skillTabButton.setAttribute("aria-selected", String(skillMode));
}

function populateSkillBrowser() {
  populateSkillClassSelect();
  populateSkillSelect();
  selectDefaultSkillRole(false);
}

function populateSkillClassSelect() {
  skillClassSelect.replaceChildren();
  for (const className of [...skillCatalogue.classes, skillCatalogue.uncategorizedLabel]) {
    const option = document.createElement("option");
    option.value = className;
    option.textContent = className;
    skillClassSelect.appendChild(option);
  }
}

function populateSkillSelect(preferredSkillId = Number(skillSelect.value)) {
  const skills = skillsForCurrentClass();
  skillSelect.replaceChildren();
  if (skills.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No skills in this group";
    option.disabled = true;
    option.selected = true;
    skillSelect.appendChild(option);
    skillSelect.disabled = true;
    return;
  }

  let selected = false;
  for (const skill of skills) {
    const option = document.createElement("option");
    const displayName = skillDisplayName(skill);
    option.value = String(skill.id);
    option.textContent = `${skill.id} ${displayName}`;
    option.title = `${displayName}; levels ${skill.levels}; cast time ${skill.readyTimes}`;
    if (skill.id === preferredSkillId) {
      option.selected = true;
      selected = true;
    }
    skillSelect.appendChild(option);
  }
  if (!selected) skillSelect.selectedIndex = 0;
  skillSelect.disabled = false;
}

function skillsForCurrentClass() {
  const selectedClass = skillClassSelect.value || skillCatalogue.classes[0];
  const uncategorized = selectedClass === skillCatalogue.uncategorizedLabel;
  return skillCatalogue.skills
    .filter(skillHasAnyEffect)
    .filter((skill) => uncategorized ? skill.classes.length === 0 : skill.classes.includes(selectedClass))
    .sort((left, right) => left.id - right.id);
}

function skillHasAnyEffect(skill) {
  return Object.values(skill?.roles ?? {})
    .some((role) => typeof role.effect === "string" && role.effect.trim() !== "");
}

function skillDisplayName(skill) {
  return skillNameOverrides.get(skill.id) ?? skill.name;
}

function selectedSkill() {
  const id = Number(skillSelect.value);
  return skillCatalogue.skills
    .find((skill) => skill.id === id && skillHasAnyEffect(skill)) ?? null;
}

function selectedRole(skill = selectedSkill()) {
  return skill?.roles?.[selectedSkillRole] ?? null;
}

function selectDefaultSkillRole(loadEffect = true) {
  const skill = selectedSkill();
  const firstAvailable = defaultSkillRoleCandidates().find((role) => skillRoleAvailable(skill, role.key));
  selectedSkillRole = firstAvailable?.key ?? skillCatalogue.roles[0].key;
  populateSkillRoleButtons(skill);
  populateSkillSequenceSelect(selectedRole(skill));
  updateSkillEffectDetail(selectedRole(skill));
  if (loadEffect && firstAvailable) loadSelectedSkillEffect();
}

function defaultSkillRoleCandidates() {
  const roleByKey = new Map(skillCatalogue.roles.map((role) => [role.key, role]));
  const preferred = defaultSkillRolePriority
    .map((roleKey) => roleByKey.get(roleKey))
    .filter(Boolean);
  const remaining = skillCatalogue.roles.filter((role) => !defaultSkillRolePriority.includes(role.key));
  return [...preferred, ...remaining];
}

function skillRoleLabel(role) {
  return skillRoleLabels.get(role?.key) ?? role?.label ?? "selected";
}

function selectSkillRole(roleKey) {
  selectedSkillRole = roleKey;
  const skill = selectedSkill();
  populateSkillRoleButtons(skill);
  populateSkillSequenceSelect(selectedRole(skill));
  updateSkillEffectDetail(selectedRole(skill));
  loadSelectedSkillEffect();
}

function populateSkillRoleButtons(skill) {
  for (const button of skillRoleButtons) {
    const role = skill?.roles?.[button.dataset.skillRole];
    const duplicateStartCast = roleDuplicatesStartCast(skill, role);
    const available = Boolean(role?.effect) && !duplicateStartCast;
    button.disabled = !available;
    button.classList.toggle("active", button.dataset.skillRole === selectedSkillRole && available);
    button.classList.toggle("unavailable", !available);
    button.title = duplicateStartCast
      ? "Uses the Start Cast effect in ps0198"
      : available
        ? role.effect
        : "No effect for this skill role";
  }
}

function skillRoleAvailable(skill, roleKey) {
  const role = skill?.roles?.[roleKey];
  return Boolean(role?.effect) && !roleDuplicatesStartCast(skill, role);
}

function roleDuplicatesStartCast(skill, role) {
  const startCast = skill?.roles?.startCast;
  return role?.key === "casting"
    && role.source === "sub_584170"
    && role.effect
    && role.effect === startCast?.effect;
}

function populateSkillSequenceSelect(role) {
  skillSequenceSelect.replaceChildren();
  if (!role?.effect || role.requestedSequenceIds.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = role?.effect ? "No sequence requested" : "No effect available";
    option.disabled = true;
    option.selected = true;
    skillSequenceSelect.appendChild(option);
    skillSequenceSelect.disabled = true;
    return;
  }

  const sequenceOptions = skillSequenceOptions(role);
  if (sequenceOptions.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No sequence requested";
    option.disabled = true;
    option.selected = true;
    skillSequenceSelect.appendChild(option);
    skillSequenceSelect.disabled = true;
    return;
  }

  for (const sequenceOption of sequenceOptions) {
    const option = document.createElement("option");
    option.value = String(sequenceOption.sequenceId);
    option.textContent = sequenceOption.label;
    skillSequenceSelect.appendChild(option);
  }
  skillSequenceSelect.disabled = false;
}

function skillSequenceOptions(role) {
  const requestedIds = role?.requestedSequenceIds ?? [];
  if (!role?.effect || requestedIds.length === 0) return [];

  const mappings = parseSequenceMappings(role.sequenceNames);
  const entries = requestedIds
    .map((requestedId) => mappings.get(requestedId) ?? {
      requestedId,
      effectiveId: requestedId,
      name: "",
    })
    .filter((entry) => Number.isFinite(entry.requestedId) && Number.isFinite(entry.effectiveId));
  if (entries.length === 0) return [];

  if ((role.sequenceExpression || "").trim() !== "level - 1") {
    const optionsBySequence = new Map();
    for (const entry of entries) {
      if (!optionsBySequence.has(entry.effectiveId)) {
        optionsBySequence.set(entry.effectiveId, {
          sequenceId: entry.effectiveId,
          label: sequenceLabel(entry.effectiveId, entry.name),
        });
      }
    }
    return [...optionsBySequence.values()];
  }

  const groups = [];
  for (const entry of entries) {
    const current = groups[groups.length - 1];
    if (current && current.sequenceId === entry.effectiveId && current.endRequestedId + 1 === entry.requestedId) {
      current.endRequestedId = entry.requestedId;
      continue;
    }

    groups.push({
      sequenceId: entry.effectiveId,
      startRequestedId: entry.requestedId,
      endRequestedId: entry.requestedId,
      name: entry.name,
    });
  }

  const highestRequestedId = Math.max(...entries.map((entry) => entry.requestedId));
  return groups.map((group) => ({
    sequenceId: group.sequenceId,
    label: `${levelRangeLabel(group.startRequestedId, group.endRequestedId, highestRequestedId)} - ${sequenceLabel(group.sequenceId, group.name)}`,
  }));
}

function parseSequenceMappings(value) {
  const mappings = new Map();
  for (const part of (value || "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(":");
    if (separator < 0) continue;
    const requestedId = Number(trimmed.slice(0, separator));
    const rawName = trimmed.slice(separator + 1);
    const clamped = rawName.match(/^<clamps to\s+(\d+):(.*)>$/);
    const effectiveId = clamped ? Number(clamped[1]) : requestedId;
    const name = clamped ? clamped[2] : rawName;
    if (Number.isFinite(requestedId) && Number.isFinite(effectiveId)) {
      mappings.set(requestedId, { requestedId, effectiveId, name });
    }
  }
  return mappings;
}

function levelRangeLabel(startRequestedId, endRequestedId, highestRequestedId) {
  const startLevel = startRequestedId + 1;
  const endLevel = endRequestedId + 1;
  if (startRequestedId === endRequestedId) return `Lv${startLevel}`;
  if (endRequestedId === highestRequestedId) return `Lv${startLevel}+`;
  return `Lv${startLevel}-Lv${endLevel}`;
}

function sequenceLabel(sequenceId, name) {
  return name ? `Sequence ${sequenceId} (${name})` : `Sequence ${sequenceId}`;
}

function updateSkillEffectDetail(role) {
  const skill = selectedSkill();
  if (!skill) {
    skillEffectDetail.textContent = "No skill selected.";
    return;
  }
  const roleLabel = skillRoleLabel(role);
  const displayName = skillDisplayName(skill);
  if (!role?.effect) {
    skillEffectDetail.textContent = `${skill.id} ${displayName}: no ${roleLabel} effect.`;
    return;
  }

  const source = role.source ? `
Source: ${role.source}` : "";
  const sequenceSummary = skillSequenceOptions(role).map((option) => option.label).join("; ");
  const sequences = sequenceSummary ? `
Sequences: ${sequenceSummary}` : "";
  skillEffectDetail.textContent = `${skill.id} ${displayName}
${roleLabel}: ${role.effect}${source}${sequences}`;
}

async function loadSelectedSkillEffect() {
  const role = selectedRole();
  updateSkillEffectDetail(role);
  if (!role?.effect) return;

  const file = assetStore.findFile(effectPathCandidates(role.effect));
  if (!file) {
    setAssetStatus("error", "Skill effect not indexed", `Could not find ${role.effect}. Select a data directory or SAH/SAF archive that contains it.`);
    log(`missing skill effect ${role.effect}`);
    return;
  }

  const requestedSequenceIndex = Number(skillSequenceSelect.value || role.requestedSequenceIds[0] || 0);
  await loadEftFile(file, role.effect, { sequenceIndex: requestedSequenceIndex, effectIndex: -1 });
  setBrowserTab(activeBrowserTab);
}

function effectPathCandidates(effectPath) {
  const normalized = normalizePath(effectPath);
  const withoutDataPrefix = normalized.replace(/^data\//, "");
  return [normalized, withoutDataPrefix, filenameFromPath(normalized)];
}

function applySelectorOptions(library, options) {
  if (Number.isFinite(options.sequenceIndex) && library.sequences.length > 0) {
    sequenceSelect.value = String(clamp(options.sequenceIndex, 0, library.sequences.length - 1));
  }
  if (Number.isFinite(options.effectIndex) && library.effects.length > 0) {
    effectSelect.value = String(clamp(options.effectIndex, -1, library.effects.length - 1));
  } else if (library.sequences.length > 0) {
    effectSelect.value = "-1";
  }
}

function populateLibraryFileSelect(libraries) {
  libraryFileSelect.replaceChildren();
  if (libraries.length === 0) {
    const option = document.createElement("option");
    option.value = "-1";
    option.textContent = "No indexed EFT files";
    option.disabled = true;
    option.selected = true;
    libraryFileSelect.appendChild(option);
    libraryFileSelect.disabled = true;
    return;
  }

  const placeholder = document.createElement("option");
  placeholder.value = "-1";
  placeholder.textContent = "Select an EFT library";
  placeholder.disabled = true;
  placeholder.selected = true;
  libraryFileSelect.appendChild(placeholder);

  for (const group of groupEffectLibraries(libraries)) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.directory;
    for (const library of group.libraries) {
      const option = document.createElement("option");
      option.value = String(library.index);
      option.textContent = library.filename;
      option.title = library.path;
      optgroup.appendChild(option);
    }
    libraryFileSelect.appendChild(optgroup);
  }

  libraryFileSelect.disabled = false;
}

function groupEffectLibraries(libraries) {
  const groups = new Map();
  libraries.forEach((library, index) => {
    const directory = parentDirectory(library.path);
    const entries = groups.get(directory) ?? [];
    entries.push({ ...library, index, filename: filenameFromPath(library.path) });
    groups.set(directory, entries);
  });

  return Array.from(groups.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([directory, groupLibraries]) => ({
      directory,
      libraries: groupLibraries.sort((left, right) => left.filename.localeCompare(right.filename)),
    }));
}

function parentDirectory(path) {
  const index = path.lastIndexOf("/");
  if (index < 0) return "(root)";
  return path.slice(0, index);
}

function filenameFromPath(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? path : path.slice(index + 1);
}

function resetSelectors(message) {
  sequenceSelect.replaceChildren();
  effectSelect.replaceChildren();
  effectStats.textContent = "No components";

  for (const select of [sequenceSelect, effectSelect]) {
    const option = document.createElement("option");
    option.value = "-1";
    option.textContent = message;
    option.disabled = true;
    option.selected = true;
    select.appendChild(option);
    select.disabled = true;
  }
}

function populateSelectors(library) {
  sequenceSelect.replaceChildren();
  if (library.sequences.length === 0) {
    const option = document.createElement("option");
    option.value = "-1";
    option.textContent = "No sequences in this EFT";
    option.disabled = true;
    option.selected = true;
    sequenceSelect.appendChild(option);
    sequenceSelect.disabled = true;
  } else {
    library.sequences.forEach((sequence, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${index}: ${sequence.name || "(unnamed)"} (${sequence.records.length})`;
      sequenceSelect.appendChild(option);
    });
    sequenceSelect.disabled = false;
  }

  effectSelect.replaceChildren();
  if (library.effects.length === 0) {
    const option = document.createElement("option");
    option.value = "-1";
    option.textContent = "No components in this EFT";
    option.disabled = true;
    option.selected = true;
    effectSelect.appendChild(option);
    effectSelect.disabled = true;
    return;
  }

  if (library.sequences.length > 0) {
    const sequenceOption = document.createElement("option");
    sequenceOption.value = "-1";
    sequenceOption.textContent = "Use selected sequence";
    effectSelect.appendChild(sequenceOption);
  }
  library.effects.forEach((effect, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${index}: ${effect.name || "(unnamed)"} [${baseAxisLabel(effect.baseAxis)}]`;
    effectSelect.appendChild(option);
  });
  if (library.sequences.length === 0) effectSelect.value = "0";
  effectSelect.disabled = false;
}

async function rebuild() {
  if (!preview.library) return;
  try {
    const selection = {
      sequenceIndex: Number(sequenceSelect.value || 0),
      effectIndex: Number(effectSelect.value || -1),
    };
    await preview.rebuild(selection, Number(particleLevel.value));
    renderStats.textContent = `${preview.objects.length} objects`;
    effectStats.textContent = selectedEffectBaseAxisSummary(preview.library, selection);
    log(`rebuilt ${preview.objects.length} render objects`);
  } catch (error) {
    log(error.stack || error.message);
  }
}

function readPlacementControls() {
  return placementFromEulerDegrees(
    [
      readNumericInput(placementInputs.x),
      readNumericInput(placementInputs.y),
      readNumericInput(placementInputs.z),
    ],
    readNumericInput(placementInputs.yaw),
    readNumericInput(placementInputs.pitch),
    readNumericInput(placementInputs.roll),
  );
}

function readNumericInput(input) {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : 0;
}

function selectedEffectBaseAxisSummary(library, selection) {
  const effectIds = selectedEffectIds(library, selection);
  if (effectIds.length === 0) return "No components";
  return effectIds
    .map((effectId) => {
      const effect = library.effects[effectId];
      return `${effectId}: ${baseAxisLabel(effect.baseAxis)}`;
    })
    .join("\n");
}

function baseAxisLabel(baseAxis) {
  if (baseAxis === 0) return "Billboard (0)";
  if (baseAxis === 1) return "Fixed (1)";
  if (baseAxis === 2) return "Yaw Billboard (2)";
  if (baseAxis === 3) return "Parent Aligned (3)";
  return `Billboard (${baseAxis})`;
}

function resize() {
  const { clientWidth, clientHeight } = viewport;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / Math.max(1, clientHeight);
  camera.updateProjectionMatrix();
}

window.addEventListener("resize", resize);
resize();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  preview.update();
  renderer.render(scene, camera);
}

animate();
