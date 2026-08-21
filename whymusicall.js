"use strict";
/**
 * WhyMusicAll 聚合音源插件（自 sealure/joy-tune 提取，2026-08-22）
 *
 * 這不是本站原生的音源，而是把 joy-tune（一個 Flutter 音樂 App，
 * https://github.com/sealure/joy-tune）實際使用的音源組合搬過來，包成
 * musicweb 的插件格式。與 plugins/whymusic.js 並存，互不覆蓋。
 *
 * joy-tune 的音源是怎麼來的（提取過程的結論，記在這裡免得日後重查）：
 *   - 它的 GdMusicClient 打的同樣是 GD Music API（music-api.gdstudio.xyz），
 *     source 只是查詢參數；架構上支援「每個子源指向不同 API 伺服器」。
 *   - 子源清單由它自己的後端下發（GET va.1hub.ccwu.cc/api/v1/config/music-sources，
 *     2026-08-22 實測回應）：joox(1) → netease(2) → kuwo(3) → bilibili(4)，
 *     默認 joox，四個源的 url 全部指向同一個 GD API —— 所以「joy-tune 的源」
 *     實質就是 GD API + 這個子源組合與優先次序。
 *   - 它的客戶端寫死同一份兜底清單（其註解：2026-08-09 實測僅這 4 源回 200，
 *     其餘回 HTTP 400 "Value of 'source' is not supported."）。
 *
 * 與 whymusic.js 的差異只有子源組合：這裡是 joox / netease / kuwo / bilibili
 * （joox 優先），whymusic 是 netease / joox。kuwo 與 bilibili 在 GD 上游不保證
 * 穩定（GD 公告的穩定源動態變化，kuwo 曾因 DMCA 下架過）—— 按需求「不管能不能
 * 用」照樣收錄，壞了就是該子源搜不到／解不出，不影響其餘子源。
 *
 * 其餘管線（直連 + 代理退路、快取、繁簡歸一化、音質降級階梯、跨源救援、推薦）
 * 沿用 whymusic.js 的做法 —— 那些是「在這個播放器裡活下來」需要的水電，
 * 不是 joy-tune 的東西。joy-tune 另有專輯搜尋（source 加 _album 後綴）與
 * 自家後端的推薦系統，前者本播放器的歌曲流程用不到、後者不屬於音源，皆未搬。
 */
Object.defineProperty(exports, "__esModule", { value: true });

const PLATFORM = "WhyMusicAll";
const PAGE_SIZE = 20;

const GD_API = "https://music-api.gdstudio.xyz/api.php";
/**
 * 子音源與優先次序，照抄 joy-tune 後端 2026-08-22 下發的配置（joox 默認、
 * 數字越小越優先）。搜尋按此順序交錯合併，播放解析失敗時也按此順序跨源救援。
 */
const SUB_SOURCES = ["joox", "netease", "kuwo", "bilibili"];
/**
 * 音質階梯（kbps）。GD 上游實測支援這五檔（見 whymusic.js 同名常數的註記）。
 * joy-tune 自己的會話默認是 128，但那是它 App 的設定，不是上游的限制 ——
 * 這裡與 whymusic 對齊用 320，使用者在播放器選了什麼就傳什麼。
 */
const BITRATES = [128, 192, 320, 740, 999];
const DEFAULT_BITRATE = 320;

// ── 推薦分類與榜單 ID ──────────────────────────────────────────────────
// joy-tune 的推薦來自它自家後端的資料庫，不是音源的一部分，搬不了。但本播放器
// 把推薦視為音源的能力（沒裝音源就沒有推薦），所以這裡沿用 whymusic.js 的
// 網易雲榜單方案，讓單獨安裝這支插件時推薦頁不至於一片空白。
// 各榜單 ID 的說明見 plugins/whymusic.js 的 CATEGORIES 註解。
const CATEGORIES = {
    hot: { label: "熱門", list: "3778678", orders: ["chart"] },
    cantonese: { label: "粵語", list: "5097494848", orders: ["chart", "pop"] },
    cpop: { label: "中文", list: "3779629", orders: ["chart"] },
    kpop: { label: "Kpop", list: "745956260", orders: ["chart"] },
    western: { label: "歐美", list: "2809513713", orders: ["chart"] },
};
const DEFAULT_CATEGORY = "cantonese";

