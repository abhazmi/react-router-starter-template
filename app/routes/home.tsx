import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/home";
import {
  EncodeError,
  PRESETS,
  outputFrameRate,
  encodeForTikTok,
  estimateBytes,
  formatBytes,
  formatDuration,
  isSupportedBrowser,
  readVideoInfo,
  targetSize,
  type EncodeJob,
  type EncodeResult,
  type PresetId,
  type VideoInfo,
} from "../tiktok/encoder";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "تيك توك HD — رفع الفيديو بأعلى جودة" },
    {
      name: "description",
      content:
        "حوّل فيديوك من الجوال لإعدادات الجودة العالية المناسبة لتيك توك قبل الرفع. كل المعالجة تتم على جهازك.",
    },
    { name: "theme-color", content: "#0b0b10" },
  ];
}

type Stage =
  | { kind: "empty" }
  | { kind: "reading" }
  | { kind: "ready"; info: VideoInfo }
  | { kind: "encoding"; info: VideoInfo; progress: number; startedAt: number }
  | { kind: "done"; info: VideoInfo; result: EncodeResult; url: string; seconds: number }
  | { kind: "error"; message: string; info?: VideoInfo };

export default function Home() {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "empty" });
  const [presetId, setPresetId] = useState<PresetId>("1080p");
  const [fps60, setFps60] = useState(true);
  const [decoy, setDecoy] = useState(true);
  const [now, setNow] = useState(Date.now());
  const jobRef = useRef<EncodeJob | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setSupported(isSupportedBrowser()), []);

  useEffect(() => {
    if (stage.kind !== "encoding") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [stage.kind]);

  useEffect(() => {
    if (stage.kind !== "done") return;
    return () => URL.revokeObjectURL(stage.url);
  }, [stage]);

  const preset = PRESETS.find((p) => p.id === presetId)!;

  async function pickFile(f: File | undefined) {
    if (!f) return;
    jobRef.current?.cancel();
    setFile(f);
    setStage({ kind: "reading" });
    try {
      const info = await readVideoInfo(f);
      setStage({ kind: "ready", info });
    } catch (e) {
      console.error(e);
      setStage({
        kind: "error",
        message: "ما قدرنا نقرأ هذا الملف. جرّب فيديو بصيغة MP4 أو MOV.",
      });
    }
  }

  async function start() {
    if (!file || (stage.kind !== "ready" && stage.kind !== "done" && stage.kind !== "error")) return;
    const info = stage.info;
    if (!info) return;
    const startedAt = Date.now();
    setNow(startedAt);
    setStage({ kind: "encoding", info, progress: 0, startedAt });
    const job = encodeForTikTok(file, info, preset, { fps60, decoy }, (progress) =>
      setStage((s) => (s.kind === "encoding" ? { ...s, progress } : s)),
    );
    jobRef.current = job;
    try {
      const result = await job.promise;
      setStage({
        kind: "done",
        info,
        result,
        url: URL.createObjectURL(result.blob),
        seconds: (Date.now() - startedAt) / 1000,
      });
    } catch (e) {
      console.error(e);
      if (e instanceof EncodeError && e.code === "CANCELED") {
        setStage({ kind: "ready", info });
        return;
      }
      const code = e instanceof EncodeError ? e.code : null;
      const message =
        code === "UNSUPPORTED_SIZE"
          ? `جوالك ما يدعم التحويل بدقة ${preset.label}. اختر دقة أقل وجرّب مرة ثانية.`
          : code === "NO_H264"
            ? preset.id === "1080p"
              ? "وضع Decoy يحتاج H.264، والمتصفح هذا ما يدعمه. افتح الصفحة في Safari (آيفون) أو Chrome (أندرويد)، أو طفّ وضع Decoy."
              : `وضع Decoy يحتاج H.264، وجوالك ما يدعمه بدقة ${preset.label}. اختر 1080p أو طفّ وضع Decoy.`
          : code === "UNDECODABLE"
            ? "المتصفح هذا ما يقدر يقرأ صيغة الفيديو. افتح الصفحة في Safari (آيفون) أو Chrome (أندرويد) وجرّب مرة ثانية."
            : "صار خطأ أثناء التحويل. جرّب دقة أقل، أو أغلق التطبيقات الثانية وحاول مرة ثانية.";
      setStage({ kind: "error", message, info });
    } finally {
      jobRef.current = null;
    }
  }

  const outputName = file ? file.name.replace(/\.[^.]+$/, "") + "_HD.mp4" : "video_HD.mp4";

  async function share() {
    if (stage.kind !== "done") return;
    const out = new File([stage.result.blob], outputName, { type: "video/mp4" });
    try {
      await navigator.share({ files: [out] });
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.error(e);
    }
  }

  const canShareFiles =
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [new File([], "x.mp4", { type: "video/mp4" })] });

  const info = "info" in stage ? stage.info : undefined;
  const busy = stage.kind === "reading" || stage.kind === "encoding";

  return (
    <main dir="rtl" className="min-h-dvh bg-[#0b0b10] text-white">
      <div className="mx-auto max-w-lg px-4 pb-16 pt-8">
        <header className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#25f4ee] to-[#fe2c55] text-2xl font-black">
            HD
          </div>
          <h1 className="text-2xl font-extrabold">تيك توك بجودة عالية</h1>
          <p className="mt-2 text-sm leading-relaxed text-white/60">
            حوّل الفيديو لأفضل إعدادات للرفع على تيك توك، وبعدها شاركه مباشرة للتطبيق.
            كل شي يتم على جوالك، الفيديو ما يترفع لأي سيرفر.
          </p>
        </header>

        {supported === false && (
          <Card className="border-[#fe2c55]/50">
            <p className="text-sm leading-relaxed">
              المتصفح الحالي ما يدعم تحويل الفيديو. افتح الصفحة في <b>Safari</b> (آيفون iOS 16.4
              أو أحدث) أو <b>Chrome</b> (أندرويد)، مو من داخل متصفح تطبيق ثاني.
            </p>
          </Card>
        )}

        {/* 1. Pick a video */}
        <Card>
          <StepTitle n={1}>اختر الفيديو</StepTitle>
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              void pickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={busy || supported === false}
            onClick={() => inputRef.current?.click()}
            className="w-full rounded-xl border-2 border-dashed border-white/20 px-4 py-6 text-center transition active:scale-[0.99] disabled:opacity-50"
          >
            {file ? (
              <span className="block truncate text-sm">{file.name}</span>
            ) : (
              <span className="text-base font-semibold">اضغط هنا واختر فيديو من الاستوديو</span>
            )}
            <span className="mt-1 block text-xs text-white/50">
              {file ? "اضغط لتغيير الفيديو" : "MP4 · MOV · من الكاميرا أو أي تطبيق مونتاج"}
            </span>
          </button>

          {stage.kind === "reading" && (
            <p className="mt-3 text-center text-sm text-white/60">جاري قراءة الفيديو…</p>
          )}

          {info && file && (
            <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
              <Info label="الدقة الحالية" value={`${info.width}×${info.height}`} />
              <Info label="الفريمات" value={`${Math.round(info.fps)} fps`} />
              <Info label="المدة" value={formatDuration(info.duration)} />
              <Info label="الحجم" value={formatBytes(file.size)} />
            </dl>
          )}
          {info?.hdr && (
            <p className="mt-3 rounded-lg bg-yellow-400/10 p-3 text-xs leading-relaxed text-yellow-200">
              الفيديو مصوّر بـ HDR. تيك توك أحيانًا يعرض HDR بألوان باهتة، والأداة بتحوله لـ SDR.
              للحصول على أفضل ألوان، طفّ HDR من إعدادات الكاميرا قبل التصوير.
            </p>
          )}
        </Card>

        {/* 2. Choose quality */}
        <Card>
          <StepTitle n={2}>اختر الجودة</StepTitle>
          <div className="grid gap-2">
            {PRESETS.map((p) => {
              const size = info ? targetSize(info, p) : null;
              return (
                <label
                  key={p.id}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 transition ${
                    p.id === presetId ? "border-[#25f4ee] bg-[#25f4ee]/10" : "border-white/10"
                  }`}
                >
                  <input
                    type="radio"
                    name="preset"
                    value={p.id}
                    checked={p.id === presetId}
                    disabled={busy}
                    onChange={() => setPresetId(p.id)}
                    className="accent-[#25f4ee]"
                  />
                  <span className="flex-1">
                    <span className="block font-semibold">
                      {p.label}
                      {p.id === "1080p" && (
                        <span className="ms-2 rounded bg-[#fe2c55] px-1.5 py-0.5 text-[10px]">
                          موصى به
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-white/50">{p.hint}</span>
                  </span>
                  {info && size && (
                    <span className="text-left text-xs text-white/60" dir="ltr">
                      {size.width}×{size.height}
                      <br />≈ {formatBytes(estimateBytes(info, p, { fps60 }))}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          <div className="mt-4 grid gap-2">
            <Toggle
              id="fps60"
              checked={fps60}
              disabled={busy}
              onChange={setFps60}
              title="60 فريم"
              hint="يطلع الفيديو 60fps حتى لو مصوّر 30، عشان تيك توك يعطيه جودة 1080p60."
            />
            <Toggle
              id="decoy"
              checked={decoy}
              disabled={busy}
              onChange={setDecoy}
              title="وضع Decoy"
              hint="يعدّل بيانات الملف بحيث يبيّن إن فيه فريمات أكثر، وهي نفس الطريقة اللي تستخدمها أدوات Decoy 60fps. الصورة نفسها ما تتغير. هذي حيلة غير رسمية، ممكن تيك توك يوقفها أو يعتبرها مخالفة."
            />
          </div>
          {info && (
            <p className="mt-3 text-xs text-white/50">
              الإخراج: H.264 · {outputFrameRate(info, { fps60 })} fps ثابت · صوت AAC
              {decoy && " · Decoy ×10"}
            </p>
          )}
        </Card>

        {/* 3. Convert */}
        <Card>
          <StepTitle n={3}>حوّل الفيديو</StepTitle>
          {stage.kind === "encoding" ? (
            <div>
              <div className="h-3 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-l from-[#25f4ee] to-[#fe2c55] transition-[width]"
                  style={{ width: `${Math.round(stage.progress * 100)}%` }}
                />
              </div>
              <div className="mt-2 flex justify-between text-sm text-white/70">
                <span>{Math.round(stage.progress * 100)}%</span>
                <span>
                  {formatDuration((now - stage.startedAt) / 1000)}
                  {stage.progress > 0.05 &&
                    ` · باقي تقريبًا ${formatDuration(
                      ((now - stage.startedAt) / 1000) * (1 / stage.progress - 1),
                    )}`}
                </span>
              </div>
              <p className="mt-2 text-xs text-white/50">
                خلّ الصفحة مفتوحة والشاشة شغالة لين يخلص التحويل.
              </p>
              <button
                type="button"
                onClick={() => jobRef.current?.cancel()}
                className="mt-3 w-full rounded-xl border border-white/20 py-3 text-sm"
              >
                إلغاء
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!info || busy || supported === false}
              onClick={() => void start()}
              className="w-full rounded-xl bg-gradient-to-l from-[#25f4ee] to-[#fe2c55] py-4 text-lg font-bold text-black transition active:scale-[0.99] disabled:opacity-40"
            >
              {stage.kind === "done" ? "حوّل مرة ثانية" : "ابدأ التحويل بجودة عالية"}
            </button>
          )}
          {stage.kind === "error" && (
            <p className="mt-3 rounded-lg bg-[#fe2c55]/15 p-3 text-sm text-[#ff8da1]">
              {stage.message}
            </p>
          )}
        </Card>

        {/* 4. Result */}
        {stage.kind === "done" && (
          <Card className="border-[#25f4ee]/40">
            <StepTitle n={4}>جاهز! ارفعه على تيك توك</StepTitle>
            <video
              src={stage.url}
              controls
              playsInline
              className="mx-auto max-h-[60vh] w-full rounded-xl bg-black"
            />
            <p className="mt-3 text-center text-xs text-white/60" dir="ltr">
              {stage.result.width}×{stage.result.height} · {stage.result.fps} fps ·{" "}
              {stage.result.codec} · {formatBytes(stage.result.blob.size)} ·{" "}
              {formatDuration(stage.seconds)}
            </p>
            {stage.result.decoyFrames !== null && (
              <p className="mt-2 text-center text-xs text-[#25f4ee]">
                Decoy مفعّل: الملف يبيّن {stage.result.decoyFrames.toLocaleString("en")} فريم
              </p>
            )}
            {stage.result.decoyFailed && (
              <p className="mt-2 rounded-lg bg-yellow-400/10 p-2 text-center text-xs text-yellow-200">
                ما قدرنا نطبّق Decoy على هذا الملف، فطلع بالتحويل العادي.
              </p>
            )}
            <div className="mt-4 grid gap-2">
              {canShareFiles ? (
                <button
                  type="button"
                  onClick={() => void share()}
                  className="rounded-xl bg-white py-4 text-lg font-bold text-black active:scale-[0.99]"
                >
                  مشاركة مباشرة لتيك توك
                </button>
              ) : (
                <a
                  href={stage.url}
                  download={outputName}
                  className="rounded-xl bg-white py-4 text-center text-lg font-bold text-black"
                >
                  حفظ الفيديو
                </a>
              )}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-white/50">
              اضغط الزر واختر <b>TikTok</b> من قائمة المشاركة، والفيديو يروح للتطبيق مباشرة بدون ما
              ينحفظ في الجوال.
            </p>
          </Card>
        )}

        {/* Tips */}
        <Card>
          <h2 className="mb-3 font-bold">عشان تيك توك ما يخرّب الجودة</h2>
          <ol className="list-decimal space-y-2 ps-5 text-sm leading-relaxed text-white/75">
            <li>
              في صفحة النشر بتيك توك: <b>المزيد من الخيارات</b> ← فعّل{" "}
              <b>«السماح بالتحميل بجودة عالية» / Upload HD</b>.
            </li>
            <li>
              من الإعدادات: <b>الإعدادات والخصوصية ← توفير البيانات</b> خله <b>مطفي</b>.
            </li>
            <li>ارفع على Wi‑Fi قوي، لأن تيك توك يخفض الجودة إذا النت ضعيف وقت الرفع.</li>
            <li>
              سوّ المونتاج والنصوص قبل التحويل. الفلاتر والنصوص من محرر تيك توك تخلي التطبيق
              يعيد ضغط الفيديو.
            </li>
            <li>صوّر بأعلى دقة عندك (4K أو 1080p) و30 أو 60 فريم، وبإضاءة كويسة.</li>
            <li>
              إذا الجودة ما زالت ضعيفة من التطبيق، ارفع من موقع تيك توك في المتصفح
              (tiktok.com/tiktokstudio/upload). أدوات Decoy تعتمد على الرفع من الموقع، لأن تطبيق
              الجوال أحيانًا يعيد ضغط الفيديو قبل ما يرفعه.
            </li>
          </ol>
        </Card>
      </div>
    </main>
  );
}

function Toggle({
  id,
  checked,
  disabled,
  onChange,
  title,
  hint,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  title: string;
  hint: string;
}) {
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${
        checked ? "border-[#fe2c55] bg-[#fe2c55]/10" : "border-white/10"
      }`}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-5 w-5 accent-[#fe2c55]"
      />
      <span className="flex-1">
        <span className="block font-semibold">{title}</span>
        <span className="block text-xs leading-relaxed text-white/55">{hint}</span>
      </span>
    </label>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`mb-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4 ${className}`}>
      {children}
    </section>
  );
}

function StepTitle({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 font-bold">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-xs text-black">
        {n}
      </span>
      {children}
    </h2>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/5 p-2">
      <dt className="text-xs text-white/50">{label}</dt>
      <dd className="font-semibold" dir="ltr">
        {value}
      </dd>
    </div>
  );
}
