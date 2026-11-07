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

// ---------------------------------------------------------------------------
// "Audio clone" rewrite (Sept 2026 method), ported from the MIT-licensed
// tiktok-lossless-upload tool. The video and audio samples are untouched. The
// audio track is duplicated, and the copy's sample tables declare 10× samples
// (the extra ones are tiny and point at the first audio chunk), plus a set of
// header/metadata changes and trailing padding. Unlike the reference script,
// chunk offsets are shifted for every track, so the file stays playable.

const CODEC_DUMMY_SIZES: Record<string, number> = {
  avc1: 8, avc3: 8, hvc1: 16, hev1: 16, vp09: 4, av01: 4, mp4v: 8,
};
const CLONE_ENCODER = "Lavf59.27.100";
const CLONE_COMMENT = "Patched by Buwryy";
const CLONE_NAME_BOX = "buwryy<3";
const TRAILING_BYTES = 184100;

const enc = (s: string) => new TextEncoder().encode(s);
const zeros = (n: number) => new Uint8Array(n);

function fullBox(type: string, flags: number, ...parts: Uint8Array[]) {
  return box(type, u32s(flags & 0xffffff), ...parts);
}

function hdlrBox(handler: string, name: string) {
  return fullBox("hdlr", 0, zeros(4), enc(handler), zeros(12), enc(name + "\0"));
}

function ilstEntry(tag: number[], value: string) {
  const data = box("data", u32s(1, 0), enc(value));
  const w = new Writer();
  w.u32(8 + data.length);
  w.bytes(new Uint8Array(tag));
  w.bytes(data);
  return w.done();
}

const TAG_TOO = [0xa9, 0x74, 0x6f, 0x6f]; // ©too
const TAG_CMT = [0xa9, 0x63, 0x6d, 0x74]; // ©cmt

function combinedUdta(): Uint8Array {
  const hdlr1 = fullBox("hdlr", 0, zeros(4), enc("mdir"), zeros(12), enc("appl"), zeros(13));
  const ilst1 = box("ilst", ilstEntry(TAG_TOO, CLONE_ENCODER), ilstEntry(TAG_CMT, CLONE_COMMENT));
  const meta1 = fullBox("meta", 375, zeros(4), hdlr1, ilst1);
  const hdlr2 = fullBox("hdlr", 0, zeros(4), enc("mdir"), zeros(12), zeros(13));
  const ilst2 = box("ilst", ilstEntry(TAG_CMT, CLONE_COMMENT));
  const meta2 = fullBox("meta", 0, zeros(4), hdlr2, box("name", enc(CLONE_NAME_BOX)), ilst2);
  return box("udta", meta1, meta2);
}

/** mvhd v1 with unknown duration and next_track_ID 5, laid out exactly like the reference. */
function mvhdV1(old: Box): Uint8Array {
  const timescale = old.data[0] === 0 ? u32(old.data, 12) : u32(old.data, 20);
  const body = new Uint8Array(112);
  const v = new DataView(body.buffer);
  body[0] = 1;
  v.setUint32(20, timescale);
  v.setUint32(24, 0xffffffff);
  v.setUint32(28, 0xffffffff);
  v.setUint32(32, 0x00010000);
  v.setUint16(36, 0x0100);
  v.setUint32(44, 0x00010000);
  v.setUint32(60, 0x00010000);
  v.setUint32(76, 0x40000000);
  v.setUint32(108, 5);
  return box("mvhd", body);
}

function zeroTimes(data: Uint8Array, trackId?: number): Uint8Array {
  const d = data.slice();
  const dv = new DataView(d.buffer);
  const v1 = d[0] === 1;
  d.fill(0, 4, v1 ? 20 : 12); // creation + modification time
  if (trackId !== undefined) dv.setUint32(v1 ? 20 : 12, trackId);
  return d;
}

