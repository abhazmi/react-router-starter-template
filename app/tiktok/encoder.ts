// Prepares a video for TikTok in the browser. Two outputs:
//
// - "max": the FFmpeg + x265 CRF 18 command SHANAB MAX files are made with
//   (see x265.ts). Slow, since x265 runs in WebAssembly, but high quality.
// - "light": a smaller re-encoded copy (H.264, at most 1080p / 60 fps). It is a
//   separate option, and is refused if it isn't smaller.
//
// Nothing is uploaded anywhere; all work happens on the device.

export type VideoInfo = {
  duration: number;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  codec: string | null;
  hdr: boolean;
  hasAudio: boolean;
  size: number;
};

export type Mode = "max" | "light";

export type Eligibility = { ok: true } | { ok: false; reason: string };

const CODEC_NAMES: Record<string, string> = { avc: "H.264", hevc: "HEVC", vp9: "VP9", av1: "AV1" };
export const codecName = (c: string | null) => (c ? (CODEC_NAMES[c] ?? c) : "؟");

export async function readVideoInfo(file: File): Promise<VideoInfo> {
  const { Input, BlobSource, ALL_FORMATS } = await import("mediabunny");
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error("NO_VIDEO_TRACK");
    const audio = await input.getPrimaryAudioTrack();
    const [duration, width, height, stats, hdr] = await Promise.all([
      input.computeDuration(),
      video.getDisplayWidth(),
      video.getDisplayHeight(),
      video.computePacketStats(120),
      video.hasHighDynamicRange().catch(() => false),
    ]);
    return {
      duration,
      width,
      height,
      fps: stats.averagePacketRate,
      bitrate: stats.averageBitrate,
      codec: video.codec,
      hdr,
      hasAudio: audio !== null,
      size: file.size,
    };
  } finally {
    input.dispose();
  }
}

/** Whether the max-quality output can be made from this source. */
export function maxEligibility(info: VideoInfo): Eligibility {
  const long = Math.max(info.width, info.height);
  const short = Math.min(info.width, info.height);
  if (long > 3840 || short > 2160) return { ok: false, reason: "الدقة أعلى من 4K. جرّب «نسخة أخف»." };
  if (info.fps > 61) return { ok: false, reason: `المقطع ${Math.round(info.fps)} فريم، والحد 60. جرّب «نسخة أخف».` };
  if (info.duration > 600) return { ok: false, reason: "المقطع أطول من 10 دقائق. قصّه وجرّب مرة ثانية." };
  return { ok: true };
}

/** Whether this browser can make the re-encoded copy. */
export function canMakeLight() {
  return typeof window !== "undefined" && "VideoEncoder" in window && "VideoDecoder" in window;
}

/** Turns 59.94 / 29.97-style rates into their exact NTSC values, as the 7-u8 patch does. */
export function exactFps(fps: number) {
  for (const base of [24, 30, 48, 60, 90, 120, 144, 240]) {
    const ntsc = (base * 1000) / 1001;
    if (Math.abs(fps - ntsc) < 0.01) return ntsc;
    if (Math.abs(fps - base) < 0.01) return base;
  }
  return fps;
}

export type Result = {
  blob: Blob;
  width: number;
  height: number;
  fps: number;
  codec: string;
  /** How the video was made: x265 in WebAssembly, or the lighter WebCodecs copy. */
  video: "x265" | "light";
};

export type Job = { promise: Promise<Result>; cancel: () => void };

export type Phase = "loading" | "encoding";

