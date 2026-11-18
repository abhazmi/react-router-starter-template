// Final pass over FFmpeg's QuickTime (mov) output so its layout matches a SHANAB
// MAX file box for box. FFmpeg's mov muxer differs in three places, and the
// SHANAB file shows these instead:
//   - mp4a sample entry: version 0 with esds + chan as direct children
//     (FFmpeg writes version 1 with esds wrapped in a "wave" box);
//   - udta: meta > hdlr "mdir" > ilst > ©too with the encoder name
//     (FFmpeg writes ©swr);
//   - a "free" box before mdat (FFmpeg writes "wide").
// Sample data is untouched; chunk offsets are shifted for the new moov size.

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta"]);

type Box = { type: string; data: Uint8Array; children?: Box[] };

const u32 = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const type4 = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const enc = (s: string) => new TextEncoder().encode(s);

function parse(buf: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(buf, p);
    const type = type4(buf, p + 4);
    let header = 8;
    if (size === 1) {
      size = u32(buf, p + 8) * 2 ** 32 + u32(buf, p + 12);
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) throw new Error(`bad box ${type}`);
    const b: Box = { type, data: buf.subarray(p + header, p + size) };
    if (CONTAINERS.has(type)) b.children = parse(buf, p + header, p + size);
    out.push(b);
    p += size;
  }
  return out;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(8 + len);
  new DataView(out.buffer).setUint32(0, 8 + len);
  out.set(enc(type), 4);
  let o = 8;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

const serialize = (b: Box): Uint8Array =>
  b.children ? box(b.type, ...b.children.map(serialize)) : box(b.type, b.data);

function u32s(...nums: number[]) {
  const out = new Uint8Array(nums.length * 4);
  const v = new DataView(out.buffer);
  nums.forEach((n, i) => v.setUint32(i * 4, n >>> 0));
  return out;
}

const child = (b: Box, t: string) => b.children?.find((c) => c.type === t);

/** QuickTime sound description v1 (+ wave/esds) -> v0 with esds and chan as children. */
function soundEntryV0(stsd: Box) {
  const d = stsd.data;
  const entrySize = u32(d, 8);
  if (type4(d, 12) !== "mp4a") return;
  const e = d.subarray(16, 8 + entrySize); // entry body after its size/type
  const version = (e[8] << 8) | e[9];
  if (version !== 1) return;
  const fixed = e.slice(0, 28);
  fixed[8] = 0; // version 0
  fixed[9] = 0;
  fixed[20] = 0; // compression ID 0 (FFmpeg writes -2 for v1)
  fixed[21] = 0;
  const kids = parse(e, 28 + 16, e.length);
  const wave = kids.find((k) => k.type === "wave");
  const esds = wave ? parse(wave.data, 0, wave.data.length).find((k) => k.type === "esds") : undefined;
  if (!esds) return;
  const others = kids.filter((k) => k.type !== "wave").map(serialize);
  const entry = box("mp4a", fixed, box("esds", esds.data), ...others);
  stsd.data = new Uint8Array([...d.subarray(0, 8), ...entry]);
}

function encoderUdta(tag: string): Box {
  const data = box("data", u32s(1, 0), enc(tag));
  const too = new Uint8Array(8 + data.length);
  new DataView(too.buffer).setUint32(0, too.length);
  too.set([0xa9, 0x74, 0x6f, 0x6f], 4); // ©too
  too.set(data, 8);
  const hdlr = box("hdlr", u32s(0, 0), enc("mdir"), new Uint8Array(13));
  const meta = box("meta", u32s(0), hdlr, box("ilst", too));
  return { type: "udta", data: new Uint8Array(), children: [{ type: "meta", data: meta.subarray(8) }] };
}

function shiftOffsets(b: Box, delta: number): Box {
  if (b.type === "stco" || b.type === "co64") {
    const d = b.data.slice();
    const v = new DataView(d.buffer);
    const n = v.getUint32(4);
    for (let i = 0; i < n; i++) {
      if (b.type === "stco") v.setUint32(8 + i * 4, v.getUint32(8 + i * 4) + delta);
      else v.setBigUint64(8 + i * 8, v.getBigUint64(8 + i * 8) + BigInt(delta));
    }
    return { ...b, data: d };
  }
  return b.children ? { ...b, children: b.children.map((c) => shiftOffsets(c, delta)) } : b;
}

export function finalizeLikeShanab(input: Uint8Array, encoderTag: string): Uint8Array {
  const top = parse(input, 0, input.length);
  const ftyp = top.find((b) => b.type === "ftyp");
  const moov = top.find((b) => b.type === "moov");
  const mdat = top.find((b) => b.type === "mdat");
  if (!ftyp || !moov || !mdat) throw new Error("missing ftyp/moov/mdat");
  if (top.indexOf(moov) > top.indexOf(mdat)) throw new Error("moov must precede mdat");

  for (const t of moov.children!.filter((b) => b.type === "trak")) {
    const stsd = child(child(child(child(t, "mdia")!, "minf")!, "stbl")!, "stsd");
    if (stsd) soundEntryV0(stsd);
  }
  moov.children = moov.children!.filter((b) => b.type !== "udta");
  moov.children.push(encoderUdta(encoderTag));

  const ftypBytes = serialize(ftyp);
  const free = box("free");
  const oldDataStart = mdat.data.byteOffset - input.byteOffset;
  const moovSize = serialize(moov).length;
  const mdatHeader = mdat.data.length + 8 > 0xffffffff ? 16 : 8;
  const newDataStart = ftypBytes.length + moovSize + free.length + mdatHeader;
  const moovBytes = serialize(shiftOffsets(moov, newDataStart - oldDataStart));

  const header = new Uint8Array(mdatHeader);
  const hv = new DataView(header.buffer);
  if (mdatHeader === 8) hv.setUint32(0, 8 + mdat.data.length);
  else {
    hv.setUint32(0, 1);
    hv.setBigUint64(8, BigInt(16 + mdat.data.length));
  }
  header.set(enc("mdat"), 4);

  const out = new Uint8Array(ftypBytes.length + moovBytes.length + free.length + header.length + mdat.data.length);
  let o = 0;
  for (const part of [ftypBytes, moovBytes, free, header, mdat.data]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
