// png-squeeze-01-run-20261127: squeeze 1280x720 RGBA screenshots into the smallest
// lossless PNG. One program, stdlib only (Node 22), deterministic, whole set in <60s.
//
// Strategy: decode the stored input PNG, pick the best lossless form per image
// (palette when <=256 colours, grey / grey+alpha when all pixels are grey, RGB when
// opaque, RGBA otherwise, with a tRNS key when a single transparent value allows
// dropping the alpha channel), choose each row's PNG filter by several heuristics
// plus per-row brute force scored with zlib, then deflate at level 9 and keep the
// smallest of several strategies. Run as: node /bot/main.ts, reading
// $MAKEFUN_INPUT_DIR/<id>/image.png and writing $MAKEFUN_OUTPUT_DIR/<id>/image.png.
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- CRC-32 / PNG
const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  let size = 8;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(w: number, h: number, ct: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  d[8] = 8;
  d[9] = ct;
  return d;
}

// ---------------------------------------------------------------- PNG filters
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Filter `cur` (one row, `bpp` bytes a pixel) by `type` into `out`. */
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    if (prev === null) { out.set(cur); return; }
    for (let i = 0; i < n; i++) out[i] = cur[i] - prev[i];
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((a + b) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

/** Sum of a filtered row's bytes read as signed values: the minimum-sum heuristic. */
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/** Distinct neighbouring byte pairs in a row: the fewest-pairs heuristic. */
function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- decode input
interface Decoded { rgba: Uint8Array; width: number; height: number }

function unfilterRow(type: number, row: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = row.length;
  if (type === 0) { out.set(row); return; }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = (row[i] + (i >= bpp ? out[i - bpp] : 0)) & 255;
  } else if (type === 2) {
    if (prev === null) { out.set(row); return; }
    for (let i = 0; i < n; i++) out[i] = (row[i] + prev[i]) & 255;
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      out[i] = (row[i] + ((a + b) >> 1)) & 255;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = (row[i] + paeth(a, b, c)) & 255;
    }
  }
}

/** Decode any PNG the contest accepts (here: the stored RGBA input) to raw RGBA. */
function decodePng(bytes: Uint8Array): Decoded {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      colourType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  let total = 0;
  for (const d of idat) total += d.length;
  const comp = new Uint8Array(total);
  let o = 0;
  for (const d of idat) { comp.set(d, o); o += d.length; }
  const raw = inflateSync(comp);
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  let prev: Uint8Array | null = null;
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rgba.subarray(y * stride, (y + 1) * stride);
    unfilterRow(f, row, prev, 4, out);
    prev = out;
  }
  void colourType;
  return { rgba, width, height };
}

// ---------------------------------------------------------------- image forms
interface Colour { rgba: number[]; word: number; count: number }
interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: (number | 'minsum' | 'pairs' | 'brute')[];
}

function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: Colour[] | null } {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else {
        counts.set(c, k + 1);
      }
    }
  }
  const colours: Colour[] | null = many
    ? null
    : [...counts.keys()].map((c) => {
        const b = new Uint8Array(Uint32Array.of(c).buffer);
        return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) as number };
      });
  return { opaque, grey, colours };
}

/**
 * The one fully transparent value (grey or RGB) the image may key by tRNS instead
 * of an alpha channel: every pixel opaque or that exact value at alpha 0, and no
 * opaque pixel of the same value. Null when there is none.
 */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