// ── 上游請求 ────────────────────────────────────────────────────────
const TTL = { search: 600e3, url: 1200e3, pic: 864e5, lyric: 864e5, playlist: 1800e3 };
const CACHE_MAX = 300;
const cache = new Map();

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
        cache.delete(key);
        return undefined;
    }
    return hit.value;
}

function cacheSet(key, value, ttl) {
    if (cache.size >= CACHE_MAX) {
        for (const k of cache.keys()) {
            cache.delete(k);
            if (cache.size <= CACHE_MAX * 0.8) break;
        }
    }
    cache.set(key, { value, expires: Date.now() + ttl });
}

/**
 * 打 GD 上游。先直連；直連失敗才退回本站的 /api/proxy 轉一手。
 * 兩條路都可能被擋且擋法相反，誰不通就換另一條 —— 詳見 whymusic.js 同名函式。
 */
async function gdRequest(types, params) {
    const query = new URLSearchParams({ types });
    for (const key of Object.keys(params || {})) {
        const value = params[key];
        if (value !== undefined && value !== null && value !== "") {
            query.set(key, String(value));
        }
    }
    const qs = query.toString();
    const cached = cacheGet(qs);
    if (cached !== undefined) return cached;

    const target = GD_API + "?" + qs;
    let data;
    try {
        data = await fetchJson(target);
    } catch (directErr) {
        if (!hostHasBackend()) throw directErr;
        try {
            data = await fetchJson("/api/proxy?url=" + encodeURIComponent(target) + "&method=GET");
        } catch (proxyErr) {
            throw new Error(
                "GD Music 兩條路都失敗（直連：" + directErr.message +
                "；代理：" + proxyErr.message + "）",
            );
        }
    }
    cacheSet(qs, data, TTL[types] || 600e3);
    return data;
}

/** 宿主有沒有本站後端可退。判定依據與 whymusic.js / core/native.ts 同一套。 */
function hostHasBackend() {
    if (typeof window === "undefined") return true;
    if (window.__WHYMUSIC_NATIVE__ === true) return false;
    var cap = window.Capacitor;
    if (!cap) return true;
    return !(typeof cap.isNativePlatform === "function" ? cap.isNativePlatform() : !!cap.platform);
}

async function fetchJson(url) {
    const response = await fetch(url);
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error("回應非 JSON (HTTP " + response.status + "): " + text.slice(0, 100));
    }
    if (!response.ok || (data && data.detail)) {
        throw new Error((data && data.detail) || "HTTP " + response.status);
    }
    return data;
}

// ── 繁簡歸一化 ──────────────────────────────────────────────────────
// 跨源比對同一首歌用（「浮誇」↔「浮夸」）。字表與 whymusic.js 同步。
const T2S = {
    傑: '杰', 倫: '伦', 週: '周', 風: '风', 東: '东', 華: '华', 國: '国', 學: '学',
    對: '对', 說: '说', 記: '记', 開: '开', 關: '关', 點: '点', 機: '机', 電: '电',
    車: '车', 門: '门', 問: '问', 間: '间', 見: '见', 話: '话', 實: '实', 書: '书',
    長: '长', 認: '认', 識: '识', 飛: '飞', 魚: '鱼', 鳥: '鸟', 馬: '马', 龍: '龙',
    雲: '云', 霧: '雾', 頭: '头', 頁: '页', 項: '项', 順: '顺', 須: '须', 體: '体',
    誇: '夸', 愛: '爱', 樂: '乐', 夢: '梦', 淚: '泪', 戀: '恋', 願: '愿', 歲: '岁',
    舊: '旧', 過: '过', 還: '还', 這: '这', 個: '个', 們: '们', 來: '来', 時: '时',
    後: '后', 從: '从', 當: '当', 應: '应', 該: '该', 離: '离', 別: '别', 遠: '远',
    邊: '边', 裡: '里', 內: '内', 萬: '万', 億: '亿', 聽: '听', 觀: '观', 讀: '读',
    寫: '写', 語: '语', 詞: '词', 詩: '诗', 聲: '声', 響: '响', 靜: '静', 續: '续',
    終: '终', 結: '结', 緣: '缘', 總: '总', 經: '经', 歷: '历', 變: '变', 換: '换',
    轉: '转', 動: '动', 靈: '灵', 獨: '独', 單: '单', 雙: '双', 誰: '谁', 為: '为',
    無: '无', 沒: '没', 給: '给', 將: '将', 帶: '带', 讓: '让', 覺: '觉', 錯: '错',
    難: '难', 歡: '欢', 樣: '样', 麼: '么', 嗎: '吗', 傷: '伤', 錢: '钱', 醫: '医',
    闌: '阑', 燈: '灯', 舞: '舞', 陽: '阳', 陰: '阴', 黃: '黄', 紅: '红', 綠: '绿',
    藍: '蓝', 銀: '银', 鐵: '铁', 鋼: '钢', 窗: '窗', 廳: '厅', 廣: '广', 場: '场',
    園: '园', 圖: '图', 畫: '画', 詳: '详', 談: '谈', 講: '讲', 論: '论', 議: '议',
};

