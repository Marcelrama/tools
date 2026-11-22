const COPY_TEXT = {
  button: (count, name) => `Copy ${count} to «${name}»`,
  empty: "Create a category first",
  confirm: (count, name, target) => `Copy ${count} photo(s) to category «${name}»?\n${target}\n\nOriginals are preserved. No files are overwritten.`,
  progress: (count, total) => `Copying ${count} of ${total}…`,
  result: (count, name, target) => `${count} photo(s) copied to «${name}» (${target}). Originals were preserved.`,
  failed: (items) => ` Could not copy ${items.length}: ${items.slice(0, 3).map((item) => `${item.path} (${item.error})`).join("; ")}`,
};

// Photo organizer interface. File operations go through server.mjs; this module manages
// state, persistent indexes, duplicate groups, and organization.
const INDEX_FORMAT = "local-photo-organizer";
const LAST_FOLDER = "photo-organizer-last-folder";
const SIMILAR = 5;
const BROWSE_SIMILAR = 12;
const WORKERS = 3;
const SAVE_EVERY = 100;
const PAGE_GROUPS = 30;
const PAGE_PHOTOS = 150;
const BATCH = 200;
const DECODABLE = /\.(avif|bmp|gif|jpe?g|png|webp)$/i;
const COPY_NAME = /copy|\(\d+\)/i;
const VISION_BATCH = 48;
const DARK = "__dark";
const DARK_LIMIT = 0.22;
const MIN_LABEL = 0.3;

// English search terms mapped to Vision labels. DARK uses image brightness.
const WORDS = {
  night: ["night_sky", "nightclub", "fireworks", "candle", "lamppost", DARK],
  nocturnal: ["night_sky", "lamppost", DARK],
  dark: [DARK],
  sky: ["sky", "blue_sky", "cloudy", "night_sky"],
  clouds: ["cloudy"],
  overcast: ["cloudy", "haze"],
  sunset: ["sunset_sunrise"],
  sunrise: ["sunset_sunrise"],
  mountain: ["mountain", "hill", "cliff", "canyon"],
  hill: ["mountain", "hill"],
  valley: ["mountain", "hill", "land", "canyon"],
  ruins: ["ruins", "rocks"],
  stones: ["rocks", "ruins"],
  rock: ["rocks", "cliff"],
  terraces: ["rice_field", "farm", "ruins", "hill"],
  street: ["street", "road", "alley", "lamppost", "street_sign"],
  alley: ["alley", "street"],
  path: ["road", "dirt_road", "trail", "hiking"],
  church: ["belltower", "clock_tower", "tower", "arch", "statue"],
  cathedral: ["belltower", "clock_tower", "tower", "arch", "statue"],
  temple: ["belltower", "tower", "arch", "ruins", "statue"],
  chapel: ["belltower", "arch", "statue", "candle"],
  convent: ["arch", "balcony", "fountain", "belltower"],
  square: ["fountain", "lamppost", "statue", "crowd", "belltower"],
  market: ["food", "crowd", "people"],
  volcano: ["mountain", "snow", "hill"],
  tower: ["tower", "belltower", "clock_tower"],
  arch: ["arch", "portal"],
  door: ["door", "portal", "arch"],
  balcony: ["balcony"],
  pool: ["fountain"],
  fountain: ["fountain"],
  statue: ["statue"],
  building: ["building", "structure", "house_single", "skyscraper"],
  house: ["house_single", "building", "structure"],
  bridge: ["bridge"],
  food: ["food", "seafood", "dining_room"],
  llama: ["llama"],
  alpaca: ["llama"],
  dog: ["dog"],
  cat: ["cat", "adult_cat"],
  horse: ["horse"],
  sheep: ["sheep"],
  cow: ["cow"],
  people: ["people", "adult", "crowd"],
  person: ["people", "adult"],
  persons: ["people", "adult", "crowd"],
  crowd: ["crowd", "parade"],
  parade: ["parade", "costume", "crowd"],
  party: ["parade", "costume", "carnival", "fireworks"],
  costume: ["costume"],
  child: ["child", "baby"],
  car: ["car"],
  vehicle: ["car"],
  motorcycle: ["motorcycle"],
  atv: ["atv"],
  train: ["train", "train_real", "train_station", "railroad"],
  lake: ["lake", "water_body"],
  lagoon: ["lake", "water_body", "wetland"],
  river: ["river", "water_body"],
  water: ["water", "water_body", "lake", "river", "waterfall"],
  waterfall: ["waterfall"],
  beach: ["beach", "ocean"],
  sea: ["ocean", "beach"],
  tree: ["tree", "palm_tree", "eucalyptus_tree"],
  flower: ["flower", "flower_arrangement"],
  plant: ["plant", "decorative_plant"],
  grass: ["grass"],
  field: ["grass", "land", "farm", "rice_field", "prairie"],
  snow: ["snow"],
  snowy: ["snow", "mountain"],
  desert: ["desert"],
  fire: ["fire", "fireplace", "candle"],
  lights: ["light", "lamp", "lamppost", "spotlight", "fireworks"],
  candle: ["candle", "candlestick"],
};
const META_BATCH = 300;
const NEAR_KM = 1;

// Optional custom places with coordinates and a radius in kilometers. Empty by default.
const PLACES = [];

const SHOWN_WORDS = {};
const LABEL_NAMES = Object.fromEntries(Object.entries(WORDS).flatMap(([word, ids]) => ids.map((id) => [id, word])).reverse());

const $ = (selector) => document.querySelector(selector);
const state = {
  root: null,
  name: "",
  known: new Map(),
  photos: [],
  groups: [],
  dupMarked: new Set(),
  orgMarked: new Set(),
  groupLimit: PAGE_GROUPS,
  photoLimit: PAGE_PHOTOS,
  examples: [],
  vision: new Map(),
  meta: new Map(),
  near: null,
  sameDay: null,
  visionFailed: new Set(),
  visionRunning: false,
  categories: [],
  category: -1,
  orgVisible: [],
  lastIndex: -1,
  busy: false,
};

// ---------- Utilities ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, onClick) {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

