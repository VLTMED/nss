const express = require("express");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const ptt = require("parse-torrent-title");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// قائمة روابط إضافات الترجمة (بدون /manifest.json)، مفصولة بفاصلة
const SUBTITLES_BASES = (process.env.SUBTITLES_BASES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// اسم الخط المطلوب فرضه (يطابق اسم العائلة الداخلي بملف TTF)
const FORCED_FONT_NAME = "thmanyah sans Med";
const FONT_FILE_PATH = path.join(__dirname, "thmanyahsans-Medium.ttf");
const FONT_BUFFER = fs.readFileSync(FONT_FILE_PATH);

// رابط سيرفرنا نفسه (لبناء روابط الترجمة المعدّلة) — Render يوفره تلقائيًا
const OWN_BASE_URL =
    process.env.RENDER_EXTERNAL_URL || process.env.OWN_BASE_URL || `http://localhost:${process.env.PORT || 7000}`;

// تخزين مؤقت بالذاكرة: token -> رابط الترجمة الأصلي
const tokenStore = new Map();
function tokenFor(url) {
    const token = crypto.createHash("sha256").update(url).digest("hex").slice(0, 20);
    tokenStore.set(token, url);
    return token;
}

// ---------- ترميز الخط بصيغة ASS embedded fonts ----------
function encodeFontData(buffer) {
    let out = [];
    for (let i = 0; i < buffer.length; i += 3) {
        const a = buffer[i];
        const b = i + 1 < buffer.length ? buffer[i + 1] : 0;
        const c = i + 2 < buffer.length ? buffer[i + 2] : 0;
        const n = Math.min(3, buffer.length - i);

        const x0 = (a >> 2) & 0x3f;
        const x1 = ((a & 0x3) << 4) | ((b >> 4) & 0xf);
        const x2 = ((b & 0xf) << 2) | ((c >> 6) & 0x3);
        const x3 = c & 0x3f;

        out.push(...[x0 + 33, x1 + 33, x2 + 33, x3 + 33].slice(0, n + 1));
    }
    let lines = [];
    for (let i = 0; i < out.length; i += 80) {
        lines.push(String.fromCharCode(...out.slice(i, i + 80)));
    }
    return lines.join("\n");
}
const ENCODED_FONT = encodeFontData(FONT_BUFFER);

// ---------- تحويل وقت SRT إلى وقت ASS ----------
function srtTimeToAss(t) {
    // 00:00:01,000  ->  0:00:01.00
    const m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return "0:00:00.00";
    const [, h, mm, ss, ms] = m;
    const cs = Math.round(parseInt(ms, 10) / 10)
        .toString()
        .padStart(2, "0");
    return `${parseInt(h, 10)}:${mm}:${ss}.${cs}`;
}

// ---------- تحويل SRT بسيط إلى ASS ----------
function srtToAssBody(srtText) {
    const blocks = srtText.replace(/\r/g, "").split(/\n\n+/).filter(Boolean);
    const lines = [];
    for (const block of blocks) {
        const parts = block.split("\n").filter(Boolean);
        if (parts.length < 2) continue;
        const timeLine = parts.find((p) => p.includes("-->"));
        if (!timeLine) continue;
        const [startRaw, endRaw] = timeLine.split("-->").map((s) => s.trim());
        const textLines = parts.slice(parts.indexOf(timeLine) + 1);
        const text = textLines
            .join("\\N")
            .replace(/<\/?[^>]+>/g, ""); // إزالة تاجات HTML/SRT بسيطة
        lines.push(`Dialogue: 0,${srtTimeToAss(startRaw)},${srtTimeToAss(endRaw)},Default,,0,0,0,,${text}`);
    }
    return lines.join("\n");
}

function isLikelyAss(text) {
    return /\[Script Info\]/i.test(text) && /\[Events\]/i.test(text);
}

// ---------- بناء ملف ASS كامل مع الخط المضمّن ----------
function buildFinalAss(originalText) {
    let eventsBody;
    if (isLikelyAss(originalText)) {
        // نسحب فقط قسم [Events] الموجود، ونستبدل قسم الأنماط بأنماطنا
        const eventsMatch = originalText.match(/\[Events\][\s\S]*/i);
        eventsBody = eventsMatch ? eventsMatch[0] : "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";
    } else {
        // نفترض SRT (أو نص شبيه) ونحوّله
        const body = srtToAssBody(originalText);
        eventsBody = `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${body}`;
    }

    const header = `[Script Info]
Title: Forced Font Subtitle
ScriptType: v4.00+
Collisions: Normal
PlayResX: 1280
PlayResY: 720

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${FORCED_FONT_NAME},28,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1
`;

    const fontsSection = `\n[Fonts]\nfontname: ${FORCED_FONT_NAME}.ttf\n${ENCODED_FONT}\n`;

    return `${header}\n${eventsBody}\n${fontsSection}`;
}

// ================= الإضافة =================
const manifest = {
    id: "org.example.subtitleranker",
    version: "4.0.0",
    name: "Subtitle Match Ranker",
    description: "يجمع ويرتب الترجمات حسب التطابق، ويفرض خط عربي مخصص عبر تضمينه داخل ملف ASS",
    types: ["movie", "series"],
    catalogs: [],
    idPrefixes: ["tt"],
    resources: ["subtitles"],
};

const builder = new addonBuilder(manifest);

function tokenize(text) {
    if (!text) return new Set();
    return new Set(
        text.toLowerCase().replace(/[._\-\[\]()]/g, " ").split(/\s+/).filter((w) => w.length > 1)
    );
}
function jaccard(aTokens, bTokens) {
    if (aTokens.size === 0 || bTokens.size === 0) return 0;
    let inter = 0;
    for (const t of aTokens) if (bTokens.has(t)) inter++;
    const union = aTokens.size + bTokens.size - inter;
    return union === 0 ? 0 : inter / union;
}
function structuralScore(fileInfo, subText, fileTokens) {
    if (!subText) return 0;
    const subInfo = ptt.parse(subText);
    let score = 0;
    if (fileInfo.group && subInfo.group && fileInfo.group.toLowerCase() === subInfo.group.toLowerCase()) score += 50;
    if (fileInfo.resolution && subInfo.resolution && fileInfo.resolution === subInfo.resolution) score += 20;
    if (fileInfo.source && subInfo.source && fileInfo.source.toLowerCase() === subInfo.source.toLowerCase()) score += 15;
    if (fileInfo.codec && subInfo.codec && fileInfo.codec.toLowerCase() === subInfo.codec.toLowerCase()) score += 10;
    if (
        fileInfo.season != null &&
        fileInfo.episode != null &&
        fileInfo.season === subInfo.season &&
        fileInfo.episode === subInfo.episode
    )
        score += 10;
    score += jaccard(fileTokens, tokenize(subText)) * 5;
    return score;
}

async function fetchFromOne(base, type, id, extraParams) {
    const url = `${base}/subtitles/${type}/${encodeURIComponent(id)}${extraParams ? `/${extraParams}` : ""}.json`;
    const debugEntry = { base, url, ok: false, httpStatus: null, count: 0, error: null };
    try {
        const r = await fetch(url, { timeout: 8000 });
        debugEntry.httpStatus = r.status;
        const text = await r.text();
        let j;
        try {
            j = JSON.parse(text);
        } catch (parseErr) {
            debugEntry.error = `JSON parse failed. Raw response (first 300 chars): ${text.slice(0, 300)}`;
            return { subs: [], debug: debugEntry };
        }
        const subs = j.subtitles || [];
        debugEntry.ok = true;
        debugEntry.count = subs.length;
        return { subs, debug: debugEntry };
    } catch (e) {
        debugEntry.error = e.message;
        return { subs: [], debug: debugEntry };
    }
}

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
    if (SUBTITLES_BASES.length === 0) {
        return { subtitles: [], _debug: { error: "SUBTITLES_BASES env var not set" } };
    }

    const extraParams = extra
        ? Object.entries(extra)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
              .join("&")
        : "";

    const results = await Promise.all(SUBTITLES_BASES.map((base) => fetchFromOne(base, type, id, extraParams)));
    let subtitles = results.flatMap((r) => r.subs);
    const debugInfo = results.map((r) => r.debug);

    const filename = extra && (extra.filename || extra.videoFilename || "");
    const videoHash = extra && extra.videoHash;

    if (filename) {
        const fileInfo = ptt.parse(filename);
        const fileTokens = tokenize(filename);

        subtitles = subtitles
            .map((s) => {
                const hashMatch = videoHash && s.SubHash && s.SubHash === videoHash;
                const subText = s.SubFileName || s.release || s.MovieReleaseName || s.id || "";
                const score = hashMatch ? 100000 : structuralScore(fileInfo, subText, fileTokens);
                return { ...s, _score: score };
            })
            .sort((a, b) => b._score - a._score)
            .map(({ _score, ...rest }) => rest);
    }

    // نبدّل كل رابط ترجمة برابط عندنا يقدّم نسخة ASS فيها الخط مضمّن
    subtitles = subtitles.map((s) => {
        if (!s.url) return s;
        const token = tokenFor(s.url);
        return { ...s, url: `${OWN_BASE_URL}/embed-font/${token}.ass` };
    });

    // نضيف معلومات تشخيصية — Stremio/Nuvio يتجاهلونها، لكنها تظهر في أي اختبار JSON خام
    return { subtitles, _debug: debugInfo };
});

// ================= سيرفر Express مخصص (إضافة + مسار تقديم الترجمة المعدّلة) =================
const app = express();
app.use(getRouter(builder.getInterface()));

app.get("/embed-font/:token.ass", async (req, res) => {
    const originalUrl = tokenStore.get(req.params.token);
    if (!originalUrl) return res.status(404).send("Not found");

    try {
        const r = await fetch(originalUrl);
        const originalText = await r.text();
        const finalAss = buildFinalAss(originalText);
        res.setHeader("Content-Type", "text/x-ssa; charset=utf-8");
        res.send(finalAss);
    } catch (e) {
        console.error("Failed to build embedded-font subtitle:", e.message);
        res.status(500).send("Failed to process subtitle");
    }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