/** 歸一化歌名/歌手：去括號註記、去標點空白、繁轉簡、轉小寫 */
function normalizeName(text) {
    const stripped = String(text || "")
        .toLowerCase()
        .replace(/[（([【].*?[)）\]】]/g, "")
        .replace(/[\s\-_·・,，.。!！?？'"'"、/\\|&+]/g, "");
    let out = "";
    for (const ch of stripped) out += T2S[ch] || ch;
    return out;
}

/** 判斷搜尋結果是否為目標歌曲（歌名相符 + 歌手互相包含，支援繁簡） */
function isSameSong(candidate, target) {
    const ct = normalizeName(candidate.title);
    const tt = normalizeName(target.title);
    if (!ct || !tt) return false;
    if (ct !== tt && !ct.startsWith(tt) && !tt.startsWith(ct)) return false;
    const ta = normalizeName(target.artist);
    if (!ta) return true;
    const ca = normalizeName(candidate.artist);
    if (!ca) return false;
    return ca.includes(ta) || ta.includes(ca);
}

/** GD 歌曲 → MusicItem */
function normalizeSong(raw, fallbackSource) {
    const artist = Array.isArray(raw.artist)
        ? raw.artist.filter(Boolean).join(" / ")
        : String(raw.artist || "");
    return {
        id: String(raw.url_id || raw.id || ""),
        title: String(raw.name || ""),
        artist,
        album: String(raw.album || ""),
        platform: PLATFORM,
        subSource: String(raw.source || fallbackSource || ""),
        picId: raw.pic_id ? String(raw.pic_id) : "",
        lyricId: raw.lyric_id ? String(raw.lyric_id) : "",
        type: "music",
    };
}

// ── 搜尋 ────────────────────────────────────────────────────────────
async function searchSubSource(source, keyword, page, count) {
    const data = await gdRequest("search", {
        source, name: keyword, count: count, pages: page,
    });
    return Array.isArray(data) ? data.map(raw => normalizeSong(raw, source)) : [];
}

/** 多源並發搜尋：各源輪流取一首後合併，同名同歌手去重 */
async function searchAll(keyword, page, count) {
    const settled = await Promise.allSettled(
        SUB_SOURCES.map(source => searchSubSource(source, keyword, page, count)),
    );
    const buckets = settled.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        console.error("[whymusicall] search failed on " + SUB_SOURCES[i] + ": " + (r.reason && r.reason.message));
        return [];
    });
    // 全部子源都失敗要拋錯，不能與「查無此歌」混成同一片空白 —— 教訓見 whymusic.js。
    // 這裡子源多了 kuwo / bilibili 兩個「不保證能用」的，個別失敗屬於常態，
    // 只要有任何一源活著就照常出結果。
    if (settled.every(r => r.status === "rejected")) {
        throw new Error(
            "所有子音源都失敗：" +
            settled.map((r, i) => SUB_SOURCES[i] + "（" + (r.reason && r.reason.message) + "）").join("；"),
        );
    }

    const seen = new Set();
    const merged = [];
    const maxLen = Math.max(0, ...buckets.map(b => b.length));
    for (let idx = 0; idx < maxLen; idx++) {
        for (const bucket of buckets) {
            const item = bucket[idx];
            if (!item || !item.id || !item.title) continue;
            const key = normalizeName(item.title) + "::" + normalizeName(item.artist);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(item);
        }
    }
    return merged;
}