function elstPlusOne(edts: Box): Box {
  const elst = child(edts, "elst");
  if (!elst || u32(elst.data, 4) === 0) return edts;
  const d = elst.data.slice();
  const at = d[0] === 1 ? 12 : 8; // low 32 bits of the first segment_duration
  new DataView(d.buffer).setUint32(at, u32(d, at) + 1);
  return { ...edts, children: edts.children!.map((c) => (c === elst ? { ...elst, data: d } : c)) };
}

function inflateClone(stbl: Box, multiplier: number, dummySize: number): Box {
  const get = (t: string) => child(stbl, t);
  const stsz = get("stsz"), stts = get("stts"), stsc = get("stsc"), stco = get("stco");
  if (!stsz || !stts || !stsc || !stco) return stbl;

  const sizes = readSampleSizes(stsz);
  const real = sizes.length;
  const extra = real * (multiplier - 1);
  let chunks = readTable(stco, 1).map((r) => r[0]);
  let stscRows = readTable(stsc, 3);
  const lastSdi = stscRows.at(-1)?.[2] ?? 1;
  const total = stscRows.reduce((n, [fc, spc], i) => {
    const next = stscRows[i + 1]?.[0] ?? chunks.length + 1;
    return n + Math.max(0, next - fc) * spc;
  }, 0);
  if (!stscRows.length || total !== real) {
    stscRows = [[1, real, lastSdi]];
    chunks = [chunks[0]];
  }

  const rows = {
    stsz: { type: "stsz", data: u32s(0, 0, real + extra, ...sizes, ...new Array(extra).fill(dummySize)) },
    stts: tableBox("stts", [...readTable(stts, 2), [extra, 1]]),
    stsc: tableBox("stsc", [...stscRows, [chunks.length + 1, extra, lastSdi]]),
    stco: tableBox("stco", [...chunks, chunks[0]].map((o) => [o])),
  } as Record<string, Box>;
  return { ...stbl, children: stbl.children!.map((c) => rows[c.type] ?? c) };
}

function rebuildTrak(trak: Box, kind: "vide" | "soun" | "other", trackId: number, clone: boolean,
  multiplier: number, dummySize: number): Box {
  const out: Box[] = [];
  for (const c of trak.children!) {
    if (c.type === "tkhd") out.push({ type: "tkhd", data: zeroTimes(c.data, trackId) });
    else if (c.type === "tref" || c.type === "edts") {
      if (clone) continue;
      out.push(c.type === "edts" && kind === "vide" ? elstPlusOne(c) : c);
    } else if (c.type === "mdia") {
      const mdia: Box[] = [];
      for (const m of c.children!) {
        if (m.type === "mdhd") mdia.push({ type: "mdhd", data: zeroTimes(m.data) });
        else if (m.type === "hdlr") {
          const h = kind === "vide" ? hdlrBox("vide", "VideoHandler")
            : kind === "soun" ? hdlrBox("soun", "SoundHandler") : hdlrBox("vide", "");
          mdia.push({ type: "hdlr", data: h.subarray(8) });
        } else if (m.type === "minf") {
          const minf = m.children!
            .filter((x) => x.type !== "nmhd")
            .map((x) => (x.type === "stbl" && clone ? inflateClone(x, multiplier, dummySize) : x));
          mdia.push({ ...m, children: minf });
        } else mdia.push(m);
      }
      out.push({ ...c, children: mdia });
    } else out.push(c);
  }
  return { ...trak, children: out };
}

function shiftOffsets(b: Box, delta: number): Box {
  if (b.type === "stco") {
    const rows = readTable(b, 1).map(([o]) => [o > 0 ? o + delta : o]);
    return tableBox("stco", rows);
  }
  return b.children ? { ...b, children: b.children.map((c) => shiftOffsets(c, delta)) } : b;
}

/** Zeroes the 4 bytes at offset 28 of each mp4a sample entry, as the reference does. */
function zeroMp4a(file: Uint8Array, start: number, end: number) {
  let p = start;
  while (p + 8 <= end) {
    const size = u32(file, p);
    if (size < 8 || p + size > end) return;
    const t = type4(file, p + 4);
    if (t === "mp4a" && size >= 36) file.fill(0, p + 28, p + 32);
    else if (["moov", "trak", "mdia", "minf", "stbl"].includes(t)) zeroMp4a(file, p + 8, p + size);
    else if (t === "stsd") zeroMp4a(file, p + 16, p + size);
    p += size;
  }
}

