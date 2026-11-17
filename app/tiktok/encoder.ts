// Prepares a video for TikTok in the browser. Two outputs, mirroring what a
// SHANAB MAX output file contains (our own implementation):
//
// - "max": HEVC at a very high quality with the source's resolution, frame rate
//   and timing, in a file laid out like an iPhone camera recording (see
//   container.ts). Sources that are already HEVC (iPhone camera files, HDR) are
//   copied without re-encoding. If this device can't encode HEVC, the original
//   video is copied instead.
// - "light": a smaller re-encoded copy (H.264, at most 1080p / 60 fps). It is a
//   separate option, gets no container rewrite, and is refused if it isn't smaller.
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
  hdr: boolean;
  /** How the video track of a "max" output was made. */
  video: "hevc" | "copy" | "light";
};

export type Job = { promise: Promise<Result>; cancel: () => void };

/** x265 CRF 18 kept SHANAB's sample at ~89% of the source bitrate; use the same ratio. */
const MAX_BITRATE_RATIO = 0.9;
const MIN_MAX_BITRATE = 8_000_000;
const MAX_MAX_BITRATE = 80_000_000;
export const ENCODER_TAG = "TikTok HD";

export class PrepareError extends Error {
  constructor(
    public code: "NOT_ELIGIBLE" | "NO_ENCODER" | "UNDECODABLE" | "NOT_SMALLER" | "INVALID" | "CANCELED",
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
): Job {
  let cancelRequested = false;
  let conversion: { cancel: () => Promise<void> } | null = null;

  const promise = (async (): Promise<Result> => {
    const mb = await import("mediabunny");
    if (mode === "max") {
      const e = maxEligibility(info);
      if (!e.ok) throw new PrepareError("NOT_ELIGIBLE", e.reason);
    } else if (!canMakeLight()) {
      throw new PrepareError("NO_ENCODER");
    }

    // The light copy: H.264 at most 1080p (short side) and 60 fps.
    const scale = Math.min(1, 1080 / Math.min(info.width, info.height));
    const width = mode === "max" ? info.width : even(info.width * scale);
    const height = mode === "max" ? info.height : even(info.height * scale);
    const fps = mode === "max" ? exactFps(info.fps) : Math.min(60, Math.round(info.fps) || 30);

    let codec: "avc" | "hevc" = "avc";
    let quality = new mb.Quality("high");
    let videoPlan: Result["video"] = "light";
    if (mode === "light") {
      const ok = async (c: "avc" | "hevc") => mb.canEncodeVideo(c, { width, height, quality, frameRate: fps });
      if (await ok("avc")) codec = "avc";
      else if (await ok("hevc")) codec = "hevc";
      else throw new PrepareError("NO_ENCODER");
    } else if (info.codec === "hevc") {
      videoPlan = "copy";
    } else {
      // Re-encode to HEVC near the source bitrate, like SHANAB's x265 CRF 18 output.
      const bitrate = Math.min(
        MAX_MAX_BITRATE,
        Math.max(MIN_MAX_BITRATE, Math.round(info.bitrate * MAX_BITRATE_RATIO)),
      );
      quality = new mb.Quality({ bitrate, bitrateMode: "variable" });
      const canHevc =
        canMakeLight() && (await mb.canEncodeVideo("hevc", { width, height, quality, frameRate: fps }));
      videoPlan = canHevc ? "hevc" : "copy";
      codec = "hevc";
    }
    if (videoPlan !== "copy" && !opts.mute && info.hasAudio && !(await mb.canEncodeAudio("aac"))) {
      const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
      registerAacEncoder();
    }
    if (cancelRequested) throw new PrepareError("CANCELED");

    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const target = new mb.BufferTarget();
    const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target });

    try {
      const conv = await mb.Conversion.init({
        input,
        output,
        tracks: "primary",
        video:
          videoPlan === "copy"
            ? {}
            : videoPlan === "hevc"
              ? {
                  // Same size and timestamps as the source; keyframe every 250 frames like x265's default.
                  codec: "hevc",
                  quality,
                  keyFrameInterval: 250 / fps,
                  forceTranscode: true,
                }
              : {
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
    let bytes: Uint8Array<ArrayBuffer> = new Uint8Array(buffer);

    if (mode === "max") {
      const { applyCameraStyle } = await import("./container");
      try {
        bytes = applyCameraStyle(bytes, ENCODER_TAG) as Uint8Array<ArrayBuffer>;
      } catch (e) {
        console.error(e);
      }
    } else if (bytes.length >= file.size) {
      throw new PrepareError("NOT_SMALLER");
    }

    return {
      blob: new Blob([bytes], { type: "video/mp4" }),
      width,
      height,
      fps,
      codec: videoPlan === "copy" ? codecName(info.codec) : codecName(codec),
      hdr: videoPlan === "copy" && info.hdr,
      video: videoPlan,
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

export function formatBytes(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