const baseName = (filePath) => filePath.slice(filePath.lastIndexOf("/") + 1);
const dirOf = (filePath) => (filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "");
const query = (filePath) => encodeURIComponent(filePath);
const normalize = (text) => text.toLocaleLowerCase("en").normalize("NFD").replace(/\p{Diacritic}/gu, "");
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const totalBytes = (list) => list.reduce((sum, photo) => sum + photo.size, 0);

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function hamming(first, second) {
  let bits = first ^ second;
  let count = 0;
  while (bits) {
    bits &= bits - 1n;
    count += 1;
  }
  return count;
}

async function api(pathname, body) {
  const options = body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(pathname, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}

async function fetchBlob(pathname) {
  const response = await fetch(pathname);
  if (!response.ok) throw new Error(`Error ${response.status}`);
  return response.blob();
}

function setStatus(message) {
  $("#status").textContent = message;
}

function setProgress(fraction, message) {
  const bar = $("#progress");
  bar.hidden = fraction === undefined;
  if (fraction !== undefined) {
    bar.classList.toggle("progress--busy", fraction === null);
    $("#progress-bar").style.width = fraction === null ? "30%" : `${Math.round(fraction * 100)}%`;
  }
  if (message) setStatus(message);
}

function setBusy(busy) {
  state.busy = busy;
  $("#work").disabled = busy || !state.root;
  for (const id of ["#pick", "#open-path", "#analyze", "#import", "#export"]) $(id).disabled = busy || (id !== "#pick" && id !== "#open-path" && !state.root);
  if (!busy) setProgress(undefined);
}

function remaining(started, done, total) {
  if (done < 5) return "";
  const minutes = Math.round(((performance.now() - started) / done) * (total - done) / 60000);
  return minutes >= 1 ? ` · ~${minutes} min remaining` : " · less than 1 min remaining";
}

// ---------- Index: avoid repeating analysis ----------

/** Accepts backup versions 1 and 2 and the current version 3 index. */
function normalizeRecords(doc) {
  if (doc?.format !== INDEX_FORMAT || ![1, 2, 3].includes(doc.version) || !Array.isArray(doc.files)) {
    throw new Error("This file is not a Photo Organizer backup.");
  }
  // Older backups may prefix file paths with the root folder name.
  const prefix = typeof doc.folderName === "string" ? `${doc.folderName}/` : null;
  const strip = !doc.relative && prefix && doc.files.length > 0 && doc.files.every((record) => record?.path?.startsWith(prefix));
  const records = [];
  for (const record of doc.files) {
    if (typeof record?.path !== "string" || typeof record.fingerprint !== "string" || !/^\d+:\d+$/.test(record.fingerprint)) continue;
    if (!/^[a-f0-9]{64}$/i.test(record.sha256 || "")) continue;
    if (record.visualHash != null && !/^\d+$/.test(String(record.visualHash))) continue;
    records.push({
      path: strip ? record.path.slice(prefix.length) : record.path,
      fingerprint: record.fingerprint,
      sha256: record.sha256.toLowerCase(),
      width: Number(record.width) || 0,
      height: Number(record.height) || 0,
      visualHash: record.visualHash == null ? null : String(record.visualHash),
    });
  }
  return records;
}

function toPhoto(filePath, fingerprint, record) {
  const [size, lastModified] = fingerprint.split(":").map(Number);
  return {
    path: filePath,
    name: baseName(filePath),
    size,
    lastModified,
    fingerprint,
    sha256: record.sha256,
    width: record.width,
    height: record.height,
    visualHash: record.visualHash == null ? null : BigInt(record.visualHash),
  };
}

function toRecord(photo) {
  return {
    path: photo.path,
    fingerprint: photo.fingerprint,
    sha256: photo.sha256,
    width: photo.width,
    height: photo.height,
    visualHash: photo.visualHash == null ? null : photo.visualHash.toString(),
  };
}

function indexDocument() {
  return {
    format: INDEX_FORMAT,
    version: 3,
    relative: true,
    folderName: state.name,
    updatedAt: new Date().toISOString(),
    files: state.photos.map(toRecord),
    categories: state.categories,
  };
}

// Serialize writes so consecutive saves cannot write the index simultaneously.
let saving = Promise.resolve();
function saveIndex() {
  const doc = indexDocument();
  saving = saving.catch(() => {}).then(() => api("/api/index", { doc }));
  return saving;
}

// ---------- Analysis ----------

function visualHash(bitmap) {
  const canvas = new OffscreenCanvas(9, 8);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, 9, 8);
  const pixels = context.getImageData(0, 0, 9, 8).data;
  let hash = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = (y * 9 + x) * 4;
      const right = left + 4;
      const leftGray = pixels[left] * 0.299 + pixels[left + 1] * 0.587 + pixels[left + 2] * 0.114;
      const rightGray = pixels[right] * 0.299 + pixels[right + 1] * 0.587 + pixels[right + 2] * 0.114;
      hash = (hash << 1n) | BigInt(leftGray > rightGray ? 1 : 0);
    }
  }
  return hash;
}

async function analyze(file) {
  const blob = await fetchBlob(`/api/file?path=${query(file.path)}`);
  const record = { sha256: hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), width: 0, height: 0, visualHash: null };
  let bitmap = DECODABLE.test(file.path) ? await createImageBitmap(blob).catch(() => null) : null;
  try {
    if (bitmap) {
      record.width = bitmap.width;
      record.height = bitmap.height;
    } else {
      // HEIC and NEF previews and dimensions are provided by the server through sips.
      const size = await api(`/api/info?path=${query(file.path)}`).catch(() => ({}));
      record.width = size.width || 0;
      record.height = size.height || 0;
      bitmap = await createImageBitmap(await fetchBlob(`/api/preview?path=${query(file.path)}&v=${file.fingerprint}`));
    }
    record.visualHash = visualHash(bitmap).toString();
  } catch {
    // Without a preview, only exact SHA-256 comparison remains available.
  } finally {
    bitmap?.close();
  }
  return toPhoto(file.path, file.fingerprint, record);
}