function paletteOrder(colours: Colour[], order: string): Colour[] {
  const lum = (c: Colour): number => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): { plte: Uint8Array; trns: Uint8Array | null; indices: Uint8Array } {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return { plte, trns, indices };
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({
        colourType: 3,
        bpp: 1,
        samples: p.indices,
        plte: p.plte,
        trns: p.trns,
        filters: order === 'count' ? [0] : [0, 'minsum', 'brute'],
      });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[ct];
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

// ---------------------------------------------------------------- filtering
const BRUTE_CONTEXT = 32768;

/** The filtered rows of `samples` by `choice`: a fixed filter, a heuristic, or brute force. */
function filtered(samples: Uint8Array, width: number, height: number, bpp: number, choice: number | 'minsum' | 'pairs' | 'brute'): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial: Uint8Array[] = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(
          trial[t],
          before.length === 0
            ? { level: 4, memLevel: 9 }
            : { level: 4, memLevel: 9, dictionary: before },
        ).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

const chunkBytes = (form: Form): number =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// ---------------------------------------------------------------- squeeze one
function squeeze(rgba: Uint8Array, width: number, height: number): Uint8Array {
  // Per-form best filter choice at level 6, then level 9 across forms
  // (the level-6 and level-9 rankings can differ).
  const perForm: { form: Form; data: Uint8Array; bytes: number }[] = [];
  for (const form of formsOf(rgba)) {
    let fb: { form: Form; data: Uint8Array; bytes: number } | null = null;
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const zlib = deflateSync(data, { level: 6, memLevel: 8 });
      const bytes = zlib.length + chunkBytes(form);
      if (fb === null || bytes < fb.bytes) fb = { form, data, bytes };
    }
    perForm.push(fb as { form: Form; data: Uint8Array; bytes: number });
  }
  let best: { form: Form; data: Uint8Array; bytes: number } | null = null;
  let bestZlib: Uint8Array | null = null;
  for (const cand of perForm) {
    for (const strategy of [0, 1, 2]) {
      const z = deflateSync(cand.data, { level: 9, memLevel: 9, strategy });
      const bytes = z.length + chunkBytes(cand.form);
      if (bestZlib === null || bytes < (best as { bytes: number }).bytes) {
        best = { ...cand, bytes };
        bestZlib = z;
      }
    }
  }
  // Custom DEFLATE on the winner's filtered data: keep it only when it beats
  // zlib level 9, so this step can never make the entry worse.
  const custom = deflateCustom((best as { data: Uint8Array }).data);
  if (custom.length < (bestZlib as Uint8Array).length) {
    bestZlib = custom;
    best = { ...(best as { form: Form; data: Uint8Array; bytes: number }), bytes: custom.length + chunkBytes((best as { form: Form }).form) };
  }
  const form = (best as { form: Form }).form;
  const chunks: [string, Uint8Array][] = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', new Uint8Array(bestZlib as Uint8Array)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------------------------------------------------------------- custom DEFLATE
// A small zopfli-lite DEFLATE encoder: lazy hash-chain LZ77 (zlib's
// deflate_slow structure) with deep chains, per-block dynamic Huffman tables,
// and a sparse optimal-parse pass over the matches the greedy parse recorded.
// It beats Node's zlib level 9 by a few percent on these screenshots, which is
// worth real points; the zlib-9 stream is always kept as a fallback, so the
// encoder never writes worse than zlib level 9. Deterministic: no time or
// randomness anywhere.
const MAX_DIST = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

// DEFLATE length / distance symbol tables.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenSym(len: number): number {
  let lo = 0, hi = 28;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1; }
  return 257 + lo;
}
function distSym(dist: number): number {
  let lo = 0, hi = 29;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (DIST_BASE[mid] <= dist) lo = mid; else hi = mid - 1; }
  return lo;
}

// Code lengths (<= maxBits) from frequencies: Huffman tree + zlib's overflow
// fix-up. Returns Uint8Array lengths (0 = unused).
function codeLengths(freq: Int32Array, maxBits: number): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  syms.sort((a, b) => freq[a] - freq[b] || a - b);
  const parent = new Int32Array(2 * n).fill(-1);
  const weight = new Float64Array(2 * n);
  for (const s of syms) weight[s] = freq[s];
  const q1 = syms.slice();
  const q2: number[] = [];
  let next = n;
  const takeMin = (): number => {
    if (q2.length === 0) return q1.shift() as number;
    if (q1.length === 0) return q2.shift() as number;
    return weight[q1[0]] <= weight[q2[0]] ? (q1.shift() as number) : (q2.shift() as number);
  };
  while (q1.length + q2.length > 1) {
    const a = takeMin();
    const b = takeMin();
    parent[a] = next;
    parent[b] = next;
    weight[next] = weight[a] + weight[b];
    q2.push(next);
    next++;
  }
  const depth = new Int32Array(2 * n);
  for (let i = next - 1; i >= 0; i--) {
    const p = parent[i];
    if (p >= 0) depth[i] = depth[p] + 1;
  }
  const blCount = new Int32Array(maxBits + 1);
  let overflow = 0;
  for (const s of syms) {
    let d = depth[s];
    if (d > maxBits) { overflow++; d = maxBits; }
    lengths[s] = d;
    blCount[d]++;
  }
  if (overflow > 0) {
    do {
      let bits = maxBits - 1;
      while (blCount[bits] === 0) bits--;
      blCount[bits]--;
      blCount[bits + 1] += 2;
      blCount[maxBits]--;
      overflow -= 2;
    } while (overflow > 0);
    // Reassign: shortest codes to the most frequent symbols.
    const byFreq = syms.slice().sort((a, b) => freq[b] - freq[a] || a - b);
    let idx = 0;
    for (let bits = 1; bits <= maxBits; bits++) {
      for (let k = 0; k < blCount[bits]; k++) lengths[byFreq[idx++]] = bits;
    }
  }
  return lengths;
}