// ── 音源 ────────────────────────────────────────────────────────────
async function getSubSourceUrl(songId, source, bitrate) {
    const data = await gdRequest("url", { source, id: songId, br: bitrate });
    return (data && data.url) || "";
}

/** 音質降級階梯：requested → 320 → 128。理由見 whymusic.js 同名函式。 */
function bitrateLadder(requested) {
    const ladder = [requested];
    for (const fallback of [320, 128]) {
        if (fallback < requested && ladder.indexOf(fallback) < 0) ladder.push(fallback);
    }
    return ladder;
}

/** 依階梯逐級嘗試，回傳第一個拿到的 URL 與它實際用的位元率 */
async function getUrlWithFallback(songId, source, bitrate) {
    for (const br of bitrateLadder(bitrate)) {
        try {
            const url = await getSubSourceUrl(songId, source, br);
            if (url) return { url, bitrate: br };
        } catch (err) {
            console.error("[whymusicall] url failed " + source + "/" + songId + " br=" + br + ": " + err.message);
        }
    }
    return null;
}

/**
 * 取可播放的音源 URL。指定子源拿不到時，用歌名+歌手到其餘子源找同一首歌再試
 * —— 與 joy-tune 的 SongResolver 是同一個思路（它叫「多源搜索精確匹配」）。
 * exclude：呼叫端已知播不出來的子源，見 whymusic.js 的說明。
 */
async function resolveUrl(opts) {
    const skip = new Set(opts.exclude || []);
    const bitrate = opts.bitrate || DEFAULT_BITRATE;
    const primary = opts.source || SUB_SOURCES[0];
    if (opts.id && !skip.has(primary)) {
        const hit = await getUrlWithFallback(opts.id, primary, bitrate);
        if (hit) return { url: hit.url, source: primary, id: opts.id, bitrate: hit.bitrate };
    }

    const keyword = [opts.title, opts.artist].filter(Boolean).join(" ").trim();
    if (!keyword) return null;
    for (const candidateSource of SUB_SOURCES) {
        if (skip.has(candidateSource)) continue;
        if (candidateSource === primary && opts.id) continue;
        try {
            const list = await searchSubSource(candidateSource, keyword, 1, 5);
            for (const candidate of list.slice(0, 3)) {
                if (!candidate.id || !isSameSong(candidate, opts)) continue;
                const hit = await getUrlWithFallback(candidate.id, candidateSource, bitrate);
                if (hit) {
                    return {
                        url: hit.url, source: candidateSource, id: candidate.id, bitrate: hit.bitrate,
                    };
                }
            }
        } catch (err) {
            console.error("[whymusicall] fallback search failed on " + candidateSource + ": " + err.message);
        }
    }
    return null;
}

// ── 推薦 ────────────────────────────────────────────────────────────
/** 網易雲榜單曲目 → MusicItem（缺 id 或歌名的丟掉） */
function trackToItem(track) {
    const title = String(track.name || "");
    if (!track.id || !title) return null;
    const album = track.al || track.album || {};
    return {
        id: String(track.id),
        title,
        artist: (track.ar || track.artists || []).map(a => a.name).filter(Boolean).join(" / "),
        album: String(album.name || ""),
        artwork: album.picUrl || "",
        platform: PLATFORM,
        subSource: "netease",
        picId: album.pic_str || (album.pic != null ? String(album.pic) : ""),
        lyricId: String(track.id),
        duration: track.dt ? Math.round(track.dt / 1000) : 0,
        type: "music",
    };
}

