// "Decoy" container rewrite for H.264 MP4 files, ported from the open-source
// tiktok-quality tool (MIT). Pixels are untouched: the video track's sample
// tables are extended with "ghost" samples that all point at one 8-byte filler
// NAL unit, so the file declares `multiplier`× as many frames. TikTok's upload
// pipeline then keeps the higher-quality (1080p60) rendition.
// The presentation duration (mvhd/tkhd/mdhd/elst) is left as is.

const PADDING_NAL = new Uint8Array([0, 0, 0, 4, 0, 0, 0, 0]);
const DEFAULT_TAG = "TK8vY5VqBA6hUlo1yuGvNA";
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta"]);

type Box = { type: string; data: Uint8Array; children?: Box[] };

export class DecoyError extends Error {}

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
    if (size < header || p + size > end) throw new DecoyError(`bad box ${type}`);
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

/** Adds the High-profile extension bytes to avcC when the encoder left them out. */
function patchAvcC(stsd: Box) {
  const d = stsd.data;
  const at = (() => {
    for (let i = 8; i + 4 < d.length; i++) if (type4(d, i) === "avcC") return i - 4;
    return -1;
  })();
  if (at < 0) throw new DecoyError("not H.264");
  const size = u32(d, at);
  const c = d.subarray(at + 8, at + size);
  const profile = c[1];
  let p = 5;
  const nSps = c[p++] & 0x1f;
  for (let i = 0; i < nSps; i++) p += 2 + ((c[p] << 8) | c[p + 1]);
  const nPps = c[p++];
  for (let i = 0; i < nPps; i++) p += 2 + ((c[p] << 8) | c[p + 1]);
  const highProfile = [100, 110, 122, 144].includes(profile);
  if (!highProfile || p < c.length) return; // nothing to add, or already present

  const ext = new Uint8Array([0xfd, 0xf8, 0xf8, 0x00]);
  const newAvcC = box("avcC", c, ext);
  // Rebuild stsd -> avc1 with the larger avcC, fixing both enclosing sizes.
  const before = d.subarray(0, at);
  const after = d.subarray(at + size);
  const out = new Uint8Array(before.length + newAvcC.length + after.length);
  out.set(before);
  out.set(newAvcC, before.length);
  out.set(after, before.length + newAvcC.length);
  const entrySize = u32(out, 8); // first (only) sample entry, i.e. avc1
  new DataView(out.buffer).setUint32(8, entrySize + ext.length);
  stsd.data = out;
}

/** Overwrites SEI NAL units in the first sample with same-length filler NALs (offsets stay valid). */
function neutralizeSei(file: Uint8Array, offset: number, size: number) {
  let p = offset;
  const end = offset + size;
  while (p + 4 < end) {
    const len = u32(file, p);
    if (len === 0 || p + 4 + len > end) return;
    const nalType = file[p + 4] & 0x1f;
    if (nalType === 6) {
      file[p + 4] = 0x0c; // filler data NAL
      for (let i = 1; i < len; i++) file[p + 4 + i] = 0xff;
      if (len > 1) file[p + 4 + len - 1] = 0x80;
    }
    p += 4 + len;
  }
}

function udtaComment(tag: string): Box {
  const enc = new TextEncoder().encode(tag);
  const data = box("data", u32s(1, 0), enc);
  const cmt = new Writer();
  cmt.u32(8 + data.length);
  cmt.bytes(new Uint8Array([0xa9, 0x63, 0x6d, 0x74])); // ©cmt
  cmt.bytes(data);
  const hdlr = box("hdlr", u32s(0, 0), new TextEncoder().encode("mdirappl"), new Uint8Array(9));
  const meta = box("meta", u32s(0), hdlr, box("ilst", cmt.done()));
  return { type: "udta", data: new Uint8Array(), children: [{ type: "meta", data: meta.subarray(8) }] };
}

function patchAudio(trak: Box) {
  const mdia = child(trak, "mdia");
  const hdlr = mdia && child(mdia, "hdlr");
  if (hdlr) {
    const name = new TextEncoder().encode("SoundHandler\0");
    const out = new Uint8Array(24 + name.length);
    out.set(hdlr.data.subarray(0, 24));
    out.set(name, 24);
    hdlr.data = out;
  }
  const mdhd = mdia && child(mdia, "mdhd");
  if (mdhd) {
    const langAt = mdhd.data[0] === 1 ? 32 : 20;
    mdhd.data = mdhd.data.slice();
    mdhd.data[langAt] = 0x55; // 'und'
    mdhd.data[langAt + 1] = 0xc4;
  }
}

