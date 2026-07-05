const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require("node-fetch");
const ptt = require("parse-torrent-title");

const SUBTITLES_BASE = process.env.SUBTITLES_BASE;

const manifest = {
    id: "org.example.subtitleranker",
    version: "2.0.0",
    name: "Subtitle Match Ranker",
    description: "يرتب نتائج الترجمة حسب مدى تطابقها البنيوي (جروب/دقة/مصدر/كودك) مع الملف المشغّل فعليًا",
    types: ["movie", "series"],
    catalogs: [],
    idPrefixes: ["tt"],
    resources: ["subtitles"],
};

const builder = new addonBuilder(manifest);

// نص احتياطي بسيط (Jaccard على الكلمات) يُستخدم فقط كفاصل عند التساوي
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

// درجة التطابق البنيوي الحقيقي بين معلومات الملف الفعلي ومعلومات الترجمة
function structuralScore(fileInfo, subText, fileTokens) {
    if (!subText) return 0;
    const subInfo = ptt.parse(subText);
    let score = 0;

    // Release Group: أقوى إشارة على إن الترجمة مسوّاة لنفس نسخة الملف
    if (fileInfo.group && subInfo.group && fileInfo.group.toLowerCase() === subInfo.group.toLowerCase()) {
        score += 50;
    }
    // الدقة
    if (fileInfo.resolution && subInfo.resolution && fileInfo.resolution === subInfo.resolution) {
        score += 20;
    }
    // المصدر (BluRay/WEB-DL/HDTV...)
    if (fileInfo.source && subInfo.source && fileInfo.source.toLowerCase() === subInfo.source.toLowerCase()) {
        score += 15;
    }
    // الكودك
    if (fileInfo.codec && subInfo.codec && fileInfo.codec.toLowerCase() === subInfo.codec.toLowerCase()) {
        score += 10;
    }
    // تطابق الموسم/الحلقة (تأكيد إضافي، مو شرط لأن الفلترة الأساسية تمت مسبقًا بالـ id)
    if (
        fileInfo.season != null &&
        fileInfo.episode != null &&
        fileInfo.season === subInfo.season &&
        fileInfo.episode === subInfo.episode
    ) {
        score += 10;
    }

    // فاصل نصي عام كإشارة إضافية خفيفة (Jaccard) عند تقارب النقاط
    score += jaccard(fileTokens, tokenize(subText)) * 5;

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
    const videoHash = extra && extra.videoHash;

    if (filename) {
        const fileInfo = ptt.parse(filename);
        const fileTokens = tokenize(filename);

        subtitles = subtitles
            .map((s) => {
                // مطابقة Hash حقيقية = مزامنة مضمونة، تتخطى كل شي
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