async function sync() {
  setBusy(true);
  let listed = false;
  try {
    setProgress(null, "Reading folder…");
    const { files } = await api("/api/scan");
    listed = true;
    const byName = new Map([...state.known.values()].map((record) => [`${record.fingerprint}|${baseName(record.path)}`, record]));
    const photos = [];
    const pending = [];
    for (const file of files) {
      const fingerprint = `${file.size}:${file.lastModified}`;
      const known = state.known.get(file.path);
      // Externally moved photos keep their size, date, and name, allowing index reuse.
      const match = known?.fingerprint === fingerprint ? known : byName.get(`${fingerprint}|${baseName(file.path)}`);
      if (match) photos.push(toPhoto(file.path, fingerprint, match));
      else pending.push({ ...file, fingerprint });
    }
    state.photos = photos;
    const reused = photos.length;
    let failed = 0;
    if (pending.length) {
      const started = performance.now();
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < pending.length) {
          const file = pending[next];
          next += 1;
          try {
            photos.push(await analyze(file));
          } catch (error) {
            failed += 1;
            console.warn(`Could not analyze ${file.path}`, error);
          }
          done += 1;
          setProgress(done / pending.length, `Analyzing ${done} of ${pending.length} new photos${remaining(started, done, pending.length)}. You can close this window: progress is saved every ${SAVE_EVERY} photos.`);
          if (done % SAVE_EVERY === 0) await saveIndex();
        }
      };
      await Promise.all(Array.from({ length: WORKERS }, worker));
    }
    await saveIndex();
    setStatus(`Done: ${files.length} photos in «${state.name}». ${reused} already analyzed${pending.length ? `, ${pending.length - failed} newly analyzed` : ""}${failed ? `, ${failed} could not be read` : ""}. The index was saved in the folder.`);
  } catch (error) {
    setStatus(`Analysis stopped: ${error.message}. Completed work was saved; click “Analyze” to continue.`);
    if (listed) await saveIndex().catch(() => {});
  } finally {
    if (listed) state.known = new Map(state.photos.map((photo) => [photo.path, toRecord(photo)]));
    afterChange();
    setBusy(false);
  }
  if (listed) recognizeInBackground();
}

// ---------- Background content recognition (Vision) ----------

function setVisionStatus(message) {
  $("#vision-status").textContent = message;
}

/** GPS and capture date: a fast pass without decoding image pixels. */
async function readMetadata(root) {
  const seen = new Set();
  const pending = state.photos.filter((photo) => {
    if (state.meta.has(photo.sha256) || seen.has(photo.sha256)) return false;
    seen.add(photo.sha256);
    return true;
  });
  for (let start = 0; start < pending.length && state.root === root; start += META_BATCH) {
    const chunk = pending.slice(start, start + META_BATCH).filter((photo) => state.photos.includes(photo));
    const { results } = await api("/api/recognize", { mode: "meta", items: chunk.map(({ path, sha256 }) => ({ path, sha256 })) });
    // Record missing metadata too, so the same file is not requested repeatedly.
    for (const photo of chunk) state.meta.set(photo.sha256, results[photo.sha256] || { geo: null, taken: null });
    setVisionStatus(`Reading location and date: ${Math.min(start + META_BATCH, pending.length)} of ${pending.length} photos…`);
  }
  if (pending.length) renderOrganize();
}

async function recognizeInBackground() {
  if (state.visionRunning) return;
  state.visionRunning = true;
  const root = state.root;
  try {
    await readMetadata(root);
    const seen = new Set();
    const pending = state.photos.filter((photo) => {
      if (state.vision.has(photo.sha256) || state.visionFailed.has(photo.sha256) || seen.has(photo.sha256)) return false;
      seen.add(photo.sha256);
      return true;
    });
    if (!pending.length) {
      setVisionStatus(`Content recognized in ${state.vision.size} photos. You can now search by content.`);
      return;
    }
    const started = performance.now();
    for (let start = 0; start < pending.length && state.root === root; start += VISION_BATCH) {
      const chunk = pending.slice(start, start + VISION_BATCH).filter((photo) => state.photos.includes(photo));
      const { results } = await api("/api/recognize", { items: chunk.map(({ path, sha256 }) => ({ path, sha256 })) });
      for (const photo of chunk) {
        if (results[photo.sha256]) state.vision.set(photo.sha256, results[photo.sha256]);
        else state.visionFailed.add(photo.sha256);
      }
      const done = Math.min(start + VISION_BATCH, pending.length);
      setVisionStatus(`Recognizing content: ${done} of ${pending.length} photos${remaining(started, done, pending.length)}. This runs once per photo; you can keep using the tool.`);
      if ((start / VISION_BATCH) % 10 === 9) renderOrganize();
    }
    setVisionStatus(`Content recognized in ${state.vision.size} photos. You can now search by content.`);
  } catch (error) {
    setVisionStatus(`Content recognition stopped: ${error.message}. It resumes when you reopen the folder.`);
  } finally {
    state.visionRunning = false;
    renderOrganize();
  }
}

// ---------- Folder ----------

async function openFolder(folderPath) {
  setBusy(true);
  setProgress(null, "Opening folder…");
  let data;
  try {
    data = await api("/api/open", { path: folderPath });
  } catch (error) {
    setBusy(false);
    setStatus(error.message);
    return;
  }
  state.root = data.root;
  state.name = data.name;
  state.photos = [];
  state.known = new Map();
  state.dupMarked.clear();
  state.orgMarked = new Set(JSON.parse(sessionStorage.getItem(`photo-organizer-marked:${data.root}`) || "[]"));
  state.examples = [];
  state.near = null;
  state.sameDay = null;
  state.visionFailed.clear();
  state.categories = Array.isArray(data.index?.categories)
    ? data.index.categories.filter((category) => typeof category?.name === "string" && typeof category.folder === "string")
    : [];
  state.category = state.categories.length ? 0 : -1;
  try {
    const { entries, meta } = await api("/api/vision");
    state.vision = new Map(Object.entries(entries));
    state.meta = new Map(Object.entries(meta || {}));
  } catch {
    state.vision = new Map();
    state.meta = new Map();
  }
  localStorage.setItem(LAST_FOLDER, data.root);
  $("#folder-path").value = data.root;
  let indexProblem = "";
  if (data.index) {
    try {
      for (const record of normalizeRecords(data.index)) state.known.set(record.path, record);
    } catch (error) {
      indexProblem = ` Could not read the folder index (${error.message}).`;
    }
  }
  if (!state.known.size) {
    afterChange();
    setBusy(false);
    setStatus(`First time opening «${data.name}».${indexProblem} If you have a JSON backup for this folder, import it to analyze only missing photos. Otherwise, click “Analyze” to get started.`);
    return;
  }
  await sync();
}

