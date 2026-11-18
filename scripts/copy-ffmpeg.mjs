// Copies the multi-threaded ffmpeg.wasm core (@ffmpeg/core-mt 0.12.10, GPL) into
// public/ffmpeg/ so the "max quality" engine is served from the site itself
// (see app/tiktok/x265.ts). x265 needs threads, so the single-threaded core
// cannot run it.
//
// Two documented changes are made to the copy, the same kind SHANAB lists for
// its build, so the engine fits in a phone's memory:
//   1. ffmpeg-core.wasm: the shared-memory import minimum is lowered from
//      16384 pages (1 GiB) to 2048 pages (128 MiB); the maximum is unchanged.
//   2. ffmpeg-core.js: the pthread pool size and the memory size are read from
//      "pool" and "mem" query parameters on the core's URL (defaults: 4 workers,
//      like SHANAB, and 1024 MiB), so the page can size both for the device.
// Codec code is unchanged. The upstream package is
// https://registry.npmjs.org/@ffmpeg/core-mt/-/core-mt-0.12.10.tgz
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const src = new URL("../node_modules/@ffmpeg/core-mt/dist/esm/", import.meta.url).pathname;
const dest = new URL("../public/ffmpeg/", import.meta.url).pathname;
mkdirSync(dest, { recursive: true });

// 1. Lower the memory import minimum, keeping the LEB128 field 3 bytes long.
const wasm = readFileSync(join(src, "ffmpeg-core.wasm"));
const leb = (buf, i) => {
  let r = 0, s = 0, b;
  do {
    b = buf[i++];
    r |= (b & 0x7f) << s;
    s += 7;
  } while (b & 0x80);
  return [r >>> 0, i];
};
let patched = false;
for (let p = 8; p < wasm.length && !patched; ) {
  const id = wasm[p];
  const [size, q] = leb(wasm, p + 1);
  if (id === 2) {
    let [n, i] = leb(wasm, q);
    for (let k = 0; k < n && !patched; k++) {
      let len;
      [len, i] = leb(wasm, i);
      i += len;
      [len, i] = leb(wasm, i);
      i += len;
      const kind = wasm[i++];
      if (kind === 0) [, i] = leb(wasm, i);
      else if (kind === 1) {
        i += 1;
        const flags = wasm[i++];
        [, i] = leb(wasm, i);
        if (flags & 1) [, i] = leb(wasm, i);
      } else if (kind === 2) {
        i += 1; // flags (shared, has max)
        const [min, end] = leb(wasm, i);
        if (min !== 16384 || end - i !== 3) throw new Error(`unexpected memory minimum ${min}`);
        wasm.set([0x80, 0x90, 0x00], i); // 2048 pages, padded to 3 bytes
        patched = true;
      } else if (kind === 3) i += 2;
    }
  }
  p = q + size;
}
if (!patched) throw new Error("memory import not found");
writeFileSync(join(dest, "ffmpeg-core.wasm"), wasm);

// 2. Smaller pthread pool; memory size from the core URL's "mem" parameter.
let js = readFileSync(join(src, "ffmpeg-core.js"), "utf8");
const swaps = [
  ["pthreadPoolSize=32", 'pthreadPoolSize=(+new URL(import.meta.url).searchParams.get("pool")||4)'],
  [
    'INITIAL_MEMORY=Module["INITIAL_MEMORY"]||1073741824',
    'INITIAL_MEMORY=Module["INITIAL_MEMORY"]||(+new URL(import.meta.url).searchParams.get("mem")||1024)*1048576',
  ],
];
for (const [from, to] of swaps) {
  if (!js.includes(from)) throw new Error(`pattern not found: ${from}`);
  js = js.replace(from, to);
}
writeFileSync(join(dest, "ffmpeg-core.js"), js);
copyFileSync(join(src, "ffmpeg-core.worker.js"), join(dest, "ffmpeg-core.worker.js"));
console.log("ffmpeg core-mt copied and patched into public/ffmpeg/");
