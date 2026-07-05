const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

// رابط إضافة الترجمة الحقيقية (بدون /manifest.json) — يُقرأ من متغير بيئة في Render
const SUBTITLES_BASE = process.env.SUBTITLES_BASE;

const manifest = {
    id: "org.example.subtitleranker",
    version: "1.0.0",
    name: "Subtitle Match Ranker",
    description: "يرتب نتائج الترجمة حسب مدى تطابقها مع اسم الملف/المصدر المشغّل فعليًا",
    types: ["movie", "series"],
    catalogs: [],
    idPrefixes: ["tt"],
    resources: ["subtitles"],
};

const builder = new addonBuilder(manifest);

function tokenize(text) {
    if (!text) return [];
    return text
        .toLowerCase()
        .replace(/[._\-\[\]()]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1);
}

function matchScore(filenameTokens, subtitleText) {
    const subTokens = new Set(tokenize(subtitleText));
    let score = 0;
    for (const t of filenameTokens) {
        if (subTokens.has(t)) score++;
    }
    return score;
}

builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
    if (!SUBTITLES_BASE) {
        console.error("SUBTITLES_BASE env var not set");
        return { subtitles: [] };
    }

    const extraParams = extra
        ? Object.entries(extra)
              .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
              .join("&")
        : "";

    const url = `${SUBTITLES_BASE}/subtitles/${type}/${encodeURIComponent(id)}${
        extraParams ? `/${extraParams}` : ""
    }.json`;

    let subtitles = [];
    try {
        const r = await fetch(url);
        const j = await r.json();
        subtitles = j.subtitles || [];
    } catch (e) {
        console.error("Failed to fetch upstream subtitles", e);
        return { subtitles: [] };
    }

    const filename = extra && (extra.filename || extra.videoFilename || "");
    const filenameTokens = tokenize(filename);

    if (filenameTokens.length > 0) {
        subtitles = subtitles
            .map((s) => ({
                ...s,
                _score: matchScore(
                    filenameTokens,
                    (s.lang || "") + " " + (s.id || "") + " " + (s.SubFileName || s.release || "")
                ),
            }))
            .sort((a, b) => b._score - a._score)
            .map(({ _score, ...rest }) => rest);
    }

    return { subtitles };
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
