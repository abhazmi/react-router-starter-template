// Re-encodes a video in the browser (WebCodecs via mediabunny) with settings
// that survive TikTok's own re-compression as well as possible:
// 9:16-friendly resolution, constant frame rate, H.264 at a high bitrate, AAC audio.
// Nothing is uploaded anywhere; all work happens on the device.

export type PresetId = "original" | "1080p" | "2k" | "4k";

export type Preset = {
  id: PresetId;
  label: string;
  hint: string;
  /** Long side / short side of the output, before aspect-ratio fitting. */
  long: number;
  short: number;
  /** Video bitrate at 30 fps, in bits per second. Scaled up for higher frame rates. */
  bitrate30: number;
};

export const PRESETS: Preset[] = [
  {
    // Like SHANAB MAX: no re-encode, so resolution (up to 4K), frame rate and HDR stay as recorded.
    id: "original",
    label: "الأصلي بدون إعادة ترميز",
    hint: "يحافظ على دقة المقطع وفريماته وألوان HDR مثل ما صوّرته، وهي نفس فكرة شنب. أسرع خيار.",
    long: 0,
    short: 0,
    bitrate30: 0,
  },
  {
    id: "1080p",
    label: "Full HD 1080p",
    hint: "الأنسب لأغلب الفيديوهات وأسرع تحويل",
    long: 1920,
    short: 1080,
    bitrate30: 25_000_000,
  },
  {
    id: "2k",
    label: "2K 1440p",
    hint: "تفاصيل أوضح، حجم أكبر",
    long: 2560,
    short: 1440,
    bitrate30: 40_000_000,
  },
  {
    id: "4k",
    label: "4K 2160p",
    hint: "أعلى جودة، يحتاج جوال قوي ووقت أطول",
    long: 3840,
    short: 2160,
    bitrate30: 60_000_000,
  },
];

export const AUDIO_BITRATE = 320_000;

export type VideoInfo = {
  duration: number;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  codec: string | null;
  hdr: boolean;
  hasAudio: boolean;
};

export function isSupportedBrowser() {
  return (
    typeof window !== "undefined" &&
    "VideoEncoder" in window &&
    "VideoDecoder" in window
  );
}

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
    };
  } finally {
    input.dispose();
  }
}