// Canonical codes from lengths.
function canonicalCodes(lengths: Uint8Array): { codes: Uint32Array; lengths: Uint8Array } {
  const n = lengths.length;
  const blCount = new Int32Array(16);
  for (let i = 0; i < n; i++) blCount[lengths[i]]++;
  blCount[0] = 0;
  const nextCode = new Int32Array(16);
  let code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const len = lengths[i];
    if (len !== 0) codes[i] = nextCode[len]++;
  }
  return { codes, lengths };
}

// Fixed Huffman tables (DEFLATE spec).
const FIXED_LIT_LEN: Uint8Array = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return l;
})();
const FIXED_DIST_LEN: Uint8Array = new Uint8Array(30).fill(5);

class BitWriter {
  bytes: number[] = [];
  bitBuf = 0;
  bitCnt = 0;
  writeBits(code: number, len: number): void {
    this.bitBuf |= (code & ((1 << len) - 1)) << this.bitCnt;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  // Write a Huffman code, most-significant bit first.
  writeCode(code: number, len: number): void {
    let rev = 0;
    for (let i = 0; i < len; i++) { rev = (rev << 1) | ((code >> i) & 1); }
    this.writeBits(rev, len);
  }
  align(): void {
    if (this.bitCnt > 0) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
  }
  toBytes(): Uint8Array { return Uint8Array.from(this.bytes); }
}

function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

interface Tokens {
  sym: Int32Array;
  dist: Int32Array;
  pos: Int32Array;
  lenArr?: Int32Array;
  recLen?: Uint16Array;
  recDist?: Int32Array;
}

// Lazy hash-chain LZ77 (zlib's deflate_slow structure). Returns the token
// stream plus, for the optimal-parse pass, the longest match found at each
// searched position (recLen / recDist).
function parseLZ77(data: Uint8Array, opts: { maxChain?: number }): Tokens {
  const n = data.length;
  const maxChain = opts.maxChain ?? 8192;
  const goodLen = 32;
  const niceLen = 258;

  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n);
  const sym: number[] = [];
  const dist: number[] = [];
  const pos: number[] = [];

  const hashAt = (p: number): number => (((data[p] << 10) ^ (data[p + 1] << 5) ^ data[p + 2]) & HASH_MASK);
  const insert = (p: number): number => {
    const h = hashAt(p);
    prev[p] = head[h];
    head[h] = p;
    return prev[p];
  };
  // Longest match at `p` strictly longer than minLen, starting the chain at
  // `start` (the previous occurrence). Returns [len, dist] or [0, 0].
  const longestMatch = (p: number, minLen: number, start: number): [number, number] => {
    const limit = p > MAX_DIST ? p - MAX_DIST : -1;
    const maxLen = Math.min(MAX_MATCH, n - p);
    if (maxLen <= minLen) return [0, 0];
    let bestLen = minLen;
    let bestDist = 0;
    let cur = start;
    let chain = bestLen >= goodLen ? (maxChain >> 2) : maxChain;
    let scanEnd = data[p + bestLen];
    while (cur > limit && chain-- > 0) {
      if (data[cur + bestLen] === scanEnd) {
        let l = 0;
        while (l < maxLen && data[p + l] === data[cur + l]) l++;
        if (l > bestLen) {
          bestLen = l;
          bestDist = p - cur;
          if (l >= niceLen) break;
          scanEnd = data[p + bestLen];
        }
      }
      cur = prev[cur];
    }
    return bestLen > minLen ? [bestLen, bestDist] : [0, 0];
  };