async function importBackup(file) {
  let records;
  try {
    records = normalizeRecords(JSON.parse(await file.text()));
  } catch (error) {
    setStatus(`Could not import: ${error.message}`);
    return;
  }
  for (const record of records) if (!state.known.has(record.path)) state.known.set(record.path, record);
  setStatus(`Backup imported: ${records.length} known photos. Comparing with the folder…`);
  await sync();
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(indexDocument())], { type: "application/json" });
  const link = el("a");
  const slug = normalize(state.name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "photos";
  link.href = URL.createObjectURL(blob);
  link.download = `photo-organizer-${slug}-indice.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------- Groups ----------

/** Prefer more pixels, larger file size, no copy suffix, and a shorter path. */
function keepFirst(first, second) {
  return (second.width * second.height - first.width * first.height)
    || (second.size - first.size)
    || (COPY_NAME.test(first.name) - COPY_NAME.test(second.name))
    || (first.path.split("/").length - second.path.split("/").length)
    || first.path.localeCompare(second.path, "en");
}

function buildGroups(items) {
  const parent = items.map((_, index) => index);
  const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  const join = (first, second) => {
    parent[find(second)] = find(first);
  };
  const exact = new Map();
  // Six hash bands: hashes within five bits share at least one full band.
  const bands = [[0, 11], [11, 11], [22, 11], [33, 11], [44, 10], [54, 10]];
  const buckets = bands.map(() => new Map());
  items.forEach((photo, index) => {
    if (exact.has(photo.sha256)) join(exact.get(photo.sha256), index);
    else exact.set(photo.sha256, index);
    if (photo.visualHash === null) return;
    const keys = bands.map(([offset, width]) => (photo.visualHash >> BigInt(offset)) & ((1n << BigInt(width)) - 1n));
    const candidates = new Set(keys.flatMap((key, band) => buckets[band].get(key) || []));
    for (const candidate of candidates) {
      if (find(candidate) !== find(index) && hamming(items[candidate].visualHash, photo.visualHash) <= SIMILAR) join(candidate, index);
    }
    keys.forEach((key, band) => {
      if (!buckets[band].has(key)) buckets[band].set(key, []);
      buckets[band].get(key).push(index);
    });
  });
  const grouped = new Map();
  items.forEach((photo, index) => {
    const rootIndex = find(index);
    if (!grouped.has(rootIndex)) grouped.set(rootIndex, []);
    grouped.get(rootIndex).push(photo);
  });
  return [...grouped.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      group.sort(keepFirst);
      return { photos: group, exact: group.every((photo) => photo.sha256 === group[0].sha256), spare: totalBytes(group.slice(1)) };
    })
    .sort((first, second) => second.spare - first.spare)
    .map((group, index) => ({ ...group, id: index + 1 }));
}

function exactCopies() {
  const copies = [];
  for (const group of state.groups) {
    const seen = new Set();
    for (const photo of group.photos) {
      if (seen.has(photo.sha256)) copies.push(photo);
      else seen.add(photo.sha256);
    }
  }
  return copies;
}

// ---------- File actions ----------

function removeFromState(paths) {
  const gone = new Set(paths);
  state.photos = state.photos.filter((photo) => !gone.has(photo.path));
  for (const filePath of gone) {
    state.dupMarked.delete(filePath);
    state.orgMarked.delete(filePath);
    state.known.delete(filePath);
  }
  state.examples = state.examples.filter((photo) => !gone.has(photo.path));
}

async function trashPhotos(list) {
  if (!list.length || state.busy) return;
  const listed = list.slice(0, 8).map((photo) => photo.path).join("\n");
  const more = list.length > 8 ? `\n…and ${list.length - 8} more` : "";
  const chosen = new Set(list.map((photo) => photo.path));
  const emptied = state.groups.filter((group) => group.photos.every((photo) => chosen.has(photo.path))).length;
  const warning = emptied ? `\n\nWARNING: every photo is selected in ${emptied} group(s); no copies will remain.` : "";
  if (!window.confirm(`Send ${list.length} photo(s) (${formatBytes(totalBytes(list))}) to the macOS Trash?\nYou can recover them from the Trash.${warning}\n\n${listed}${more}`)) return;
  setBusy(true);
  const failed = [];
  let done = 0;
  try {
    for (let start = 0; start < list.length; start += BATCH) {
      const chunk = list.slice(start, start + BATCH);
      const result = await api("/api/trash", { items: chunk.map(({ path, fingerprint }) => ({ path, fingerprint })) });
      removeFromState(result.done);
      done += result.done.length;
      failed.push(...result.failed);
      setProgress((start + chunk.length) / list.length, `Sending to Trash: ${start + chunk.length} of ${list.length}…`);
    }
  } catch (error) {
    failed.push({ path: "", error: error.message });
  }
  await saveIndex().catch(() => {});
  afterChange();
  setBusy(false);
  setStatus(`${done} photo(s) sent to Trash.${failed.length ? ` Could not move ${failed.length}: ${failed.slice(0, 3).map((item) => `${item.path} (${item.error})`).join("; ")}` : ""}`);
}

async function movePhotos(list, category, copying = false) {
  if (!list.length || state.busy || !category) return;
  const target = category.folder;
  if (!window.confirm(copying ? COPY_TEXT.confirm(list.length, category.name, target) : `Move ${list.length} photo(s) to category «${category.name}»?\n${target}\n\nNo files are overwritten.`)) return;
  setBusy(true);
  const byPath = new Map(list.map((photo) => [photo.path, photo]));
  const failed = [];
  let moved = 0;
  try {
    for (let start = 0; start < list.length; start += BATCH) {
      const chunk = list.slice(start, start + BATCH);
      const result = await api(copying ? "/api/copy" : "/api/move", { items: chunk.map(({ path, fingerprint }) => ({ path, fingerprint })), destination: target });
      for (const item of (copying ? result.copied : result.moved)) {
        const photo = byPath.get(item.from);
        state.orgMarked.delete(photo.path);
        if (copying) {
          if (item.to) state.photos.push({ ...photo, path: item.to, name: baseName(item.to), fingerprint: item.fingerprint });
          moved += 1;
          continue;
        }
        state.dupMarked.delete(photo.path);
        if (item.to) Object.assign(photo, { path: item.to, name: baseName(item.to), fingerprint: item.fingerprint });
        else removeFromState([photo.path]);
        moved += 1;
      }
      failed.push(...result.failed);
      setProgress((start + chunk.length) / list.length, copying ? COPY_TEXT.progress(start + chunk.length, list.length) : `Moving ${start + chunk.length} of ${list.length}…`);
    }
  } catch (error) {
    failed.push({ path: "", error: error.message });
  }
  state.known = new Map(state.photos.map((photo) => [photo.path, toRecord(photo)]));
  await saveIndex().catch(() => {});
  afterChange();
  setBusy(false);
  setStatus(copying ? COPY_TEXT.result(moved, category.name, target) + (failed.length ? COPY_TEXT.failed(failed) : "") : `${moved} photo(s) moved to «${category.name}» (${target}).${failed.length ? ` Could not move ${failed.length}: ${failed.slice(0, 3).map((item) => `${item.path} (${item.error})`).join("; ")}` : ""}`);
}

function reveal(photo) {
  api("/api/reveal", { path: photo.path, fingerprint: photo.fingerprint }).catch((error) => setStatus(error.message));
}

// ---------- View ----------

function photoCard(photo, { marked, onToggle, badge, actions }) {
  const card = el("article", `photo-card${marked ? " photo-card--selected" : ""}`);
  const frame = el("div", "photo-card__frame");
  const image = el("img", "photo-card__image");
  image.loading = "lazy";
  image.decoding = "async";
  image.alt = photo.name;
  image.src = `/api/preview?path=${query(photo.path)}&v=${photo.fingerprint}`;
  image.addEventListener("error", () => image.replaceWith(el("div", "photo-card__image photo-card__unavailable", `No preview (${photo.name.split(".").pop().toUpperCase()})`)), { once: true });
  const checkbox = el("input", "photo-card__check");
  checkbox.type = "checkbox";
  checkbox.checked = marked;
  checkbox.setAttribute("aria-label", `Select ${photo.path}`);
  frame.append(image, checkbox);
  if (badge) frame.append(el("span", "photo-card__badge", badge));
  const info = el("div", "photo-card__info");
  info.append(
    el("span", "photo-card__name", photo.name),
    el("span", "photo-card__path", dirOf(photo.path) || "(root folder)"),
    el("span", "photo-card__meta", `${formatBytes(photo.size)}${photo.width ? ` · ${photo.width} × ${photo.height}` : ""}`),
    el("span", "photo-card__meta", [dayOf(photo) && formatDay(dayOf(photo)), placeOf(photo)?.name || (geoOf(photo) && "GPS available")].filter(Boolean).join(" · ")),
  );
  const row = el("div", "photo-card__actions");
  for (const [text, className, handler] of actions) row.append(button(text, `small ${className}`, handler));
  row.append(button("Finder", "small actions__secondary", () => reveal(photo)));
  info.append(row);
  card.append(frame, info);
  card.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    if (event.target !== checkbox) checkbox.checked = !checkbox.checked;
    card.classList.toggle("photo-card--selected", checkbox.checked);
    onToggle(checkbox.checked, event.shiftKey);
  });
  return card;
}

function renderDuplicates() {
  const box = $("#dup-results");
  box.replaceChildren();
  const filter = $("#dup-filter").value;
  const list = state.groups.filter((group) => filter === "all" || (filter === "exact") === group.exact);
  const copies = exactCopies();
  const similar = state.groups.filter((group) => !group.exact).length;
  $("#dup-summary").textContent = state.photos.length
    ? `${state.groups.length} groups: ${state.groups.length - similar} with identical copies and ${similar} with similar photos. Identical copies use ${formatBytes(totalBytes(copies))}.`
    : "";
  if (!list.length) box.append(el("p", "empty", state.photos.length ? "No groups match this filter." : "Open and analyze a folder to review duplicates."));
  for (const group of list.slice(0, state.groupLimit)) {
    const section = el("section", "group");
    const header = el("div", "group__header");
    header.append(
      el("h3", "group__title", `Group ${group.id} · ${group.exact ? "Identical copies" : "Similar photos: review them; false positives are possible"}`),
      el("p", "group__details", `${group.photos.length} photos · ${formatBytes(group.spare)} excluding the first photo`),
    );
    const grid = el("div", "photos");
    group.photos.forEach((photo, index) => {
      grid.append(photoCard(photo, {
        marked: state.dupMarked.has(photo.path),
        badge: index === 0 ? "Suggested to keep" : null,
        onToggle: (on) => {
          if (on) state.dupMarked.add(photo.path);
          else state.dupMarked.delete(photo.path);
          updateDupBar();
        },
        actions: [
          ["Keep only this photo", "actions__secondary", () => trashPhotos(group.photos.filter((other) => other !== photo))],
          ["Trash", "actions__danger", () => trashPhotos([photo])],
        ],
      }));
    });
    section.append(header, grid);
    box.append(section);
  }
  $("#dup-more").hidden = list.length <= state.groupLimit;
  $("#dup-more").textContent = `Show more groups (${list.length - state.groupLimit} remaining)`;
  updateDupBar();
}

function updateDupBar() {
  const marked = state.photos.filter((photo) => state.dupMarked.has(photo.path));
  $("#dup-delete").disabled = !marked.length;
  $("#dup-delete").textContent = marked.length ? `Trash selected (${marked.length} · ${formatBytes(totalBytes(marked))})` : "Trash selected";
}

function vectorOf(photo) {
  const entry = state.vision.get(photo.sha256);
  if (!entry?.print) return null;
  if (!entry.vector) {
    const binary = atob(entry.print);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    entry.vector = new Float32Array(bytes.buffer);
  }
  return entry.vector;
}

function contentDistance(first, second) {
  if (first.sha256 === second.sha256) return 0;
  const [a, b] = [vectorOf(first), vectorOf(second)];
  if (a && b && a.length === b.length) {
    let sum = 0;
    for (let index = 0; index < a.length; index += 1) sum += (a[index] - b[index]) ** 2;
    return Math.sqrt(sum);
  }
  // Without content recognition, the visual hash finds only near-identical images.
  return first.visualHash !== null && second.visualHash !== null && hamming(first.visualHash, second.visualHash) <= BROWSE_SIMILAR ? 0.5 : Infinity;
}

function wantedLabels(term) {
  return WORDS[term] || (term.endsWith("s") ? WORDS[term.slice(0, -1)] : null) || (term.endsWith("en") ? WORDS[term.slice(0, -2)] : null) || [];
}

/** Score search terms against the file path and recognized content. */
function textScore(photo, terms) {
  const route = normalize(photo.path);
  const entry = state.vision.get(photo.sha256);
  let total = 0;
  for (const term of terms) {
    const wanted = wantedLabels(term);
    let best = route.includes(term) ? 1 : 0;
    for (const [id, confidence] of entry?.labels || []) {
      if (confidence >= MIN_LABEL && (wanted.includes(id) || (term.length >= 3 && id.includes(term)))) best = Math.max(best, confidence);
    }
    if (wanted.includes(DARK) && entry?.brightness >= 0 && entry.brightness < DARK_LIMIT) best = Math.max(best, 0.6 + DARK_LIMIT - entry.brightness);
    if (!best) return 0;
    total += best;
  }
  return total;
}

function kilometers([latA, lonA], [latB, lonB]) {
  const rad = Math.PI / 180;
  const a = Math.sin(((latB - latA) * rad) / 2) ** 2 + Math.cos(latA * rad) * Math.cos(latB * rad) * Math.sin(((lonB - lonA) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

const geoOf = (photo) => state.meta.get(photo.sha256)?.geo || null;

/** Capture date from EXIF or supported timestamped file names. */
function takenOf(photo) {
  const taken = state.meta.get(photo.sha256)?.taken;
  if (taken) return taken;
  const match = /(20\d{2})(\d{2})(\d{2})(?:[_-](\d{2})(\d{2})(\d{2}))?/.exec(photo.name);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1 || Number(match[3]) > 31) return null;
  return `${match[1]}-${match[2]}-${match[3]}T${match[4] || "00"}:${match[5] || "00"}:${match[6] || "00"}`;
}

const dayOf = (photo) => takenOf(photo)?.slice(0, 10) || null;

function placeOf(photo) {
  const geo = geoOf(photo);
  return geo ? PLACES.find((place) => kilometers(geo, place.at) <= place.km) || null : null;
}

function formatDay(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });
}

/** Separates configured place aliases from other search terms. */
function parseQuery() {
  let text = ` ${normalize($("#org-search").value).replace(/[,]+/g, " ")} `;
  // Check all aliases against the original query.
  const places = PLACES.filter((place) => place.aliases.some((alias) => text.includes(` ${alias} `)));
  for (const alias of places.flatMap((place) => place.aliases)) text = text.replaceAll(` ${alias} `, " ");
  return { places, aliases: places.flatMap((place) => place.aliases), terms: text.split(/\s+/).filter(Boolean) };
}

function isKnownTerm(term) {
  if (wantedLabels(term).length) return true;
  if (state.photos.some((photo) => normalize(photo.path).includes(term))) return true;
  for (const entry of state.vision.values()) if ((entry.labels || []).some(([id]) => id.includes(term))) return true;
  return false;
}

function visibleForOrganize() {
  const { places, aliases, terms } = parseQuery();
  const folder = $("#org-folder").value;
  let list = folder === "*" ? state.photos : state.photos.filter((photo) => (folder === "" ? !photo.path.includes("/") : photo.path.startsWith(`${folder}/`)));
  // Photos already in the selected category are not candidates.
  const category = state.categories[state.category];
  if (category?.folder.startsWith(`${state.root}/`)) {
    const prefix = `${category.folder.slice(state.root.length + 1)}/`;
    list = list.filter((photo) => !photo.path.startsWith(prefix));
  }
  if (state.near) list = list.filter((photo) => geoOf(photo) && kilometers(geoOf(photo), state.near.at) <= NEAR_KM);
  if (state.sameDay) list = list.filter((photo) => dayOf(photo) === state.sameDay);
  if (places.length) {
    // Match GPS coordinates or a folder name matching a configured place.
    const distance = (photo) => {
      const geo = geoOf(photo);
      const near = geo ? Math.min(...places.map((place) => (kilometers(geo, place.at) <= place.km ? kilometers(geo, place.at) : Infinity))) : Infinity;
      return near < Infinity ? near : aliases.some((alias) => normalize(photo.path).includes(alias)) ? 50 : Infinity;
    };
    list = list.map((photo) => [photo, distance(photo)]).filter(([, value]) => value < Infinity).sort((a, b) => a[1] - b[1]).map(([photo]) => photo);
  }
  if (state.examples.length) {
    const ranked = list.map((photo) => [photo, Math.min(...state.examples.map((example) => contentDistance(photo, example)))]);
    return ranked.filter(([, value]) => value < Infinity).sort((a, b) => a[1] - b[1]).map(([photo]) => photo);
  }
  if (terms.length) {
    return list.map((photo) => [photo, textScore(photo, terms)]).filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]).map(([photo]) => photo);
  }
  if (places.length) return list;
  if (state.near) return [...list].sort((a, b) => kilometers(geoOf(a), state.near.at) - kilometers(geoOf(b), state.near.at));
  if (state.sameDay) return [...list].sort((a, b) => takenOf(a).localeCompare(takenOf(b)));
  return [...list].sort((first, second) => first.path.localeCompare(second.path, "en"));
}

function renderLabelChips() {
  const counts = new Map();
  for (const entry of state.vision.values()) {
    const words = new Set((entry.labels || []).filter(([id, confidence]) => confidence >= 0.5 && LABEL_NAMES[id]).map(([id]) => LABEL_NAMES[id]));
    if (entry.brightness >= 0 && entry.brightness < DARK_LIMIT) words.add("noche");
    for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 24);
  const placeCounts = new Map();
  for (const photo of state.photos) {
    const place = placeOf(photo);
    if (place) placeCounts.set(place, (placeCounts.get(place) || 0) + 1);
  }
  $("#place-chips").replaceChildren(...[...placeCounts].sort((a, b) => b[1] - a[1]).map(([place, count]) => button(`${place.name} · ${count}`, "small actions__secondary", () => {
    $("#org-search").value = place.aliases[0];
    state.examples = [];
    resetOrganizePage();
  })));
  $("#place-row").hidden = !placeCounts.size;
  $("#label-chips").replaceChildren(...top.map(([word, count]) => button(`${SHOWN_WORDS[word] || word} · ${count}`, "small actions__secondary", () => {
    $("#org-search").value = SHOWN_WORDS[word] || word;
    state.examples = [];
    resetOrganizePage();
  })));
}

function resetOrganizePage() {
  state.photoLimit = PAGE_PHOTOS;
  state.lastIndex = -1;
  renderOrganize();
}

function renderOrganize() {
  const box = $("#org-results");
  box.replaceChildren();
  state.orgVisible = visibleForOrganize();
  $("#org-similar").hidden = !state.examples.length;
  $("#org-similar-name").textContent = `Sorted by similarity to ${state.examples.length} example(s): ${state.examples.map((photo) => photo.name).join(", ")}. Text search is not used while examples are selected.`;
  $("#org-near").hidden = !state.near;
  $("#org-near-name").textContent = state.near ? `Only photos within ${NEAR_KM} km of ${state.near.label}.` : "";
  $("#org-day").hidden = !state.sameDay;
  $("#org-day-name").textContent = state.sameDay ? `Only photos from ${formatDay(state.sameDay)}.` : "";
  const examplePaths = new Set(state.examples.map((photo) => photo.path));
  state.orgVisible.slice(0, state.photoLimit).forEach((photo, index) => {
    const isExample = examplePaths.has(photo.path);
    box.append(photoCard(photo, {
      marked: state.orgMarked.has(photo.path),
      badge: isExample ? "Example" : null,
      onToggle: (on, range) => {
        if (range && state.lastIndex >= 0) {
          const [from, to] = [Math.min(state.lastIndex, index), Math.max(state.lastIndex, index)];
          for (const other of state.orgVisible.slice(from, to + 1)) on ? state.orgMarked.add(other.path) : state.orgMarked.delete(other.path);
          renderOrganize();
        } else if (on) state.orgMarked.add(photo.path);
        else state.orgMarked.delete(photo.path);
        state.lastIndex = index;
        updateOrgBar();
      },
      actions: [
        [isExample ? "Remove example" : "More like this", "actions__secondary", () => {
          state.examples = isExample ? state.examples.filter((other) => other !== photo) : [...state.examples, photo];
          resetOrganizePage();
          $("#org-search-step").scrollIntoView({ behavior: "smooth" });
        }],
        ...(geoOf(photo) ? [["Same place", "actions__secondary", () => {
          state.near = { at: geoOf(photo), label: placeOf(photo)?.name || photo.name };
          resetOrganizePage();
          $("#org-search-step").scrollIntoView({ behavior: "smooth" });
        }]] : []),
        ...(dayOf(photo) ? [["Same day", "actions__secondary", () => {
          state.sameDay = dayOf(photo);
          resetOrganizePage();
          $("#org-search-step").scrollIntoView({ behavior: "smooth" });
        }]] : []),
      ],
    }));
  });
  if (!state.orgVisible.length) {
    const searching = $("#org-search").value.trim();
    const { places, terms } = parseQuery();
    const unknown = terms.filter((term) => !isKnownTerm(term));
    box.append(el("p", "empty", !state.photos.length ? "Open and analyze a folder to organize it."
      : unknown.length ? `No match for “${unknown.join(", ")}” in file names, folders, or recognized content. Try a suggested term, or choose a photo and use “Same place”, “Same day”, or “More like this”.`
      : places.length && !terms.length ? `No photos have GPS coordinates near ${places.map((place) => place.name).join(" or ")}. Photos may have no location data: find an example and use “Same day” or “More like this”.`
      : searching && state.vision.size < state.photos.length / 2 ? "Content recognition is still running. Search by folder name or use «More like this»."
        : "No photos match. Try another word, a suggestion, or select a photo and click «More like this»."));
  }
  $("#org-more").hidden = state.orgVisible.length <= state.photoLimit;
  $("#org-more").textContent = `Show more photos (${state.orgVisible.length - state.photoLimit} remaining)`;
  renderLabelChips();
  updateOrgBar();
}

function renderCategories() {
  const select = $("#cat-select");
  select.replaceChildren(...state.categories.map((category, index) => new Option(category.name, String(index))), new Option("+ New category…", "new"));
  const creating = state.category < 0;
  select.value = creating ? "new" : String(state.category);
  $("#cat-new").hidden = !creating;
  $("#cat-remove").hidden = creating;
  $("#cat-folder").textContent = creating ? "" : `Folder: ${state.categories[state.category].folder}`;
  if (creating && !$("#cat-parent").value && state.root) $("#cat-parent").value = state.root.slice(0, state.root.lastIndexOf("/"));
  updateCategoryPreview();
  updateOrgBar();
}

/** Without a name, the final path component becomes the category name. */
function categoryTarget() {
  const name = $("#cat-name").value.trim();
  const parent = $("#cat-parent").value.trim().replace(/\/+$/, "");
  if (!parent) return null;
  return name ? { name, folder: `${parent}/${name}` } : { name: parent.slice(parent.lastIndexOf("/") + 1), folder: parent };
}

function updateCategoryPreview() {
  const target = categoryTarget();
  $("#cat-preview").textContent = target ? `Category “${target.name}” in folder: ${target.folder}` : "Enter a folder location and an optional category name.";
  $("#cat-create").disabled = !target;
}

async function createCategory() {
  const target = categoryTarget();
  if (!target) return;
  const { name } = target;
  if (!name || /[/\\:]/.test(name) || name.startsWith(".")) {
    setStatus("Category names cannot contain slashes or colons, or start with a dot.");
    return;
  }
  try {
    const { path: folder } = await api("/api/mkdir", { path: target.folder });
    const existing = state.categories.findIndex((category) => category.folder === folder);
    if (existing >= 0) state.category = existing;
    else state.category = state.categories.push({ name, folder }) - 1;
    $("#cat-name").value = "";
    await saveIndex().catch(() => {});
    renderCategories();
    setStatus(`Category “${name}” is ready in ${folder}. Find photos to copy or move.`);
  } catch (error) {
    setStatus(error.message);
  }
}

function updateOrgBar() {
  const marked = state.photos.filter((photo) => state.orgMarked.has(photo.path)).length;
  const shown = Math.min(state.photoLimit, state.orgVisible.length);
  const category = state.categories[state.category];
  // Keep selections across page reloads for the duration of the session.
  if (state.root) sessionStorage.setItem(`photo-organizer-marked:${state.root}`, JSON.stringify([...state.orgMarked]));
  $("#org-count").textContent = `${state.orgVisible.length} photos${shown < state.orgVisible.length ? ` (${shown} shown)` : ""} · ${marked} selected`;
  $("#org-select-all").textContent = `Select all ${state.orgVisible.length} results`;
  $("#org-move").disabled = !marked;
  $("#org-copy").disabled = !marked;
  $("#org-copy").textContent = category ? COPY_TEXT.button(marked, category.name) : COPY_TEXT.empty;
  $("#org-trash").disabled = !marked;
  $("#org-move").textContent = !category ? "Create a category first" : `Move ${marked} to «${category.name}»`;
}

function renderFolders() {
  const folders = new Set();
  for (const photo of state.photos) {
    const parts = dirOf(photo.path).split("/").filter(Boolean);
    for (let depth = 1; depth <= parts.length; depth += 1) folders.add(parts.slice(0, depth).join("/"));
  }
  const sorted = [...folders].sort((first, second) => first.localeCompare(second, "en"));
  const select = $("#org-folder");
  const current = select.options.length ? select.value : "*";
  select.replaceChildren(new Option("All folders", "*"), new Option("Root folder only", ""), ...sorted.map((folder) => new Option(folder, folder)));
  select.value = [...select.options].some((option) => option.value === current) ? current : "*";
}

function afterChange() {
  state.groups = buildGroups(state.photos);
  renderFolders();
  renderDuplicates();
  renderOrganize();
  renderCategories();
  $("#work").disabled = state.busy || !state.root;
}

function showTab(name) {
  for (const tab of ["dup", "org"]) {
    $(`#tab-${tab}`).setAttribute("aria-selected", String(tab === name));
    $(`#view-${tab}`).hidden = tab !== name;
  }
}