export type DecoyStats = { realFrames: number; declaredFrames: number };

export function applyDecoy(
  input: Uint8Array,
  multiplier = 10,
): { bytes: Uint8Array; stats: DecoyStats } {
  const file = input.slice();
  const top = parseBoxes(file, 0, file.length);
  const moov = top.find((b) => b.type === "moov");
  const mdatIndex = top.findIndex((b) => b.type === "mdat");
  if (!moov || mdatIndex < 0) throw new DecoyError("missing moov/mdat");
  const moovIndex = top.indexOf(moov);
  if (moovIndex > mdatIndex) throw new DecoyError("moov must precede mdat");

  const traks = moov.children!.filter((b) => b.type === "trak");
  const video = traks.find((t) => handlerOf(t) === "vide");
  if (!video) throw new DecoyError("no video track");
  const vStbl = path(video, "mdia", "minf", "stbl")!;
  if (child(vStbl, "co64") || traks.some((t) => path(t, "mdia", "minf", "stbl", "co64"))) {
    throw new DecoyError("64-bit offsets not supported");
  }

  const stts = child(vStbl, "stts")!;
  const stsz = child(vStbl, "stsz")!;
  const stsc = child(vStbl, "stsc")!;
  const stco = child(vStbl, "stco")!;
  const stsd = child(vStbl, "stsd")!;

  const sizes = readSampleSizes(stsz);
  const sttsRows = readTable(stts, 2);
  const chunkOffsets = readTable(stco, 1).map((r) => r[0]);
  const realFrames = sizes.length;
  const delta = sttsRows[0]?.[1] || 1;
  const pad = realFrames * (multiplier - 1);

  neutralizeSei(file, chunkOffsets[0], sizes[0]);
  patchAvcC(stsd);

  Object.assign(stts, tableBox("stts", [...sttsRows, [pad, delta]]));
  Object.assign(stsz, {
    data: u32s(0, 0, realFrames + pad, ...sizes, ...new Array(pad).fill(PADDING_NAL.length)),
  });
  Object.assign(stsc, tableBox("stsc", [...readTable(stsc, 3), [chunkOffsets.length + 1, 1, 1]]));

  for (const t of traks) if (handlerOf(t) === "soun") patchAudio(t);
  moov.children = moov.children!.filter((b) => b.type !== "udta");
  moov.children.push(udtaComment(DEFAULT_TAG));

  // Layout: ftyp, free, moov, mdat(+padding). Size moov with placeholder offsets first.
  const ftyp = box("ftyp", new TextEncoder().encode("isom"), u32s(512), new TextEncoder().encode("isomiso2avc1mp41"));
  const free = box("free");
  const oldMdat = top[mdatIndex];
  const oldMdatDataStart = oldMdat.data.byteOffset - file.byteOffset;

  Object.assign(stco, tableBox("stco", new Array(chunkOffsets.length + pad).fill([0])));
  const moovSize = serialize(moov).length;
  const newMdatDataStart = ftyp.length + free.length + moovSize + 8;
  const shift = newMdatDataStart - oldMdatDataStart;
  const padOffset = newMdatDataStart + oldMdat.data.length;

  for (const t of traks) {
    const c = path(t, "mdia", "minf", "stbl", "stco")!;
    const offsets = t === video ? chunkOffsets : readTable(c, 1).map((r) => r[0]);
    const shifted = offsets.map((o) => o + shift);
    const rows = t === video ? [...shifted, ...new Array(pad).fill(padOffset)] : shifted;
    Object.assign(c, tableBox("stco", rows.map((o) => [o])));
  }
  const moovBytes = serialize(moov);
  if (moovBytes.length !== moovSize) throw new DecoyError("moov size changed");

  const mdat = box("mdat", oldMdat.data, PADDING_NAL);
  const out = new Uint8Array(ftyp.length + free.length + moovBytes.length + mdat.length);
  let o = 0;
  for (const part of [ftyp, free, moovBytes, mdat]) {
    out.set(part, o);
    o += part.length;
  }
  return { bytes: out, stats: { realFrames, declaredFrames: realFrames + pad } };
}
