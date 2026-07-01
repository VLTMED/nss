const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const fetch = require("node-fetch");

// المصدر الأصلي للميتاداتا (غيّره حسب المصدر اللي تبي تسحب منه)
const UPSTREAM_META_BASE = "https://v3-cinemeta.strem.io/meta";

const manifest = {
    id: "org.example.singleseason",
    version: "1.0.0",
    name: "Single Season Merger",
    description: "يدمج كل مواسم المسلسل في موسم واحد مرتب تصاعديًا",
    types: ["series"],
    catalogs: [],           // ما نحتاج كتالوج خاص، فقط resource للـ meta
    idPrefixes: ["tt"],     // يشتغل فقط على IMDb IDs (نفس نطاق Cinemeta)
    resources: ["meta"],
};

const builder = new addonBuilder(manifest);

builder.defineMetaHandler(async ({ type, id }) => {
    if (type !== "series") return { meta: null };

    // 1) اجلب الميتاداتا الأصلية من المصدر
    const res = await fetch(`${UPSTREAM_META_BASE}/series/${id}.json`);
    const data = await res.json();
    const meta = data.meta;

    if (!meta || !Array.isArray(meta.videos)) {
        return { meta };
    }

    // 2) رتّب الحلقات تصاعديًا: الموسم ثم رقم الحلقة
    const sorted = [...meta.videos].sort((a, b) => {
        if (a.season !== b.season) return a.season - b.season;
        return a.episode - b.episode;
    });

    // 3) أعد بناء المصفوفة: كل شيء تحت "Season 1"، مع ترقيم تسلسلي جديد
    meta.videos = sorted.map((ep, index) => {
        const newEpisode = index + 1;
        const originalLabel = `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`;
        return {
            ...ep,
            id: ep.id,                     // مهم: لا تغيّره، تستخدمه إضافات البث
            season: 1,                     // كل الحلقات تحت موسم افتراضي واحد
            episode: newEpisode,           // ترقيم متسلسل جديد يطابق النص
            // النص يعرض الترقيم الجديد (متطابق مع S/E الفعلي)، مع ذكر الأصل بين قوسين للمرجعية
            title: `S01E${String(newEpisode).padStart(2, "0")} • ${ep.title || ""} [${originalLabel}]`,
            // صورة احتياطية لو الحلقة ما عندها thumbnail من المصدر
            thumbnail: ep.thumbnail || meta.background || meta.poster || undefined,
        };
    });

    return { meta };
});

const PORT = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: PORT });
