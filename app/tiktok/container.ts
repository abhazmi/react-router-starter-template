// MP4 container rewrites applied after the video is prepared. Only header and
// sample-table fields change; the encoded video and audio samples are copied as is.
//
// - applyTimescale(): the community "120 FPS method" (ut0ku/120fps-method,
//   EditingNews EN-TikTok-60FPS, 7-u8 TikTok-Quality-Toolkit).
// - applySilent(): an independent implementation of the Silent Method as described
//   in AscendedTweaks/silent-method's README.

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta"]);

type Box = { type: string; data: Uint8Array; children?: Box[] };

export class ContainerError extends Error {}

const u32 = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const type4 = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

function parseBoxes(buf: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(buf, p);
    const type = type4(buf, p + 4);
    let header = 8;
    if (size === 1) {
      // 64-bit size; only acceptable when it fits in a JS number.
      size = u32(buf, p + 8) * 2 ** 32 + u32(buf, p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) throw new ContainerError(`bad box ${type}`);
    const box: Box = { type, data: buf.subarray(p + header, p + size) };
    if (CONTAINERS.has(type)) box.children = parseBoxes(buf, p + header, p + size);
    out.push(box);
    p += size;
  }
  return out;
}

class Writer {
  private chunks: Uint8Array[] = [];
  length = 0;
  bytes(b: Uint8Array) {
    this.chunks.push(b);
    this.length += b.length;
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0);
    this.bytes(b);
  }
  str(s: string) {
    this.bytes(new TextEncoder().encode(s));
  }
  done() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const w = new Writer();
  const len = parts.reduce((n, p) => n + p.length, 0);
  w.u32(8 + len);
  w.str(type);
  parts.forEach((p) => w.bytes(p));
  return w.done();
}

function serialize(b: Box): Uint8Array {
  if (b.children) return box(b.type, ...b.children.map(serialize));
  return box(b.type, b.data);
}

function u32s(...nums: number[]) {
  const w = new Writer();
  nums.forEach((n) => w.u32(n));
  return w.done();
}

const child = (b: Box, type: string) => b.children?.find((c) => c.type === type);
const path = (b: Box, ...types: string[]) =>
  types.reduce<Box | undefined>((cur, t) => (cur ? child(cur, t) : undefined), b);

function handlerOf(trak: Box) {
  const hdlr = path(trak, "mdia", "hdlr");
  return hdlr ? type4(hdlr.data, 8) : "";
}

function readTable(b: Box, entryWords: number): number[][] {
  const n = u32(b.data, 4);
  const rows: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let k = 0; k < entryWords; k++) row.push(u32(b.data, 8 + (i * entryWords + k) * 4));
    rows.push(row);
  }
  return rows;
}

function readSampleSizes(stsz: Box): number[] {
  const fixed = u32(stsz.data, 4);
  const count = u32(stsz.data, 8);
  if (fixed) return new Array(count).fill(fixed);
  return Array.from({ length: count }, (_, i) => u32(stsz.data, 12 + i * 4));
}

function tableBox(type: string, rows: number[][], prefix: number[] = []) {
  return { type, data: u32s(0, ...prefix, rows.length, ...rows.flat()) } satisfies Box;
}

// ---------------------------------------------------------------------------
// "120 FPS method" (Oct 2026; ut0ku/120fps-method, EditingNews EN-TikTok-60FPS,
// 7-u8 TikTok-Quality-Toolkit): scale the timescale and duration of mvhd and of
// every mdhd by target/source fps. The declared length stays the same while the
// frame rate implied by the sample durations drops to the target, so TikTok's
// transcoder keeps the real frames. Only header fields change.

function scaleHeader(b: Box, scale: number) {
  const d = b.data.slice();
  const dv = new DataView(d.buffer);
  const v1 = d[0] === 1;
  const tsAt = v1 ? 20 : 12;
  const ts = dv.getUint32(tsAt);
  const newTs = Math.round(ts * scale);
  if (newTs < 1) throw new ContainerError(`timescale ${ts} cannot be scaled`);
  dv.setUint32(tsAt, newTs);
  if (v1) {
    const dur = Number(dv.getBigUint64(tsAt + 4));
    dv.setBigUint64(tsAt + 4, BigInt(Math.round(dur * scale)));
  } else {
    dv.setUint32(tsAt + 4, Math.round(dv.getUint32(tsAt + 4) * scale));
  }
  b.data = d;
}

export function applyTimescale(
  input: Uint8Array,
  fpsIn: number,
  fpsOut = 30,
): { bytes: Uint8Array; stats: { fpsIn: number; fpsOut: number } } {
  if (fpsIn <= fpsOut) throw new ContainerError(`source fps ${fpsIn} must be above ${fpsOut}`);
  const top = parseBoxes(input.slice(), 0, input.length);
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new ContainerError("missing moov");
  const traks = moov.children!.filter((b) => b.type === "trak");
  if (!traks.some((t) => handlerOf(t) === "vide")) throw new ContainerError("no video track");
  const scale = fpsOut / fpsIn;
  scaleHeader(child(moov, "mvhd")!, scale);
  for (const t of traks) scaleHeader(path(t, "mdia", "mdhd")!, scale);
  // Header sizes are unchanged, so chunk offsets stay valid.
  const parts = top.map(serialize);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return { bytes: out, stats: { fpsIn, fpsOut } };
}