export class PrepareError extends Error {
  constructor(
    public code:
      | "NOT_ELIGIBLE"
      | "NO_ENCODER"
      | "ENGINE_LOAD"
      | "TOO_BIG"
      | "UNDECODABLE"
      | "NOT_SMALLER"
      | "INVALID"
      | "CANCELED",
    message?: string,
  ) {
    super(message ?? code);
  }
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function prepareForTikTok(
  file: File,
  info: VideoInfo,
  mode: Mode,
  opts: { mute: boolean },
  onProgress: (p: number) => void,
  onPhase: (p: Phase) => void = () => {},
): Job {
  if (mode === "max") return prepareMax(file, info, opts, onProgress, onPhase);

  let cancelRequested = false;
  let conversion: { cancel: () => Promise<void> } | null = null;

  const promise = (async (): Promise<Result> => {
    const mb = await import("mediabunny");
    if (!canMakeLight()) throw new PrepareError("NO_ENCODER");

    // The light copy: H.264 at most 1080p (short side) and 60 fps.
    const scale = Math.min(1, 1080 / Math.min(info.width, info.height));
    const width = even(info.width * scale);
    const height = even(info.height * scale);
    const fps = Math.min(60, Math.round(info.fps) || 30);
    const quality = new mb.Quality("high");
    const ok = async (c: "avc" | "hevc") => mb.canEncodeVideo(c, { width, height, quality, frameRate: fps });
    let codec: "avc" | "hevc";
    if (await ok("avc")) codec = "avc";
    else if (await ok("hevc")) codec = "hevc";
    else throw new PrepareError("NO_ENCODER");
    if (!opts.mute && info.hasAudio && !(await mb.canEncodeAudio("aac"))) {
      const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
      registerAacEncoder();
    }
    if (cancelRequested) throw new PrepareError("CANCELED");
    onPhase("encoding");

    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target });
    try {
      const conv = await mb.Conversion.init({
        input,
        output,
        tracks: "primary",
        video: {
          width,
          height,
          fit: "contain",
          frameRate: fps,
          codec,
          quality,
          forceTranscode: true,
          allowTransformationMetadata: false,
        },
        // AAC (what phones record) is copied; anything else becomes AAC.
        audio: opts.mute ? { discard: true } : { codec: "aac" },
        tags: {},
        showWarnings: false,
      });
      conversion = conv;
      if (!conv.isValid) {
        const reasons = conv.discardedTracks.map((t) => t.reason);
        throw new PrepareError(
          reasons.some((r) => r.startsWith("undecodable")) ? "UNDECODABLE" : "INVALID",
          reasons.join(", "),
        );
      }
      if (cancelRequested) {
        await conv.cancel();
        throw new PrepareError("CANCELED");
      }
      conv.onProgress = (p) => onProgress(p);
      await conv.execute();
    } catch (e) {
      if (e instanceof mb.ConversionCanceledError || cancelRequested) throw new PrepareError("CANCELED");
      throw e;
    } finally {
      input.dispose();
    }

    const buffer = target.buffer;
    if (!buffer) throw new PrepareError("INVALID", "empty output");
    if (buffer.byteLength >= file.size) throw new PrepareError("NOT_SMALLER");
    return {
      blob: new Blob([buffer], { type: "video/mp4" }),
      width,
      height,
      fps,
      codec: CODEC_NAMES[codec],
      video: "light",
    };
  })();

  return {
    promise,
    cancel: () => {
      cancelRequested = true;
      void conversion?.cancel();
    },
  };
}

function prepareMax(
  file: File,
  info: VideoInfo,
  opts: { mute: boolean },
  onProgress: (p: number) => void,
  onPhase: (p: Phase) => void,
): Job {
  const e = maxEligibility(info);
  if (!e.ok) {
    return { promise: Promise.reject(new PrepareError("NOT_ELIGIBLE", e.reason)), cancel: () => {} };
  }
  let inner: { cancel: () => void } | null = null;
  let canceled = false;
  const promise = (async (): Promise<Result> => {
    const { encodeX265, X265Error } = await import("./x265");
    if (canceled) throw new PrepareError("CANCELED");
    const job = encodeX265(
      file,
      { mute: opts.mute, duration: info.duration, expectedBytes: info.size },
      onProgress,
      onPhase,
    );
    inner = job;
    try {
      const bytes = await job.promise;
      return {
        blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "video/mp4" }),
        width: info.width,
        height: info.height,
        fps: exactFps(info.fps),
        codec: "HEVC (x265)",
        video: "x265",
      };
    } catch (err) {
      if (err instanceof X265Error) {
        if (err.code === "CANCELED") throw new PrepareError("CANCELED");
        if (err.code === "LOAD") throw new PrepareError("ENGINE_LOAD", err.message);
        if (err.code === "NOT_ISOLATED" || err.code === "NO_MEMORY") throw new PrepareError("ENGINE_LOAD", err.code);
        if (err.code === "TOO_BIG") throw new PrepareError("TOO_BIG", err.message);
      }
      throw new PrepareError("INVALID", String(err));
    }
  })();
  return {
    promise,
    cancel: () => {
      canceled = true;
      inner?.cancel();
    },
  };
}

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
