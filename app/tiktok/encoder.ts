// Re-encodes a video in the browser (WebCodecs via mediabunny) with settings
// that survive TikTok's own re-compression as well as possible:
// 9:16-friendly resolution, constant frame rate, H.264 at a high bitrate, AAC audio.
// Nothing is uploaded anywhere; all work happens on the device.

export type PresetId = "1080p" | "2k" | "4k";

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

export function targetBitrate(preset: Preset, fps: number) {
  return Math.round(preset.bitrate30 * (fps > 30 ? 1.5 : 1));
}

export type EncodeOptions = {
  /** Output 60 fps even when the source is slower (frames are repeated). */
  fps60: boolean;
  /** Apply the ghost-frame container rewrite (forces H.264). */
  decoy: boolean;
};

export function outputFrameRate(info: Pick<VideoInfo, "fps">, opts: Pick<EncodeOptions, "fps60">) {
  return opts.fps60 ? 60 : targetFrameRate(info.fps);
}

export function estimateBytes(info: VideoInfo, preset: Preset, opts: Pick<EncodeOptions, "fps60">) {
  const fps = outputFrameRate(info, opts);
  const audio = info.hasAudio ? AUDIO_BITRATE : 0;
  return ((targetBitrate(preset, fps) + audio) * info.duration) / 8;
}

export type EncodeResult = {
  blob: Blob;
  width: number;
  height: number;
  fps: number;
  codec: string;
  /** Declared frame count when the decoy rewrite was applied, otherwise null. */
  decoyFrames: number | null;
  /** True when the decoy was requested but couldn't be applied to this file. */
  decoyFailed: boolean;
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
    const { width, height } = targetSize(info, preset);
    const fps = outputFrameRate(info, opts);
    const bitrate = targetBitrate(preset, fps);
    const quality = new mb.Quality({ bitrate, bitrateMode: "variable" });

    // H.264 is what TikTok handles best; fall back to HEVC, then VP9, if the device can't do it at this size.
    // The decoy rewrite only works on H.264.
    let codec: "avc" | "hevc" | "vp9" | null = null;
    for (const c of opts.decoy ? (["avc"] as const) : (["avc", "hevc", "vp9"] as const)) {
      if (await mb.canEncodeVideo(c, { width, height, quality, frameRate: fps })) {
        codec = c;
        break;
      }
    }
    if (!codec) throw new EncodeError(opts.decoy ? "NO_H264" : "UNSUPPORTED_SIZE");
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
        video: {
          width,
          height,
          fit: "contain",
          frameRate: fps,
          codec,
          quality,
          keyFrameInterval: 2,
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
    let decoyFrames: number | null = null;
    let decoyFailed = false;
    if (opts.decoy) {
      const { applyDecoy } = await import("./decoy");
      try {
        const r = applyDecoy(bytes);
        bytes = r.bytes as Uint8Array<ArrayBuffer>;
        decoyFrames = r.stats.declaredFrames;
      } catch (e) {
        console.error(e);
        decoyFailed = true;
      }
    }

    return {
      decoyFrames,
      decoyFailed,
      blob: new Blob([bytes], { type: "video/mp4" }),
      width,
      height,
      fps,
      codec: { avc: "H.264", hevc: "HEVC", vp9: "VP9" }[codec],
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