// ---------------------------------------------------------------------------
// "Silent Method" (Nov 2026; AscendedTweaks/silent-method), reimplemented here
// from its published description: moov before mdat, audio and video interleaved
// per audio frame, fake 8-byte video samples in stsz/stco (not in stts, so players
// ignore them) up to duration × 400, last video frame lasting 1 tick, btrt with
// max = average bitrate, pasp 1:1, zeroed timestamps, and udta/meta removed.

const FAKE_PER_SEC = 400;
const FAKE_SAMPLE = new Uint8Array([0, 0, 0, 4, 0, 0, 0, 0]);

type TrackSamples = {
  trak: Box;
  isVideo: boolean;
  timescale: number;
  duration: number;
  deltas: number[];
  sizes: number[];
  offsets: number[];
  shift: number;
  dts: number[];
};

function trackSamples(trak: Box): TrackSamples {
  const stbl = path(trak, "mdia", "minf", "stbl")!;
  const mdhd = path(trak, "mdia", "mdhd")!.data;
  const v1 = mdhd[0] === 1;
  const timescale = u32(mdhd, v1 ? 20 : 12);
  const duration = v1 ? u32(mdhd, 24) * 2 ** 32 + u32(mdhd, 28) : u32(mdhd, 16);
  const deltas = readTable(child(stbl, "stts")!, 2).flatMap(([n, d]) => new Array(n).fill(d));
  const sizes = readSampleSizes(child(stbl, "stsz")!).slice(0, deltas.length);
  const stco = child(stbl, "stco");
  if (!stco) throw new ContainerError("64-bit offsets not supported");
  const chunks = readTable(stco, 1).map((r) => r[0]);
  const stsc = readTable(child(stbl, "stsc")!, 3);
  if (u32(child(stbl, "stsd")!.data, 4) !== 1) throw new ContainerError("multiple sample descriptions");

  const offsets: number[] = [];
  for (let c = 0, e = 0; c < chunks.length && offsets.length < sizes.length; c++) {
    while (e + 1 < stsc.length && stsc[e + 1][0] <= c + 1) e++;
    let o = chunks[c];
    for (let k = 0; k < stsc[e][1] && offsets.length < sizes.length; k++) {
      offsets.push(o);
      o += sizes[offsets.length - 1];
    }
  }

  // Media time of the first non-empty edit, so both tracks line up on the timeline.
  let shift = 0;
  const elst = path(trak, "edts", "elst");
  if (elst) {
    const dv = new DataView(elst.data.buffer, elst.data.byteOffset, elst.data.byteLength);
    const n = u32(elst.data, 4);
    for (let k = 0; k < n; k++) {
      const t = elst.data[0] === 1 ? Number(dv.getBigInt64(16 + 20 * k)) : dv.getInt32(12 + 12 * k);
      if (t !== -1) {
        shift = t;
        break;
      }
    }
  }
  const dts: number[] = [];
  deltas.reduce((t, d) => (dts.push(t), t + d), 0);
  return { trak, isVideo: handlerOf(trak) === "vide", timescale, duration, deltas, sizes, offsets, shift, dts };
}

function runLength(values: number[]): number[][] {
  const out: number[][] = [];
  for (const v of values) {
    const last = out.at(-1);
    if (last && last[1] === v) last[0]++;
    else out.push([1, v]);
  }
  return out;
}

/** Rewrites the video sample entry so it carries pasp (1:1 unless present) and btrt (max = avg). */
function patchVisualEntry(stsd: Box, avgBitrate: number) {
  const d = stsd.data;
  const entrySize = u32(d, 8);
  const entryType = type4(d, 12);
  const fixed = d.subarray(16, 16 + 78); // VisualSampleEntry fields before the child boxes
  const kids = parseBoxes(d, 16 + 78, 8 + entrySize);
  const pasp = kids.find((k) => k.type === "pasp")?.data ?? u32s(1, 1);
  const rest = kids.filter((k) => k.type !== "pasp" && k.type !== "btrt").map(serialize);
  const entry = box(entryType, fixed, ...rest, box("pasp", pasp), box("btrt", u32s(0, avgBitrate, avgBitrate)));
  stsd.data = new Uint8Array([...d.subarray(0, 8), ...entry]);
}

function zeroBoxTimes(b: Box) {
  const d = b.data.slice();
  d.fill(0, 4, d[0] === 1 ? 20 : 12);
  b.data = d;
}