export type CloneStats = { realAudioSamples: number; declaredAudioSamples: number };

export function applyAudioClone(
  input: Uint8Array,
  multiplier = 10,
): { bytes: Uint8Array; stats: CloneStats } {
  const file = input.slice();
  const top = parseBoxes(file, 0, file.length);
  const ftyp = top.find((b) => b.type === "ftyp");
  const moov = top.find((b) => b.type === "moov");
  const mdat = top.find((b) => b.type === "mdat");
  if (!moov || !mdat) throw new DecoyError("missing moov/mdat");
  const traks = moov.children!.filter((b) => b.type === "trak");
  if (traks.some((t) => path(t, "mdia", "minf", "stbl", "co64"))) {
    throw new DecoyError("64-bit offsets not supported");
  }
  const video = traks.find((t) => handlerOf(t) === "vide");
  const audio = traks.find((t) => handlerOf(t) === "soun");
  if (!video) throw new DecoyError("no video track");
  if (!audio) throw new DecoyError("no audio track");

  const entry = path(video, "mdia", "minf", "stbl", "stsd");
  const codec = entry && entry.data.length >= 16 ? type4(entry.data, 12) : "avc1";
  const dummySize = CODEC_DUMMY_SIZES[codec] ?? 8;
  const audioStsz = path(audio, "mdia", "minf", "stbl", "stsz")!;
  const realAudio = readSampleSizes(audioStsz).length;

  const children: Box[] = [];
  for (const c of moov.children!) {
    if (c.type === "mvhd") children.push({ type: "mvhd", data: mvhdV1(c).subarray(8) });
    else if (c === video) children.push(rebuildTrak(c, "vide", 1, false, multiplier, dummySize));
    else if (c === audio) {
      children.push(rebuildTrak(c, "soun", 2, false, multiplier, dummySize));
      children.push(rebuildTrak(c, "soun", 4, true, multiplier, dummySize));
    } else if (c.type === "trak") children.push(rebuildTrak(c, "other", 3, false, multiplier, dummySize));
    else if (c.type !== "udta") children.push(c);
  }
  children.push({ type: "udta", data: new Uint8Array(), children: parseBoxes(combinedUdta(), 8, combinedUdta().length) });

  const ftypBytes = ftyp ? serialize(ftyp) : new Uint8Array();
  let newMoov: Box = { type: "moov", data: new Uint8Array(), children };
  const moovSize = serialize(newMoov).length;
  const oldDataStart = mdat.data.byteOffset - file.byteOffset;
  const newDataStart = ftypBytes.length + moovSize + 8;
  newMoov = shiftOffsets(newMoov, newDataStart - oldDataStart);
  const moovBytes = serialize(newMoov);
  if (moovBytes.length !== moovSize) throw new DecoyError("moov size changed");

  const mdatBytes = box("mdat", mdat.data);
  const trailing = new Uint8Array(TRAILING_BYTES - (TRAILING_BYTES - 8) % 4);
  trailing.set([0, 0, 0, 4, 0x56, 0x4f, 0x49, 0x44]); // size-4 "VOID" box
  for (let i = 8; i < trailing.length; i += 4) trailing[i + 3] = 4;

  const out = new Uint8Array(ftypBytes.length + moovBytes.length + mdatBytes.length + trailing.length);
  let o = 0;
  for (const part of [ftypBytes, moovBytes, mdatBytes, trailing]) {
    out.set(part, o);
    o += part.length;
  }
  zeroMp4a(out, ftypBytes.length, ftypBytes.length + moovBytes.length);
  return { bytes: out, stats: { realAudioSamples: realAudio, declaredAudioSamples: realAudio * multiplier } };
}
