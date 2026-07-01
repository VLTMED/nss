const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

// المصدر الأصلي للميتاداتا
const UPSTREAM_META_BASE = "https://v3-cinemeta.strem.io/meta";

// رابط Comet الخاص بالمستخدم (بدون /manifest.json في النهاية) — يُقرأ من متغير بيئة في Render
// مثال القيمة: https://comet.elfhosted.com/eyJtYXhSZXN1bHRzUGVy...
const COMET_BASE = process.env.COMET_BASE;

const manifest = {
    id: "org.example.singleseason",
    version: "1.1.0",
    name: "Single Season Merger",
    description: "يدمج كل مواسم المسلسل في موسم واحد مرتب تصاعديًا، ويترجم الطلبات لمصادر البحث تلقائيًا",
    types: ["movie", "series"],
    catalogs: [],
    idPrefixes: ["tt"],
    resources: ["meta", "stream"],
};

const builder = new addonBuilder(manifest);

// دالة مشتركة: تجيب الميتاداتا الأصلية وترتبها وترجع القائمة المرتبة (بدون تعديل season/episode)
async function getSortedEpisodes(imdbId) {
    const res = await fetch(`${UPSTREAM_META_BASE}/series/${imdbId}.json`);
    const data = await res.json();
    const meta = data.meta;
    if (!meta || !Array.isArray(meta.videos)) return { meta: null, sorted: [] };

    const sorted = [...meta.videos].sort((a, b) => {
        if (a.season !== b.season) return a.season - b.season;
        return a.episode - b.episode;
    });
    return { meta, sorted };
}

builder.defineMetaHandler(async ({ type, id }) => {
    if (type !== "series") return { meta: null };

    const { meta, sorted } = await getSortedEpisodes(id);
    if (!meta) return { meta };

    meta.videos = sorted.map((ep, index) => {
        const newEpisode = index + 1;
        const originalLabel = `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`;
        return {
            ...ep,
            id: ep.id,
            season: 1,
            episode: newEpisode,
            title: `S01E${String(newEpisode).padStart(2, "0")} • ${ep.title || ""} [${originalLabel}]`,
            thumbnail: ep.thumbnail || meta.background || meta.poster || undefined,
        };
    });

    return { meta };
});

builder.defineStreamHandler(async ({ type, id }) => {
    if (!COMET_BASE) {
        console.error("COMET_BASE env var not set");
        return { streams: [] };
    }

    // الأفلام: تمرير مباشر بدون تعديل
    if (type === "movie") {
        const r = await fetch(`${COMET_BASE}/stream/movie/${id}.json`);
        const j = await r.json();
        return { streams: j.streams || [] };
    }

    // المسلسلات: الـ id هنا هو نفسه الأصلي (لم نغيّره في المتاداتا)
    // شكله المتوقع: tt1234567:2:1  (imdbId:realSeason:realEpisode)
    const parts = id.split(":");
    if (parts.length !== 3) return { streams: [] };

    const [imdbId, realSeasonStr, realEpisodeStr] = parts;
    const realSeason = parseInt(realSeasonStr, 10);
    const realEpisode = parseInt(realEpisodeStr, 10);

    // نجيب نفس القائمة المرتبة لنعرف رقم الحلقة الافتراضي المقابل
    const { sorted } = await getSortedEpisodes(imdbId);
    const virtualIndex = sorted.findIndex(
        (ep) => ep.season === realSeason && ep.episode === realEpisode
    );

    // نجيب النتائج الحقيقية من Comet بالـ id الأصلي (بدون تعديل)
    const r = await fetch(`${COMET_BASE}/stream/series/${encodeURIComponent(id)}.json`);
    const j = await r.json();
    let streams = j.streams || [];

    if (virtualIndex !== -1) {
        const virtualEpisode = virtualIndex + 1;
        const originalLabel = `S${String(realSeason).padStart(2, "0")}E${String(realEpisode).padStart(2, "0")}`;
        const virtualLabel = `S01E${String(virtualEpisode).padStart(2, "0")}`;
        const re = new RegExp(originalLabel, "gi");

        // نستبدل التسمية الأصلية بالتسمية الافتراضية داخل نصوص كل نتيجة
        streams = streams.map((s) => ({
            ...s,
            title: s.title ? s.title.replace(re, virtualLabel) : s.title,
            name: s.name ? s.name.replace(re, virtualLabel) : s.name,
            description: s.description ? s.description.replace(re, virtualLabel) : s.description,
        }));
    }

    return { streams };
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
