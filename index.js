const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const ptt = require("parse-torrent-title");

// قائمة روابط إضافات الترجمة (بدون /manifest.json)، مفصولة بفاصلة — من متغير بيئة في Render
// مثال: SUBTITLES_BASES=https://a.com/config1,https://b.com/config2,https://c.com/config3
const SUBTITLES_BASES = (process.env.SUBTITLES_BASES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const manifest = {
    id: "org.example.subtitleranker",
    version: "3.0.0",
    name: "Subtitle Match Ranker",
    description: "يجمع نتائج عدة إضافات ترجمة ويرتبها حسب التطابق البنيوي مع الملف المشغّل",
    types: ["movie", "series"],
    catalogs: [],
    idPrefixes: ["tt"],
    resources: ["subtitles"],
};

const builder = new addonBuilder(manifest);

function tokenize(text) {
    if (!text) return new Set();
    return new Set(
        text
            .toLowerCase()
            .replace(/[._\-\[\]()]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 1)
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

    if (fileInfo.group && subInfo.group && fileInfo.group.toLowerCase() === subInfo.group.toLowerCase()) {
        score += 50;
    }
    if (fileInfo.resolution && subInfo.resolution && fileInfo.resolution === subInfo.resolution) {
        score += 20;
    }
    if (fileInfo.source && subInfo.source && fileInfo.source.toLowerCase() === subInfo.source.toLowerCase()) {
        score += 15;
    }
    if (fileInfo.codec && subInfo.codec && fileInfo.codec.toLowerCase() === subInfo.codec.toLowerCase()) {
        score += 10;
    }
    if (
        fileInfo.season != null &&
        fileInfo.episode != null &&
        fileInfo.season === subInfo.season &&
        fileInfo.episode === subInfo.episode
    ) {
        score += 10;
    }

    score += jaccard(fileTokens, tokenize(subText)) * 5;
    return score;
}

// جلب الترجمات من إضافة واحدة، مع تجاهل الأخطاء بدون كسر الباقي
async function fetchFromOne(base, type, id, extraParams) {
    try {
        const url = `${base}/subtitles/${type}/${encodeURIComponent(id)}${extraParams ? `/${extraParams}` : ""}.json`;
        const r = await fetch(url, { timeout: 8000 });
        const j = await r.json();
        return j.subtitles || [];
    } catch (e) {
        console.error(`Failed fetching from ${base}:`, e.message);
        return [];
    }
}

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
    if (SUBTITLES_BASES.length === 0) {
        console.error("SUBTITLES_BASES env var not set");
        return { subtitles: [] };
    }

    const extraParams = extra
        ? Object.entries(extra)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
              .join("&")
        : "";

    // نستعلم من كل الإضافات بالتوازي ونجمع النتائج
    const results = await Promise.all(
        SUBTITLES_BASES.map((base) => fetchFromOne(base, type, id, extraParams))
    );
    let subtitles = results.flat();

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

    return { subtitles };
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