export function applySilent(input: Uint8Array): {
  bytes: Uint8Array;
  stats: { frames: number; fakes: number };
} {
  const file = input.slice();
  const top = parseBoxes(file, 0, file.length);
  if (top.some((b) => b.type === "moof")) throw new ContainerError("fragmented MP4 not supported");
  const ftyp = top.find((b) => b.type === "ftyp");
  const moov = top.find((b) => b.type === "moov");
  if (!ftyp || !moov) throw new ContainerError("missing ftyp/moov");
  const traks = moov.children!.filter((b) => b.type === "trak");
  const tracks = traks.map(trackSamples);
  const vIndex = tracks.findIndex((t) => t.isVideo);
  if (vIndex < 0) throw new ContainerError("no video track");
  const video = tracks[vIndex];

  // Order every sample by presentation time; video first on ties.
  const events: { i: number; s: number; t: number }[] = [];
  tracks.forEach((tr, i) =>
    tr.dts.forEach((d, s) => events.push({ i, s, t: (d - tr.shift) / tr.timescale })),
  );
  events.sort((a, b) => a.t - b.t || +(a.i !== vIndex) - +(b.i !== vIndex) || a.i - b.i || a.s - b.s);

  // Consecutive video frames share a chunk; each audio frame is its own chunk.
  const chunks: { i: number; samples: number[] }[] = [];
  for (const { i, s } of events) {
    const last = chunks.at(-1);
    if (last && last.i === i && i === vIndex) last.samples.push(s);
    else chunks.push({ i, samples: [s] });
  }
  const layout = tracks.map(() => [] as { rel: number; count: number }[]);
  let rel = 0;
  for (const c of chunks) {
    layout[c.i].push({ rel, count: c.samples.length });
    for (const s of c.samples) rel += tracks[c.i].sizes[s];
  }
  const fakes = Math.max(0, Math.round((video.duration * FAKE_PER_SEC) / video.timescale) - video.sizes.length);
  const fakeRel = rel;
  for (let k = 0; k < fakes; k++) layout[vIndex].push({ rel: fakeRel, count: 1 });

  const avg = Math.floor(
    (video.sizes.reduce((a, b) => a + b, 0) * 8 * video.timescale) / Math.max(1, video.duration),
  );

  // Rewrite each track's sample tables; offsets are filled in once moov's size is known.
  const setOffsets = (base: number) =>
    tracks.forEach((tr, i) => {
      const stbl = path(tr.trak, "mdia", "minf", "stbl")!;
      const set = (t: string, b: Box) => {
        const at = stbl.children!.findIndex((c) => c.type === t);
        stbl.children![at] = b;
      };
      set("stco", tableBox("stco", layout[i].map((l) => [base + l.rel])));
    });
  tracks.forEach((tr, i) => {
    const stbl = path(tr.trak, "mdia", "minf", "stbl")!;
    const isV = i === vIndex;
    const sizes = isV ? [...tr.sizes, ...new Array(fakes).fill(FAKE_SAMPLE.length)] : tr.sizes;
    const firstFake = isV ? layout[i].length - fakes : -1;
    const stsc: number[][] = [];
    layout[i].forEach((l, k) => {
      const last = stsc.at(-1);
      if (!last || last[1] !== l.count || k === firstFake) stsc.push([k + 1, l.count, 1]);
    });
    stbl.children = stbl.children!.map((c) => {
      if (c.type === "stsz") return { type: "stsz", data: u32s(0, 0, sizes.length, ...sizes) };
      if (c.type === "stsc") return tableBox("stsc", stsc);
      if (c.type === "stts" && isV) {
        return tableBox("stts", runLength([...tr.deltas.slice(0, -1), 1]));
      }
      if (c.type === "stsd" && isV) patchVisualEntry(c, avg);
      return c;
    });
  });

  // Zero timestamps and drop editor metadata.
  const strip = (b: Box): Box => {
    if (["mvhd", "tkhd", "mdhd"].includes(b.type)) zeroBoxTimes(b);
    if (!b.children || b.type === "stbl") return b;
    return { ...b, children: b.children.filter((c) => c.type !== "udta" && c.type !== "meta").map(strip) };
  };
  const newMoov = strip(moov);

  const head = new Uint8Array([...serialize(ftyp), ...box("free")]);
  setOffsets(0);
  const base = head.length + serialize(newMoov).length + 8;
  setOffsets(base);
  const moovBytes = serialize(newMoov);

  const payload = new Uint8Array(rel + FAKE_SAMPLE.length);
  let o = 0;
  for (const c of chunks) {
    const tr = tracks[c.i];
    for (const s of c.samples) {
      payload.set(file.subarray(tr.offsets[s], tr.offsets[s] + tr.sizes[s]), o);
      o += tr.sizes[s];
    }
  }
  payload.set(FAKE_SAMPLE, o);
  const mdat = box("mdat", payload);

  const out = new Uint8Array(head.length + moovBytes.length + mdat.length);
  out.set(head);
  out.set(moovBytes, head.length);
  out.set(mdat, head.length + moovBytes.length);
  return { bytes: out, stats: { frames: video.sizes.length, fakes } };
}
