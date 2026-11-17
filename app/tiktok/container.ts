// Rewrites an MP4 produced in the browser so it is laid out like a file straight
// from an iPhone camera, matching what SHANAB MAX output contains: QuickTime
// brand, "Core Media" handler names, an nclc colour box plus a field box in the
// video sample entry, a 600 movie timescale, and moov before mdat. Sample data
// is copied untouched; only headers and chunk offsets change.

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

function tableBox(type: string, rows: number[][], prefix: number[] = []) {
  return { type, data: u32s(0, ...prefix, rows.length, ...rows.flat()) } satisfies Box;
}


const enc = (s: string) => new TextEncoder().encode(s);

function fullBox(type: string, flags: number, ...parts: Uint8Array[]) {
  return box(type, u32s(flags & 0xffffff), ...parts);
}

/** QuickTime-style handler: component type + subtype, Pascal-string name (as iPhone files have). */
function qtHandler(component: "mhlr" | "dhlr", subtype: string, name: string): Box {
  const n = enc(name);
  return { type: "hdlr", data: new Uint8Array([...u32s(0), ...enc(component), ...enc(subtype), ...new Uint8Array(12), n.length, ...n]) };
}

/** Stereo channel layout box (kAudioChannelLayoutTag_Stereo), as QuickTime writes in mp4a. */
const CHAN_STEREO = new Uint8Array([0, 0, 0, 0, 0, 0x65, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]);

/** Replaces btrt with a chan box in a stereo mp4a entry. */
function cameraAudioEntry(stsd: Box) {
  const d = stsd.data;
  const entrySize = u32(d, 8);
  if (type4(d, 12) !== "mp4a" || d[16 + 8] !== 0 || d[16 + 9] !== 0) return; // only v0 sound entries
  const channels = (d[16 + 16] << 8) | d[16 + 17];
  const fixed = d.subarray(16, 16 + 28);
  const kids = parseBoxes(d, 16 + 28, 8 + entrySize).filter((k) => k.type !== "btrt" && k.type !== "chan");
  const extra = channels === 2 ? [box("chan", CHAN_STEREO)] : [];
  const entry = box("mp4a", fixed, ...kids.map(serialize), ...extra);
  stsd.data = new Uint8Array([...d.subarray(0, 8), ...entry]);
}

/** stbl children in the order QuickTime writes them. */
const STBL_ORDER = ["stsd", "stts", "ctts", "stss", "sdtp", "stsc", "stsz", "stco", "sgpd", "sbgp"];

/** Keeps the codec config box and adds QuickTime-style fiel + nclc colr, as iPhone files have. */
function cameraVisualEntry(stsd: Box) {
  const d = stsd.data;
  const entrySize = u32(d, 8);
  const entryType = type4(d, 12);
  const fixed = d.subarray(16, 16 + 78);
  const kids = parseBoxes(d, 16 + 78, 8 + entrySize);
  const config = kids.filter((k) => k.type === "hvcC" || k.type === "avcC").map(serialize);
  let primaries = 1, transfer = 1, matrix = 1;
  const colr = kids.find((k) => k.type === "colr");
  if (colr && colr.data.length >= 10) {
    const v = new DataView(colr.data.buffer, colr.data.byteOffset, colr.data.byteLength);
    primaries = v.getUint16(4);
    transfer = v.getUint16(6);
    matrix = v.getUint16(8);
  }
  const fiel = box("fiel", new Uint8Array([1, 0]));
  const nclc = new Uint8Array(10);
  nclc.set(enc("nclc"));
  const nv = new DataView(nclc.buffer);
  nv.setUint16(4, primaries);
  nv.setUint16(6, transfer);
  nv.setUint16(8, matrix);
  const entry = box(entryType, fixed, ...config, fiel, box("colr", nclc));
  stsd.data = new Uint8Array([...d.subarray(0, 8), ...entry]);
}

/** Converts a media timescale to 600 when every sample duration divides exactly. */
function mediaTo600(mdhd: Box, stbl: Box) {
  const d = mdhd.data;
  if (d[0] !== 0) return;
  const ts = u32(d, 12);
  if (ts === 600) return;
  const stts = child(stbl, "stts");
  if (!stts) return;
  const rows = readTable(stts, 2);
  const ok = (n: number) => (n * 600) % ts === 0;
  const ctts = child(stbl, "ctts");
  const cttsRows = ctts ? readTable(ctts, 2) : [];
  if (!rows.every(([, delta]) => ok(delta)) || !cttsRows.every(([, off]) => ok(off))) return;
  const out = d.slice();
  const v = new DataView(out.buffer);
  v.setUint32(12, 600);
  v.setUint32(16, Math.round((u32(d, 16) * 600) / ts));
  mdhd.data = out;
  Object.assign(stts, tableBox("stts", rows.map(([n, delta]) => [n, (delta * 600) / ts])));
  if (ctts) Object.assign(ctts, tableBox("ctts", cttsRows.map(([n, off]) => [n, (off * 600) / ts])));
}

/** Rescales a movie-timescale duration field (u32 at `at` in a v0 box). */
function scaleU32(b: Box, at: number, scale: number) {
  const out = b.data.slice();
  new DataView(out.buffer).setUint32(at, Math.round(u32(out, at) * scale));
  b.data = out;
}