  // Longest match found at each searched position (for the DP).
  const recLen = new Uint16Array(n);
  const recDist = new Int32Array(n);
  let strstart = 0;
  let matchLen = 0, matchDist = 0;
  let matchAvail = false;
  while (strstart < n) {
    let hashHead = -1;
    if (strstart + MIN_MATCH <= n) hashHead = insert(strstart);
    const prevLen = matchLen, prevDist = matchDist;
    matchLen = 0; matchDist = 0;
    if (hashHead !== -1 && prevLen < 258) {
      const r = longestMatch(strstart, prevLen, hashHead);
      matchLen = r[0]; matchDist = r[1];
      if (matchLen >= MIN_MATCH) { recLen[strstart] = matchLen; recDist[strstart] = matchDist; }
    }
    if (prevLen >= MIN_MATCH && matchLen <= prevLen) {
      // Emit the previous match (at strstart-1).
      recLen[strstart - 1] = prevLen; recDist[strstart - 1] = prevDist;
      sym.push(lenSym(prevLen));
      dist.push(prevDist);
      pos.push(strstart - 1);
      let rem = prevLen - 2;
      while (rem-- > 0) {
        strstart++;
        if (strstart + MIN_MATCH <= n) insert(strstart);
      }
      matchAvail = false;
      matchLen = 0;
      strstart++;
    } else if (matchAvail) {
      // No previous match beats this one: emit the pending literal, and the
      // match at strstart becomes pending (matchAvail stays true).
      sym.push(data[strstart - 1]);
      dist.push(0);
      pos.push(strstart - 1);
      strstart++;
    } else {
      matchAvail = true;
      strstart++;
    }
  }
  if (matchAvail) {
    sym.push(data[n - 1]);
    dist.push(0);
    pos.push(n - 1);
  }
  sym.push(256);
  dist.push(0);
  pos.push(n);
  return { sym: Int32Array.from(sym), dist: Int32Array.from(dist), pos: Int32Array.from(pos), recLen, recDist };
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function emitBlock(w: BitWriter, toks: Tokens, t0: number, t1: number, isLast: boolean, useFixed: boolean): void {
  const litFreq = new Int32Array(288);
  const distFreq = new Int32Array(30);
  for (let i = t0; i < t1; i++) {
    const s = toks.sym[i];
    litFreq[s]++;
    if (s > 256) distFreq[distSym(toks.dist[i])]++;
  }
  // Every block ends with the end-of-block symbol, so count it for the table.
  litFreq[256]++;
  const litLen = useFixed ? FIXED_LIT_LEN : codeLengths(litFreq, 15);
  const distLen = useFixed ? FIXED_DIST_LEN : codeLengths(distFreq, 15);
  const lit = canonicalCodes(litLen);
  const distC = canonicalCodes(distLen);
  w.writeBits(isLast ? 1 : 0, 1);
  if (useFixed) {
    w.writeBits(1, 2); // BTYPE=01 fixed
  } else {
    w.writeBits(2, 2); // BTYPE=10 dynamic
    let hlit = 288;
    while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
    let hdist = 30;
    while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
    const seq: number[] = [];
    for (let i = 0; i < hlit; i++) seq.push(litLen[i]);
    for (let i = 0; i < hdist; i++) seq.push(distLen[i]);
    // RLE the code-length sequence (16 = repeat prev 3-6, 17 = zero 3-10,
    // 18 = zero 11-138).
    const cl: [number, number, number][] = [];
    let j = 0;
    while (j < seq.length) {
      const v = seq[j];
      let run = 1;
      while (j + run < seq.length && seq[j + run] === v) run++;
      if (v === 0) {
        let r = run;
        while (r >= 11) { const k = Math.min(r, 138); cl.push([18, 7, k - 11]); r -= k; }
        if (r >= 3) { cl.push([17, 3, r - 3]); r = 0; }
        while (r-- > 0) cl.push([0, 0, 0]);
      } else {
        cl.push([v, 0, 0]);
        let r = run - 1;
        while (r >= 3) { const k = Math.min(r, 6); cl.push([16, 2, k - 3]); r -= k; }
        while (r-- > 0) cl.push([v, 0, 0]);
      }
      j += run;
    }
    const clFreq = new Int32Array(19);
    for (const [s] of cl) clFreq[s]++;
    const clLen = codeLengths(clFreq, 7);
    const clCode = canonicalCodes(clLen);
    let hclen = 19;
    while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
    w.writeBits(hlit - 257, 5);
    w.writeBits(hdist - 1, 5);
    w.writeBits(hclen - 4, 4);
    for (let k = 0; k < hclen; k++) w.writeBits(clLen[CL_ORDER[k]], 3);
    for (const [s, eb, ev] of cl) {
      w.writeCode(clCode.codes[s], clLen[s]);
      if (eb > 0) w.writeBits(ev, eb);
    }
  }
  for (let i = t0; i < t1; i++) {
    const s = toks.sym[i];
    if (s <= 256) {
      w.writeCode(lit.codes[s], litLen[s]);
    } else {
      w.writeCode(lit.codes[s], litLen[s]);
      const li = s - 257;
      const L = (toks.lenArr as Int32Array)[i];
      if (LEN_EXTRA[li] > 0) w.writeBits(L - LEN_BASE[li], LEN_EXTRA[li]);
      const d = toks.dist[i];
      const ds = distSym(d);
      w.writeCode(distC.codes[ds], distLen[ds]);
      if (DIST_EXTRA[ds] > 0) w.writeBits(d - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  // Every block ends with the end-of-block symbol; the token stream only
  // carries it for the last block, so emit it here for the others.
  if (!isLast) w.writeCode(lit.codes[256], litLen[256]);
}

function blockBitCost(toks: Tokens, t0: number, t1: number, litLen: Uint8Array, distLen: Uint8Array): number {
  let bits = 0;
  for (let i = t0; i < t1; i++) {
    const s = toks.sym[i];
    bits += litLen[s];
    if (s > 256) {
      const d = toks.dist[i];
      const ds = distSym(d);
      bits += distLen[ds] + DIST_EXTRA[ds] + LEN_EXTRA[s - 257];
    }
  }
  return bits;
}

// Emit a token stream as a zlib stream (block splitting + fixed/dynamic choice).
function emitTokens(data: Uint8Array, toks: Tokens, blockSize: number): Uint8Array {
  const lenArr = new Int32Array(toks.sym.length);
  for (let i = 0; i < toks.sym.length; i++) {
    if (toks.sym[i] > 256) {
      const nextPos = i + 1 < toks.pos.length ? toks.pos[i + 1] : data.length;
      lenArr[i] = nextPos - toks.pos[i];
    }
  }
  toks.lenArr = lenArr;
  const bounds = [0];
  for (let i = 1; i < toks.sym.length; i++) {
    if (toks.pos[i] - toks.pos[bounds[bounds.length - 1]] >= blockSize && toks.sym[i] !== 256) bounds.push(i);
  }
  bounds.push(toks.sym.length);
  const w = new BitWriter();
  for (let b = 0; b < bounds.length - 1; b++) {
    const t0 = bounds[b], t1 = bounds[b + 1];
    const isLast = b === bounds.length - 2;
    const litFreq = new Int32Array(288);
    const distFreq = new Int32Array(30);
    for (let i = t0; i < t1; i++) {
      const s = toks.sym[i];
      litFreq[s]++;
      if (s > 256) distFreq[distSym(toks.dist[i])]++;
    }
    litFreq[256]++;
    const dynLit = codeLengths(litFreq, 15);
    const dynDist = codeLengths(distFreq, 15);
    const dynBits = blockBitCost(toks, t0, t1, dynLit, dynDist) + 400;
    const fixBits = blockBitCost(toks, t0, t1, FIXED_LIT_LEN, FIXED_DIST_LEN);
    emitBlock(w, toks, t0, t1, isLast, fixBits <= dynBits);
  }
  w.align();
  const body = w.toBytes();
  const res = new Uint8Array(2 + body.length + 4);
  res[0] = 0x78; res[1] = 0x9c;
  res.set(body, 2);
  const ad = adler32(data);
  res[res.length - 4] = (ad >>> 24) & 0xff;
  res[res.length - 3] = (ad >>> 16) & 0xff;
  res[res.length - 2] = (ad >>> 8) & 0xff;
  res[res.length - 1] = ad & 0xff;
  return res;
}

// Cost tables (1/16-bit units) from token frequencies.
function costTables(toks: Tokens): { litCost: Float64Array; lenCost: Float64Array; distCost: Float64Array } {
  const litFreq = new Int32Array(288);
  const distFreq = new Int32Array(30);
  for (let i = 0; i < toks.sym.length; i++) {
    const s = toks.sym[i];
    litFreq[s]++;
    if (s > 256) distFreq[distSym(toks.dist[i])]++;
  }
  litFreq[256]++;
  const litLen = codeLengths(litFreq, 15);
  const distLen = codeLengths(distFreq, 15);
  const litCost = new Float64Array(288);
  const lenCost = new Float64Array(29);
  const distCost = new Float64Array(30);
  for (let i = 0; i < 288; i++) litCost[i] = litLen[i] * 16;
  for (let i = 0; i < 29; i++) lenCost[i] = (litLen[257 + i] + LEN_EXTRA[i]) * 16;
  for (let i = 0; i < 30; i++) distCost[i] = (distLen[i] + DIST_EXTRA[i]) * 16;
  return { litCost, lenCost, distCost };
}

// Sparse optimal parse: match options only where the greedy parse recorded
// one. At each such position, try the full length and every shorter length
// that starts a new length symbol (any prefix of the recorded match is valid).
function dpSparse(
  data: Uint8Array,
  recLen: Uint16Array,
  recDist: Int32Array,
  costs: { litCost: Float64Array; lenCost: Float64Array; distCost: Float64Array },
): Tokens | null {
  const n = data.length;
  const { litCost, lenCost, distCost } = costs;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const prev = new Int32Array(n + 1).fill(-1);
  const tokLen = new Int16Array(n + 1);
  const tokDist = new Int32Array(n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const c = cost[i];
    if (c === Infinity) continue;
    const lc = c + litCost[data[i]];
    if (lc < cost[i + 1]) { cost[i + 1] = lc; prev[i + 1] = i; tokLen[i + 1] = 0; }
    const Lmax = recLen[i];
    if (Lmax >= 3) {
      const d = recDist[i];
      const dc = distCost[distSym(d)];
      let L = Lmax;
      for (;;) {
        const mc = c + lenCost[lenSym(L) - 257] + dc;
        const j = i + L;
        if (mc < cost[j]) { cost[j] = mc; prev[j] = i; tokLen[j] = L; tokDist[j] = d; }
        if (L <= 3) break;
        const sym = lenSym(L) - 257;
        if (sym === 0) break;
        L = LEN_BASE[sym] - 1;
        if (L < 3) break;
      }
    }
  }
  if (prev[n] < 0) return null;
  const sym: number[] = [];
  const dist: number[] = [];
  const pos: number[] = [];
  let i = n;
  while (i > 0) {
    const p = prev[i];
    const L = tokLen[i];
    if (L === 0) { sym.push(data[p]); dist.push(0); pos.push(p); }
    else { sym.push(lenSym(L)); dist.push(tokDist[i]); pos.push(p); }
    i = p;
  }
  sym.reverse(); dist.reverse(); pos.reverse();
  sym.push(256); dist.push(0); pos.push(n);
  return { sym: Int32Array.from(sym), dist: Int32Array.from(dist), pos: Int32Array.from(pos) };
}

// The custom DEFLATE of `data`: greedy parse, then two optimal-parse passes
// with refined cost tables; the smallest emission wins.
function deflateCustom(data: Uint8Array): Uint8Array {
  const greedy = parseLZ77(data, { maxChain: 8192 });
  let best = emitTokens(data, greedy, 131072);
  const fixedCosts = {
    litCost: Float64Array.from(FIXED_LIT_LEN, (x) => x * 16),
    lenCost: Float64Array.from({ length: 29 }, (_, i) => (FIXED_LIT_LEN[257 + i] + LEN_EXTRA[i]) * 16),
    distCost: Float64Array.from(FIXED_DIST_LEN, (x) => x * 16),
  };
  const dp1 = dpSparse(data, greedy.recLen as Uint16Array, greedy.recDist as Int32Array, fixedCosts);
  if (dp1) {
    const out1 = emitTokens(data, dp1, 131072);
    if (out1.length < best.length) best = out1;
    const costs2 = costTables(dp1);
    const dp2 = dpSparse(data, greedy.recLen as Uint16Array, greedy.recDist as Int32Array, costs2);
    if (dp2) {
      const out2 = emitTokens(data, dp2, 131072);
      if (out2.length < best.length) best = out2;
    }
  }
  return best;
}

// ---------------------------------------------------------------- main
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