/** 一份榜單按指定順序排列（chart 原序 / pop 熱度降序），見 whymusic.js */
function sortTracks(tracks, order) {
    if (order !== "pop") return tracks;
    return tracks.slice().sort((a, b) =>
        ((b.pop || 0) - (a.pop || 0)) || ((b.publishTime || 0) - (a.publishTime || 0)));
}

/** 多種順序交錯合併、同名同歌手去重、裁到 limit */
function mergeOrders(tracks, orders, limit) {
    const buckets = orders.map(order => sortTracks(tracks, order).map(trackToItem).filter(Boolean));
    const seen = new Set();
    const out = [];
    const maxLen = Math.max(0, ...buckets.map(b => b.length));
    for (let idx = 0; idx < maxLen && out.length < limit; idx++) {
        for (const bucket of buckets) {
            if (out.length >= limit) break;
            const item = bucket[idx];
            if (!item) continue;
            const key = normalizeName(item.title) + "::" + normalizeName(item.artist);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(item);
        }
    }
    return out;
}

/** 直連 GD 抓整份榜單再自己排序裁切。只在後端不可用時才走 —— 見 recommend() */
async function recommendDirect(cat, limit) {
    const data = await gdRequest("playlist", { source: "netease", id: cat.list });
    const tracks = (data && data.playlist && data.playlist.tracks) || [];
    return mergeOrders(tracks, cat.orders || ["chart"], limit);
}

/** 推薦：先問本站後端（回應小、快取全站共用），失敗才直連 GD。理由見 whymusic.js。 */
async function recommend(category, limit) {
    const cat = CATEGORIES[category] || CATEGORIES[DEFAULT_CATEGORY];
    const key = category in CATEGORIES ? category : DEFAULT_CATEGORY;
    if (!hostHasBackend()) return await recommendDirect(cat, limit);
    try {
        const data = await fetchJson(
            "/api/recommend?cat=" + encodeURIComponent(key) + "&limit=" + limit,
        );
        const list = Array.isArray(data) ? data : (data && data.data) || [];
        if (list.length > 0) return list.slice(0, limit);
    } catch (err) {
        console.warn("[whymusicall] 後端推薦不可用，改直連 GD：" + err.message);
    }
    return await recommendDirect(cat, limit);
}

module.exports = {
    platform: PLATFORM,
    version: "1.0.0",
    author: "musicweb（音源組合提取自 sealure/joy-tune）",
    // 同一首歌在不同子音源的 id 不同，需連同 subSource 才唯一
    primaryKey: ["id", "subSource"],
    cacheControl: "no-cache",
    supportedSearchType: ["music"],

    async search(query, page) {
        const list = await searchAll(query, page || 1, PAGE_SIZE);
        return {
            isEnd: list.length < PAGE_SIZE,
            data: list,
        };
    },

    async getMediaSource(musicItem, quality) {
        const bitrate = BITRATES.indexOf(Number(quality)) >= 0 ? Number(quality) : DEFAULT_BITRATE;
        const result = await resolveUrl({
            id: musicItem.id,
            source: musicItem.subSource,
            bitrate,
            title: musicItem.title,
            artist: musicItem.artist,
            exclude: musicItem._exclude || [],
        });
        if (!result || !result.url) return null;
        return { url: result.url, source: result.source, bitrate: result.bitrate || bitrate };
    },

    async getLyric(musicItem) {
        const data = await gdRequest("lyric", {
            source: musicItem.subSource,
            id: musicItem.lyricId || musicItem.id,
        });
        return {
            rawLrc: (data && data.lyric) || "",
            translation: (data && data.tlyric) || "",
        };
    },

    async getMusicArtwork(musicItem, size) {
        if (!musicItem.picId) return musicItem.artwork || "";
        const data = await gdRequest("pic", {
            source: musicItem.subSource,
            id: musicItem.picId,
            size: size || 500,
        });
        return (data && data.url) || "";
    },

    async getRecommend(category, limit) {
        const size = Number(limit) > 0 ? Math.floor(Number(limit)) : 40;
        return { data: await recommend(category || DEFAULT_CATEGORY, size) };
    },

};