function shiftChunkOffsets(b: Box, delta: number): Box {
  if (b.type === "stco") return tableBox("stco", readTable(b, 1).map(([o]) => [o + delta]));
  return b.children ? { ...b, children: b.children.map((c) => shiftChunkOffsets(c, delta)) } : b;
}

export function applyCameraStyle(input: Uint8Array, encoderTag: string): Uint8Array {
  const file = input.slice();
  const top = parseBoxes(file, 0, file.length);
  const moov = top.find((b) => b.type === "moov");
  const mdat = top.find((b) => b.type === "mdat");
  if (!moov || !mdat) throw new ContainerError("missing moov/mdat");
  const traks = moov.children!.filter((b) => b.type === "trak");
  if (traks.some((t) => path(t, "mdia", "minf", "stbl", "co64"))) {
    throw new ContainerError("64-bit offsets not supported");
  }

  // Movie timescale 600, like iPhone files; durations in movie units follow.
  const mvhd = child(moov, "mvhd")!;
  if (mvhd.data[0] !== 0) throw new ContainerError("mvhd v1 not supported");
  const movieScale = 600 / u32(mvhd.data, 12);
  if (movieScale !== 1) {
    const out = mvhd.data.slice();
    new DataView(out.buffer).setUint32(12, 600);
    mvhd.data = out;
    scaleU32(mvhd, 16, movieScale);
  }

  const movieDuration = u32(mvhd.data, 16);
  for (const t of traks) {
    const kind = handlerOf(t);
    const mdia = child(t, "mdia")!;
    const minf = child(mdia, "minf")!;
    const name = kind === "vide" ? "Core Media Video" : kind === "soun" ? "Core Media Audio" : "";
    mdia.children = mdia.children!.map((c) => (c.type === "hdlr" && name ? qtHandler("mhlr", kind, name) : c));
    // vmhd/smhd, then a data handler, then dinf and stbl.
    const header = minf.children!.filter((c) => c.type === "vmhd" || c.type === "smhd");
    const rest = minf.children!.filter((c) => !["vmhd", "smhd", "hdlr"].includes(c.type));
    minf.children = [...header, qtHandler("dhlr", "url ", "DataHandler"), ...rest];
    const tkhd = child(t, "tkhd");
    if (tkhd && tkhd.data[0] === 0 && movieScale !== 1) scaleU32(tkhd, 20, movieScale);
    const elst = path(t, "edts", "elst");
    if (elst && elst.data[0] === 0 && movieScale !== 1) {
      for (let k = 0; k < u32(elst.data, 4); k++) scaleU32(elst, 8 + 12 * k, movieScale);
    }
    // The video track gets an edit list covering it (in 600 units), as camera files have.
    if (kind === "vide" && !elst) {
      const duration = tkhd && tkhd.data[0] === 0 ? u32(tkhd.data, 20) : movieDuration;
      const edit: Box = { type: "elst", data: u32s(0, 1, duration, 0, 0x00010000) };
      const at = t.children!.findIndex((c) => c.type === "tkhd") + 1;
      t.children!.splice(at, 0, { type: "edts", data: new Uint8Array(), children: [edit] });
    }
    const stbl = path(t, "mdia", "minf", "stbl");
    if (stbl) {
      if (kind === "vide") {
        cameraVisualEntry(child(stbl, "stsd")!);
        mediaTo600(path(t, "mdia", "mdhd")!, stbl);
      }
      if (kind === "soun") cameraAudioEntry(child(stbl, "stsd")!);
      const rank = (b: Box) => (STBL_ORDER.indexOf(b.type) + 100) % 100;
      stbl.children = [...stbl.children!].sort((a, b) => rank(a) - rank(b));
    }
  }

  const ilst = box("ilst", (() => {
    const data = box("data", u32s(1, 0), enc(encoderTag));
    const w = new Writer();
    w.u32(8 + data.length);
    w.bytes(new Uint8Array([0xa9, 0x74, 0x6f, 0x6f])); // ©too
    w.bytes(data);
    return w.done();
  })());
  const meta = fullBox("meta", 0, fullBox("hdlr", 0, u32s(0), enc("mdir"), new Uint8Array(13)), ilst);
  moov.children = moov.children!.filter((b) => b.type !== "udta" && b.type !== "meta");
  moov.children.push({ type: "udta", data: new Uint8Array(), children: [{ type: "meta", data: meta.subarray(8) }] });

  const ftyp = box("ftyp", enc("qt  "), u32s(512), enc("qt  "));
  const free = box("free");
  const oldDataStart = mdat.data.byteOffset - file.byteOffset;
  const moovSize = serialize(moov).length;
  const newDataStart = ftyp.length + moovSize + free.length + 8;
  const moovBytes = serialize(shiftChunkOffsets(moov, newDataStart - oldDataStart));
  if (moovBytes.length !== moovSize) throw new ContainerError("moov size changed");
  const mdatBytes = box("mdat", mdat.data);

  const out = new Uint8Array(ftyp.length + moovBytes.length + free.length + mdatBytes.length);
  let o = 0;
  for (const part of [ftyp, moovBytes, free, mdatBytes]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
