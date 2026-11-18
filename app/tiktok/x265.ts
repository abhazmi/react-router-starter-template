// "Max quality" output: the same FFmpeg command a SHANAB MAX file was made with,
// read from the x265 settings embedded in that file and its container layout:
//
//   ffmpeg -i in -c:v libx265 -preset fast -tune zerolatency -crf 18 -tag:v hvc1
//          -c:a copy -movflags +faststart -f mov out.mp4
//
// It runs in the browser with ffmpeg.wasm's multi-threaded core. SHANAB's file
// shows x265 on one thread (pools=none, frame-threads=1, no WPP); here x265 gets
// a thread pool with WPP and two frame threads sized to the device's cores. On a
// 1080p60 test clip that was 4x faster for a 0.4% larger file (same CRF 18). The mov muxer produces the
// QuickTime layout iPhone files have ('qt  ' brand, Core Media handler names
// copied from the source, fiel/nclc colr boxes).
//
// The core needs SharedArrayBuffer, so the page must be cross-origin isolated
// (COOP/COEP headers). Core files are served from /ffmpeg/; see
// scripts/copy-ffmpeg.mjs for the memory/thread changes made to them.

export const FFMPEG_BASE = "/ffmpeg/";
export const ENCODER_TAG = "TikTok HD";

export type X265Job = {
  promise: Promise<Uint8Array>;
  cancel: () => void;
};

export class X265Error extends Error {
  constructor(
    public code: "NOT_ISOLATED" | "NO_MEMORY" | "TOO_BIG" | "LOAD" | "FAILED" | "CANCELED",
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Largest shared memory (MiB) this device lets us allocate, from 1 GiB down. */
function pickMemoryMiB(): number | null {
  for (const mib of [1024, 768, 512, 384, 256]) {
    try {
      const pages = mib * 16;
      new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
      return mib;
    } catch {
      // try a smaller size
    }
  }
  return null;
}

/** Working memory for decoding + x265 at 1080p, on top of the output kept in memory. */
const WORK_MIB = 280;

/** x265 worker threads (WPP), 2 frame threads, 2 decoder threads, plus spare pthreads. */
function threadPlan() {
  const cores = Math.max(2, Math.min(8, navigator.hardwareConcurrency || 4));
  const x265Pool = cores;
  const frameThreads = 2;
  const decodeThreads = 2;
  // The pthread pool must cover every thread up front: a thread created later
  // deadlocks, because the core's main thread is busy encoding.
  return { x265Pool, frameThreads, decodeThreads, pthreads: x265Pool + frameThreads + decodeThreads + 4 };
}

const TIME_RE = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;

export function encodeX265(
  file: File,
  opts: { mute: boolean; duration: number; expectedBytes: number },
  onProgress: (p: number) => void,
  onStage: (stage: "loading" | "encoding") => void,
): X265Job {
  let canceled = false;
  let ffmpegRef: { terminate: () => void } | null = null;

  const promise = (async () => {
    if (typeof SharedArrayBuffer === "undefined" || !globalThis.crossOriginIsolated) {
      throw new X265Error("NOT_ISOLATED");
    }
    const mib = pickMemoryMiB();
    if (!mib) throw new X265Error("NO_MEMORY");
    // The output stays in WASM memory until it is read back.
    if (opts.expectedBytes / 1048576 + WORK_MIB > mib) {
      throw new X265Error("TOO_BIG", String(mib));
    }

    const threads = threadPlan();
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const ffmpeg = new FFmpeg();
    ffmpegRef = ffmpeg;
    onStage("loading");
    try {
      const base = new URL(FFMPEG_BASE, location.href).href;
      await ffmpeg.load({
        coreURL: `${base}ffmpeg-core.js?mem=${mib}&pool=${threads.pthreads}`,
        wasmURL: `${base}ffmpeg-core.wasm`,
        workerURL: `${base}ffmpeg-core.worker.js`,
      });
    } catch (e) {
      if (canceled) throw new X265Error("CANCELED");
      throw new X265Error("LOAD", String(e));
    }
    if (canceled) throw new X265Error("CANCELED");

    // Read the file in place instead of copying it into WASM memory.
    await ffmpeg.createDir("/in");
    await ffmpeg.mount("WORKERFS" as never, { files: [file] }, "/in");
    const input = `/in/${file.name}`;

    ffmpeg.on("log", ({ message }) => {
      const m = TIME_RE.exec(message);
      if (m && opts.duration > 0) {
        const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        onProgress(Math.min(0.99, t / opts.duration));
      }
    });

    onStage("encoding");
    const code = await ffmpeg.exec([
      "-threads", String(threads.decodeThreads),
      "-filter_threads", "1",
      "-i", input,
      "-map", "0:v:0",
      ...(opts.mute ? ["-an"] : ["-map", "0:a:0?", "-c:a", "copy"]),
      "-c:v", "libx265",
      "-preset", "fast",
      "-tune", "zerolatency",
      "-crf", "18",
      "-x265-params",
      `pools=${threads.x265Pool}:frame-threads=${threads.frameThreads}:wpp=1:log-level=0`,
      "-tag:v", "hvc1",
      // Keep per-stream metadata (e.g. "Core Media Video" handler names), drop the rest.
      "-map_metadata:g", "-1",
      "-metadata", `encoder=${ENCODER_TAG}`,
      // iPhone and SHANAB files use a 600 timescale for the movie and the video track.
      "-video_track_timescale", "600",
      "-movie_timescale", "600",
      "-movflags", "+faststart",
      "-f", "mov",
      "out.mp4",
    ]);
    if (canceled) throw new X265Error("CANCELED");
    if (code !== 0) throw new X265Error("FAILED", `ffmpeg exited with ${code}`);

    const raw = (await ffmpeg.readFile("out.mp4")) as Uint8Array;
    await ffmpeg.deleteFile("out.mp4").catch(() => {});
    await ffmpeg.unmount("/in").catch(() => {});
    ffmpeg.terminate();
    // Same final layout as SHANAB's files (audio entry, encoder tag, free box).
    const { finalizeLikeShanab } = await import("./finalize");
    let data = raw;
    try {
      data = finalizeLikeShanab(raw, ENCODER_TAG);
    } catch (e) {
      console.error(e);
    }
    onProgress(1);
    return data;
  })();

  return {
    promise: promise.catch((e) => {
      if (canceled) throw new X265Error("CANCELED");
      throw e;
    }),
    cancel: () => {
      canceled = true;
      ffmpegRef?.terminate();
    },
  };
}