/** Snaps a measured (possibly variable) frame rate to the nearest standard one, capped at 60. */
export function targetFrameRate(fps: number) {
  const standard = [24, 25, 30, 50, 60];
  const capped = Math.min(Number.isFinite(fps) && fps > 0 ? fps : 30, 60);
  return standard.reduce((best, f) =>
    Math.abs(f - capped) < Math.abs(best - capped) ? f : best,
  );
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Fits the source aspect ratio inside the preset's box (portrait or landscape to match the source). */
export function targetSize(info: Pick<VideoInfo, "width" | "height">, preset: Preset) {
  const portrait = info.height >= info.width;
  const boxW = portrait ? preset.short : preset.long;
  const boxH = portrait ? preset.long : preset.short;
  const scale = Math.min(boxW / info.width, boxH / info.height);
  return { width: even(info.width * scale), height: even(info.height * scale) };
}

/** Constant bitrate used by the 7-u8 toolkit's upload spec (1080p H.264, 50 Mbps CBR). */
export const CBR_BITRATE = 50_000_000;

export function targetBitrate(preset: Preset, fps: number, cbr = false) {
  const vbr = Math.round(preset.bitrate30 * (fps > 30 ? 1.5 : 1));
  return cbr ? Math.max(vbr, CBR_BITRATE) : vbr;
}

export type Method = "timescale" | "silent" | "audio" | "frames" | "none";

export type EncodeOptions = {
  /** Output 60 fps even when the source is slower (frames are repeated). */
  fps60: boolean;
  /** Encode at a constant 50 Mbps (or the preset's rate, if higher) instead of variable bitrate. */
  cbr: boolean;
  /**
   * Container rewrite applied after encoding (all of them force H.264):
   * "timescale" = mvhd/mdhd timing scaled to 30 fps ("120 FPS method", Oct 2026),
   * "silent" = interleave + fake samples outside stts (Silent Method, Nov 2026),
   * "audio" = duplicated audio track with inflated sample tables (Sept 2026),
   * "frames" = ghost video frames (older method), "none" = plain file.
   */
  method: Method;
};

export function outputFrameRate(info: Pick<VideoInfo, "fps">, opts: Pick<EncodeOptions, "fps60">) {
  return opts.fps60 ? 60 : targetFrameRate(info.fps);
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

export function estimateBytes(
  info: VideoInfo,
  preset: Preset,
  opts: Pick<EncodeOptions, "fps60" | "cbr">,
) {
  if (preset.id === "original") return info.bitrate * info.duration / 8;
  const fps = outputFrameRate(info, opts);
  const audio = info.hasAudio ? AUDIO_BITRATE : 0;
  return ((targetBitrate(preset, fps, opts.cbr) + audio) * info.duration) / 8;
}

const CODEC_NAMES: Record<string, string> = { avc: "H.264", hevc: "HEVC", vp9: "VP9", av1: "AV1" };

export type EncodeResult = {
  blob: Blob;
  width: number;
  height: number;
  fps: number;
  codec: string;
  /** The rewrite that was actually applied. */
  applied: Method;
  /** Whether the 50 Mbps constant bitrate was used (false when the device fell back to VBR). */
  cbr: boolean;
  /** True when a rewrite was requested but couldn't be applied to this file. */
  rewriteFailed: boolean;
};

export type EncodeJob = {
  promise: Promise<EncodeResult>;
  cancel: () => void;
};

export class EncodeError extends Error {
  constructor(
    public code: "UNSUPPORTED_SIZE" | "NO_H264" | "UNDECODABLE" | "INVALID" | "CANCELED",
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function encodeForTikTok(
  file: File,
  info: VideoInfo,
  preset: Preset,
  opts: EncodeOptions,
  onProgress: (p: number) => void,
): EncodeJob {
  let cancelRequested = false;
  let conversion: { cancel: () => Promise<void> } | null = null;

  const promise = (async (): Promise<EncodeResult> => {
    const mb = await import("mediabunny");
    // Some browsers (e.g. older Safari) can't encode AAC natively; use the WASM encoder there.
    if (info.hasAudio && !(await mb.canEncodeAudio("aac"))) {
      const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
      registerAacEncoder();
    }
    const original = preset.id === "original";
    const { width, height } = original ? info : targetSize(info, preset);
    const fps = original ? exactFps(info.fps) : outputFrameRate(info, opts);
    let codec: "avc" | "hevc" | "vp9" | null = null;
    let quality: InstanceType<typeof mb.Quality> | null = null;
    let usedCbr = false;
    if (!original) {
      // Prefer the requested rate control; if the device can't do 50 Mbps CBR, use the preset VBR.
      const qualities = [
        ...(opts.cbr
          ? [new mb.Quality({ bitrate: targetBitrate(preset, fps, true), bitrateMode: "constant" })]
          : []),
        new mb.Quality({ bitrate: targetBitrate(preset, fps), bitrateMode: "variable" }),
      ];

      // H.264 is what TikTok handles best; fall back to HEVC, then VP9, if the device can't do it at this size.
      // The container rewrites only work on H.264.
      search: for (const q of qualities) {
        for (const c of opts.method !== "none" ? (["avc"] as const) : (["avc", "hevc", "vp9"] as const)) {
          if (await mb.canEncodeVideo(c, { width, height, quality: q, frameRate: fps })) {
            codec = c;
            quality = q;
            break search;
          }
        }
      }
      usedCbr = opts.cbr && quality === qualities[0];
      if (!codec) throw new EncodeError(opts.method !== "none" ? "NO_H264" : "UNSUPPORTED_SIZE");
    }
    if (cancelRequested) throw new EncodeError("CANCELED");

    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    const target = new mb.BufferTarget();
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }),
      target,
    });

    try {
      const conv = await mb.Conversion.init({
        input,
        output,
        tracks: "primary",
        // "original" copies the encoded video as is (only the container changes to MP4).
        video: original
          ? {}
          : {
              width,
              height,
              fit: "contain",
              frameRate: fps,
              codec: codec!,
              quality: quality!,
              // Long GOP like the reference tool (keyframes roughly every 9 s).
              keyFrameInterval: opts.method === "audio" ? 9.1 : 2,
              forceTranscode: true,
              // Bake rotation into the pixels so every app shows it upright.
              allowTransformationMetadata: false,
            },
        // AAC sources (almost every phone video) are copied untouched; anything else becomes AAC.
        audio: { codec: "aac", quality: new mb.Quality({ bitrate: AUDIO_BITRATE }) },
        tags: {},
        showWarnings: false,
      });
      conversion = conv;
      if (!conv.isValid) {
        const reasons = conv.discardedTracks.map((t) => t.reason);
        throw new EncodeError(
          reasons.some((r) => r.startsWith("undecodable")) ? "UNDECODABLE" : "INVALID",
          reasons.join(", "),
        );
      }
      if (cancelRequested) {
        await conv.cancel();
        throw new EncodeError("CANCELED");
      }
      conv.onProgress = (p) => onProgress(p);
      await conv.execute();
    } catch (e) {
      if (e instanceof mb.ConversionCanceledError || cancelRequested) {
        throw new EncodeError("CANCELED");
      }
      throw e;
    } finally {
      input.dispose();
    }

    const buffer = target.buffer;
    if (!buffer) throw new EncodeError("INVALID", "empty output");

    let bytes: Uint8Array<ArrayBuffer> = new Uint8Array(buffer);
    let applied: EncodeResult["applied"] = "none";
    let rewriteFailed = false;
    // Each rewrite has a precondition; when it isn't met, use the closest one that applies.
    let method = opts.method;
    if (method === "timescale" && fps <= 30) method = "silent";
    if (method === "audio" && !info.hasAudio) method = "frames";
    // Ghost frames patch avcC, so they need H.264; other sources get the Silent Method instead.
    if (method === "frames" && original && info.codec !== "avc") method = "silent";
    if (method !== "none") {
      const m = await import("./decoy");
      try {
        const r =
          method === "timescale" ? m.applyTimescale(bytes, fps, 30)
          : method === "silent" ? m.applySilent(bytes)
          : method === "audio" ? m.applyAudioClone(bytes)
          : m.applyDecoy(bytes);
        bytes = r.bytes as Uint8Array<ArrayBuffer>;
        applied = method;
      } catch (e) {
        console.error(e);
        rewriteFailed = true;
      }
    }

    return {
      applied,
      rewriteFailed,
      cbr: usedCbr,
      blob: new Blob([bytes], { type: "video/mp4" }),
      width,
      height,
      fps,
      codec: original
        ? `${CODEC_NAMES[info.codec ?? ""] ?? info.codec ?? "?"} (بدون إعادة ترميز)`
        : CODEC_NAMES[codec!],
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
