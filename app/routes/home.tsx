import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/home";
import {
  PrepareError,
  canMakeLight,
  codecName,
  formatBytes,
  formatDuration,
  maxEligibility,
  prepareForTikTok,
  readVideoInfo,
  type Job,
  type Result,
  type VideoInfo,
} from "../tiktok/encoder";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "تيك توك HD — جهّز مقطعك بأعلى جودة" },
    {
      name: "description",
      content:
        "جهّز مقطعك لتيك توك من المتصفح بدون إعادة ترميز: نفس الدقة والفريمات وألوان HDR. كل المعالجة على جهازك.",
    },
    { name: "theme-color", content: "#0b0b10" },
  ];
}

type Stage =
  | { kind: "empty" }
  | { kind: "reading" }
  | { kind: "ready"; info: VideoInfo }
  | { kind: "working"; info: VideoInfo; progress: number; startedAt: number }
  | { kind: "done"; info: VideoInfo; result: Result; url: string; seconds: number }
  | { kind: "error"; message: string; info?: VideoInfo };

type Device = "iphone" | "android" | "computer";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "empty" });
  const [light, setLight] = useState(false);
  const [mute, setMute] = useState(false);
  const [lightSupported, setLightSupported] = useState(true);
  const [device, setDevice] = useState<Device>("iphone");
  const [now, setNow] = useState(Date.now());
  const jobRef = useRef<Job | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLightSupported(canMakeLight());
    const ua = navigator.userAgent;
    setDevice(/iPhone|iPad/.test(ua) ? "iphone" : /Android/.test(ua) ? "android" : "computer");
  }, []);

  useEffect(() => {
    if (stage.kind !== "working") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [stage.kind]);

  useEffect(() => {
    if (stage.kind !== "done") return;
    return () => URL.revokeObjectURL(stage.url);
  }, [stage]);

  async function pickFile(f: File | undefined) {
    if (!f) return;
    jobRef.current?.cancel();
    setFile(f);
    setStage({ kind: "reading" });
    try {
      setStage({ kind: "ready", info: await readVideoInfo(f) });
    } catch (e) {
      console.error(e);
      setStage({ kind: "error", message: "ما قدرنا نقرأ هذا الملف. جرّب مقطع MP4 أو MOV أصلي." });
    }
  }

  const info = "info" in stage ? stage.info : undefined;
  const eligibility = info ? maxEligibility(info) : null;
  const mode = light ? "light" : "max";
  const busy = stage.kind === "reading" || stage.kind === "working";
  const canStart = !!info && !busy && (light ? lightSupported : eligibility?.ok);

  async function start() {
    if (!file || !info) return;
    const startedAt = Date.now();
    setNow(startedAt);
    setStage({ kind: "working", info, progress: 0, startedAt });
    const job = prepareForTikTok(file, info, mode, { mute }, (progress) =>
      setStage((s) => (s.kind === "working" ? { ...s, progress } : s)),
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
      const code = e instanceof PrepareError ? e.code : null;
      if (code === "CANCELED") return setStage({ kind: "ready", info });
      const message =
        code === "NOT_ELIGIBLE"
          ? (e as Error).message
          : code === "NO_ENCODER"
            ? "المتصفح هذا ما يقدر يسوي «نسخة أخف». افتح الصفحة في Safari أو Chrome محدّث."
            : code === "UNDECODABLE"
              ? "المتصفح ما يقدر يقرأ صيغة هذا المقطع للضغط. استخدم «الجودة القصوى» أو جرّب Safari أو Chrome."
              : code === "NOT_SMALLER"
                ? "المقطع مضغوط أصلًا، والنسخة الأخف ما طلعت أصغر منه. استخدم «الجودة القصوى»."
                : "تعذّر إكمال العملية. أغلق التبويبات الثانية، وتأكد من المساحة، وجرّب مقطعًا أقصر.";
      setStage({ kind: "error", message, info });
    } finally {
      jobRef.current = null;
    }
  }

  const outputName = file ? file.name.replace(/\.[^.]+$/, "") + "_HD.mp4" : "video_HD.mp4";
  const canShareFiles =
    typeof navigator !== "undefined" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [new File([], "x.mp4", { type: "video/mp4" })] });

  async function share() {
    if (stage.kind !== "done") return;
    try {
      await navigator.share({ files: [new File([stage.result.blob], outputName, { type: "video/mp4" })] });
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.error(e);
    }
  }

  return (
    <main dir="rtl" className="min-h-dvh bg-[#0b0b10] text-white">
      <div className="mx-auto max-w-lg px-4 pb-16 pt-8">
        <header className="mb-6">
          <p className="text-xs font-semibold tracking-wider text-[#25f4ee]">استوديو الفيديو على جهازك</p>
          <h1 className="mt-1 text-3xl font-extrabold leading-tight">جودة مقطعك، مثل ما صوّرته.</h1>
          <p className="mt-2 text-sm leading-relaxed text-white/65">
            جهّز مقطعك لتيك توك من المتصفح بصيغة HEVC بجودة عالية جدًا، بملف مثل ملفات كاميرا الآيفون،
            وبنفس الدقة (لين 4K) والفريمات (لين 60). الفيديو ما يطلع من جهازك.
          </p>
          <ol className="mt-4 grid grid-cols-3 gap-2 text-center text-xs text-white/70">
            {["اختر مقطعك من «الملفات»", "نفحص توافقه", "احفظه وارفعه من المتصفح"].map((t, i) => (
              <li key={t} className="rounded-xl bg-white/[0.05] p-2">
                <span className="block text-base font-bold text-white">{i + 1}</span>
                {t}
              </li>
            ))}
          </ol>
        </header>

        {/* 1. Pick */}
        <Card>
          <input
            ref={inputRef}
            id="video-file"
            type="file"
            accept="video/*,.mov,.mp4"
            className="hidden"
            onChange={(e) => {
              void pickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="w-full rounded-xl border-2 border-dashed border-white/20 px-4 py-6 text-center transition active:scale-[0.99] disabled:opacity-50"
          >
            <span className="block text-base font-semibold">
              {file ? file.name : "اختر مقطعك"}
            </span>
            <span className="mt-1 block text-xs text-white/50">
              {file ? "اضغط لتغيير المقطع" : "استعراض الملفات"}
            </span>
          </button>
          <p className="mt-2 rounded-lg bg-yellow-400/10 p-2 text-xs leading-relaxed text-yellow-100">
            اختر من «الملفات»، مو من مكتبة الصور. على الآيفون: افتح المقطع في «الصور» ← مشاركة ←
            «حفظ في الملفات»، وارجع اختره من هنا. الصور تعطي الصفحة نسخة مضغوطة.
          </p>

          {stage.kind === "reading" && (
            <p className="mt-3 text-center text-sm text-white/60">نفحص المقطع…</p>
          )}

          {info && (
            <>
              <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
                <Info label="الدقة" value={`${info.width}×${info.height}`} />
                <Info label="الإطارات" value={`${Math.round(info.fps)} fps`} />
                <Info label="الألوان" value={info.hdr ? "HDR" : "SDR"} />
                <Info label="الحجم" value={formatBytes(info.size)} />
              </dl>
              {info.size > 500 * 1024 ** 2 && (
                <p className="mt-2 text-xs text-yellow-200">
                  الملف كبير نسبيًا للجوال. خلّ الشاشة مفتوحة، وتأكد إن عندك مساحة كافية.
                </p>
              )}
            </>
          )}
        </Card>

        {/* 2. Output */}
        <Card>
          <h2 className="mb-3 font-bold">جهّز الفيديو</h2>
          <div
            className={`rounded-xl border p-3 ${
              !light ? "border-[#25f4ee] bg-[#25f4ee]/10" : "border-white/10 opacity-60"
            }`}
          >
            <p className="flex items-center gap-2 font-bold">
              الجودة القصوى
              <span className="rounded bg-[#25f4ee] px-1.5 py-0.5 text-[10px] text-black">الخيار الرئيسي</span>
            </p>
            <p className="mt-1 text-xs leading-relaxed text-white/65">
              يحوّل الفيديو إلى HEVC بجودة عالية جدًا، بنفس الدقة والفريمات والتوقيت، داخل ملف مرتّب مثل
              ملفات كاميرا الآيفون. إذا المقطع HEVC أصلًا (مثل تصوير الآيفون وHDR) ينسخه بدون إعادة ترميز.
              ما يكبّر مقطعًا أصغر إلى 4K.
            </p>
            <p
              className={`mt-2 text-xs font-semibold ${
                !info ? "text-white/45" : eligibility?.ok ? "text-[#25f4ee]" : "text-[#ff8da1]"
              }`}
            >
              {!info
                ? "اختر فيديو لنعرف هل يناسب الجودة القصوى."
                : eligibility?.ok
                  ? "✓ المقطع متوافق"
                  : `✕ ${(eligibility as { reason: string }).reason}`}
            </p>
          </div>

          <div className="mt-2 grid gap-2">
            <Toggle
              id="light"
              checked={light}
              disabled={busy || !lightSupported}
              onChange={setLight}
              title="نسخة أخف"
              hint={
                lightSupported
                  ? "نسخة أصغر بجودة عالية قدر الإمكان (H.264، لين 1080p). خيار مستقل عن الجودة القصوى، وأوقفه للرجوع لها."
                  : "المتصفح هذا ما يدعم الضغط."
              }
            />
            <Toggle
              id="mute"
              checked={mute}
              disabled={busy}
              onChange={setMute}
              title="نسخة بلا صوت"
              hint="يشيل الصوت من الملف، إذا بتضيف صوت من مكتبة تيك توك."
            />
          </div>

          {stage.kind === "working" ? (
            <div className="mt-4">
              <div className="h-3 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-gradient-to-l from-[#25f4ee] to-[#fe2c55] transition-[width]"
                  style={{ width: `${Math.round(stage.progress * 100)}%` }}
                />
              </div>
              <div className="mt-2 flex justify-between text-sm text-white/70">
                <span>{Math.round(stage.progress * 100)}%</span>
                <span>{formatDuration((now - stage.startedAt) / 1000)}</span>
              </div>
              <p className="mt-2 text-xs text-white/50">
                لا تحدّث الصفحة، وخلّ الشاشة مفتوحة. الجوال ممكن يوقف المعالجة إذا قفلت الشاشة أو بدّلت
                التطبيق.
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
              disabled={!canStart}
              onClick={() => void start()}
              className="mt-4 w-full rounded-xl bg-gradient-to-l from-[#25f4ee] to-[#fe2c55] py-4 text-lg font-bold text-black transition active:scale-[0.99] disabled:opacity-40"
            >
              {light ? "اضغط النسخة الأخف" : "إنتاج الجودة القصوى"}
            </button>
          )}
          {stage.kind === "error" && (
            <p className="mt-3 rounded-lg bg-[#fe2c55]/15 p-3 text-sm text-[#ff8da1]">{stage.message}</p>
          )}
        </Card>

        {/* 3. Result */}
        {stage.kind === "done" && (
          <Card className="border-[#25f4ee]/40">
            <h2 className="mb-3 font-bold">✓ مقطعك جاهز للحفظ</h2>
            {stage.result.video === "copy" && stage.info.codec !== "hevc" && (
              <p className="mb-3 rounded-lg bg-yellow-400/10 p-2 text-xs leading-relaxed text-yellow-100">
                جهازك أو متصفحك ما يدعم ترميز HEVC، فنسخنا الفيديو الأصلي بملف مثل ملفات الآيفون. للحصول على
                HEVC افتح الصفحة في Safari على الآيفون أو الماك.
              </p>
            )}
            <video src={stage.url} controls playsInline className="max-h-[60vh] w-full rounded-xl bg-black" />
            <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-center text-xs">
              <div className="rounded-lg bg-white/5 p-2">
                <p className="text-white/50">قبل</p>
                <p dir="ltr">
                  {stage.info.width}×{stage.info.height} · {Math.round(stage.info.fps)}fps
                </p>
                <p>
                  {codecName(stage.info.codec)} · {formatBytes(stage.info.size)}
                </p>
              </div>
              <span className="text-white/40">←</span>
              <div className="rounded-lg bg-[#25f4ee]/10 p-2">
                <p className="text-white/50">بعد</p>
                <p dir="ltr">
                  {stage.result.width}×{stage.result.height} · {Math.round(stage.result.fps)}fps
                  {stage.result.hdr && " · HDR"}
                </p>
                <p>
                  {stage.result.codec} · {formatBytes(stage.result.blob.size)}
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-2">
              {canShareFiles ? (
                <button
                  type="button"
                  onClick={() => void share()}
                  className="rounded-xl bg-white py-4 text-lg font-bold text-black active:scale-[0.99]"
                >
                  احفظ المقطع
                </button>
              ) : (
                <a
                  href={stage.url}
                  download={outputName}
                  className="rounded-xl bg-white py-4 text-center text-lg font-bold text-black"
                >
                  احفظ المقطع
                </a>
              )}
              <a href="#upload" className="rounded-xl border border-white/20 py-3 text-center font-semibold">
                خطوات الرفع إلى تيك توك ↓
              </a>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-white/55">
              على الآيفون اختر «حفظ في الملفات» من قائمة المشاركة. افتح الملف المحفوظ وتأكد من المدة والصورة
              والصوت قبل الرفع، واحتفظ بنسختك الأصلية.
            </p>
          </Card>
        )}

        {/* Upload guide */}
        <Card>
          <h2 id="upload" className="mb-1 scroll-mt-4 font-bold">
            ارفع مقطعك إلى تيك توك
          </h2>
          <p className="mb-3 text-xs leading-relaxed text-white/60">
            لا تشاركه لتطبيق تيك توك: التطبيق يضغط الفيديو قبل الرفع. ارفعه يدويًا من المتصفح.
          </p>
          <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-white/5 p-1 text-sm" role="tablist">
            {(
              [
                ["iphone", "آيفون"],
                ["android", "أندرويد"],
                ["computer", "كمبيوتر"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={device === id}
                onClick={() => setDevice(id)}
                className={`rounded-lg py-2 ${device === id ? "bg-white font-bold text-black" : "text-white/70"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <ol className="list-decimal space-y-2 ps-5 text-sm leading-relaxed text-white/80">
            {device === "iphone" && (
              <>
                <li>احفظ المقطع: «مشاركة» ← «حفظ في الملفات».</li>
                <li>
                  افتح TikTok Studio في Safari، واضغط «aA» بجانب العنوان ← «طلب موقع ويب سطح المكتب».
                </li>
                <li>سجّل دخولك، واختر الملف من «الملفات».</li>
              </>
            )}
            {device === "android" && (
              <>
                <li>احفظ المقطع، وتلقاه في «التنزيلات».</li>
                <li>افتح TikTok Studio في Chrome، واضغط ⋮ ← فعّل «موقع سطح المكتب».</li>
                <li>سجّل دخولك، واختر الملف من التنزيلات.</li>
              </>
            )}
            {device === "computer" && (
              <>
                <li>احفظ المقطع وافتحه في مشغّل فيديو للتأكد منه.</li>
                <li>افتح TikTok Studio في المتصفح وسجّل دخولك.</li>
                <li>اسحب الملف إلى خانة الرفع.</li>
              </>
            )}
            <li>خلّ «من يمكنه المشاهدة» على «الجميع».</li>
            <li>انشر مباشرة بدون ما تضيف صوت أو مؤثرات داخل تيك توك. تعديل الوصف عادي.</li>
          </ol>
          <a
            href="https://www.tiktok.com/tiktokstudio/upload"
            target="_blank"
            rel="noreferrer"
            className="mt-4 block rounded-xl bg-[#fe2c55] py-3 text-center font-bold"
          >
            فتح TikTok Studio ↗
          </a>
          <p className="mt-3 text-[11px] leading-relaxed text-white/45">
            إكمال الرفع ما يضمن الدقة اللي بيعرضها تيك توك للمشاهدين، لأن تيك توك يعالج المقطع بعد الرفع.
            ترتيب الملف مثل ملفات الآيفون طريقة غير رسمية، وتيك توك ممكن يغيّر طريقة معالجته في أي وقت.
          </p>
        </Card>

        {/* Troubleshooting */}
        <Card>
          <h2 className="mb-2 font-bold">مشاكل شائعة</h2>
          <div className="divide-y divide-white/10 text-sm">
            <Faq q="الملف ما يشتغل أو مدته غلط">
              افتح الملف المحفوظ وتأكد من مدته وصورته. إذا فيه مشكلة لا ترفعه، وجرّب مرة ثانية من المقطع الأصلي.
            </Faq>
            <Faq q="الملف 4K بس تيك توك ما يعرض 4K">
              الجودة القصوى تحافظ على دقة المصدر، بس اللي يعرضه تيك توك يعتمد على معالجته بعد الرفع. تأكد إنك
              رفعت من المتصفح بدون مؤثرات أو صوت مضاف.
            </Faq>
            <Faq q="ألوان HDR تغيّرت">
              مقاطع HDR من الآيفون تكون HEVC أصلًا، فالجودة القصوى تنسخها بدون تغيير. قارن المصدر والناتج على نفس
              الشاشة ونفس المشغّل.
            </Faq>
            <Faq q="المعالجة بطيئة أو النسبة واقفة">
              خلّ المتصفح قدام والشاشة مفتوحة، وأغلق التبويبات الثانية، وجرّب مقطعًا أقصر.
            </Faq>
            <Faq q="ما ألقى الفيديو في الصور">
              من «مشاركة» اختر «حفظ في الملفات»، وبعدها افتح تطبيق «الملفات» وروح للمجلد اللي اخترته.
            </Faq>
          </div>
        </Card>

        <p className="text-center text-[11px] text-white/40">
          المعالجة كلها على جهازك. الفيديو ما يترفع لأي خادم.
        </p>
      </div>
    </main>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section className={`mb-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4 ${className}`}>
      {children}
    </section>
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
      } ${disabled ? "opacity-50" : ""}`}
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

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="py-2">
      <summary className="cursor-pointer font-semibold">{q}</summary>
      <p className="mt-1 text-xs leading-relaxed text-white/65">{children}</p>
    </details>
  );
}