// ---------- Events ----------

$("#pick").addEventListener("click", async () => {
  try {
    const result = await api("/api/pick", {});
    if (result.path) await openFolder(result.path);
  } catch (error) {
    setStatus(error.message);
  }
});
$("#open-path").addEventListener("click", () => $("#folder-path").value.trim() && openFolder($("#folder-path").value));
$("#folder-path").addEventListener("keydown", (event) => event.key === "Enter" && $("#open-path").click());
$("#analyze").addEventListener("click", sync);
$("#import").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async () => {
  const file = $("#import-file").files[0];
  $("#import-file").value = "";
  if (file) await importBackup(file);
});
$("#export").addEventListener("click", exportBackup);
$("#tab-dup").addEventListener("click", () => showTab("dup"));
$("#tab-org").addEventListener("click", () => showTab("org"));

$("#dup-filter").addEventListener("change", () => {
  state.groupLimit = PAGE_GROUPS;
  renderDuplicates();
});
$("#dup-mark").addEventListener("click", () => {
  state.dupMarked = new Set(exactCopies().map((photo) => photo.path));
  renderDuplicates();
});
$("#dup-clear").addEventListener("click", () => {
  state.dupMarked.clear();
  renderDuplicates();
});
$("#dup-delete").addEventListener("click", () => trashPhotos(state.photos.filter((photo) => state.dupMarked.has(photo.path))));
$("#dup-more").addEventListener("click", () => {
  state.groupLimit += PAGE_GROUPS;
  renderDuplicates();
});

let searchTimer;
$("#org-search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(resetOrganizePage, 200);
});
$("#org-folder").addEventListener("change", resetOrganizePage);
$("#org-near-clear").addEventListener("click", () => {
  state.near = null;
  resetOrganizePage();
});
$("#org-day-clear").addEventListener("click", () => {
  state.sameDay = null;
  resetOrganizePage();
});
$("#org-similar-clear").addEventListener("click", () => {
  state.examples = [];
  resetOrganizePage();
});
$("#org-select-all").addEventListener("click", () => {
  for (const photo of state.orgVisible) state.orgMarked.add(photo.path);
  renderOrganize();
});
$("#org-select-first").addEventListener("click", () => {
  const count = Math.max(1, Number($("#org-first").value) || 0);
  for (const photo of state.orgVisible.slice(0, count)) state.orgMarked.add(photo.path);
  if (count > state.photoLimit) state.photoLimit = count;
  renderOrganize();
});
$("#org-clear").addEventListener("click", () => {
  state.orgMarked.clear();
  renderOrganize();
});
$("#org-move").addEventListener("click", () => {
  const category = state.categories[state.category];
  if (!category) {
    $("#cat-name").focus();
    return;
  }
  movePhotos(state.photos.filter((photo) => state.orgMarked.has(photo.path)), category);
});
$("#org-copy").addEventListener("click", () => {
  const category = state.categories[state.category];
  if (!category) {
    $("#cat-name").focus();
    return;
  }
  movePhotos(state.photos.filter((photo) => state.orgMarked.has(photo.path)), category, true);
});
$("#org-trash").addEventListener("click", () => trashPhotos(state.photos.filter((photo) => state.orgMarked.has(photo.path))));
$("#org-more").addEventListener("click", () => {
  state.photoLimit += PAGE_PHOTOS;
  renderOrganize();
});
$("#cat-select").addEventListener("change", () => {
  state.category = $("#cat-select").value === "new" ? -1 : Number($("#cat-select").value);
  renderCategories();
});
$("#cat-name").addEventListener("input", updateCategoryPreview);
$("#cat-parent").addEventListener("input", updateCategoryPreview);
$("#cat-name").addEventListener("keydown", (event) => event.key === "Enter" && !$("#cat-create").disabled && createCategory());
$("#cat-create").addEventListener("click", createCategory);
$("#cat-pick").addEventListener("click", async () => {
  try {
    const result = await api("/api/pick", {});
    if (result.path) $("#cat-parent").value = result.path.replace(/\/+$/, "");
    updateCategoryPreview();
  } catch (error) {
    setStatus(error.message);
  }
});
$("#cat-remove").addEventListener("click", async () => {
  const category = state.categories[state.category];
  if (!category || !window.confirm(`Remove “${category.name}” from the list? The folder and its photos will remain unchanged.`)) return;
  state.categories.splice(state.category, 1);
  state.category = state.categories.length ? 0 : -1;
  await saveIndex().catch(() => {});
  renderCategories();
});

window.addEventListener("beforeunload", (event) => {
  if (state.busy) event.preventDefault();
});

(async () => {
  afterChange();
  setBusy(false);
  try {
    const { root } = await api("/api/state");
    const last = root || localStorage.getItem(LAST_FOLDER);
    if (last) await openFolder(last);
    else setStatus("Choose a photo folder to get started.");
  } catch {
    setStatus("Cannot connect to the local server. In Terminal, run: npm start");
  }
})();
