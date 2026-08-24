"use strict";
/**
 * WhyMusic 聚合音源插件（自給自足版）
 *
 * 由瀏覽器直接呼叫上游 GD Music API，不經過本站後端。
 *
 * 為什麼改成直連（2026-08-19）：
 *   原本搜尋／音源／歌詞／封面全走本站後端 /api/why-*，由後端扇出到子音源。
 *   但 music-api.gdstudio.xyz 自己也在 Cloudflare 後面，而本站後端是 Cloudflare
 *   Worker —— GD 開始擋 Worker 來的流量，對本站後端一律回 HTTP 520，於是搜尋與
 *   推薦全部變成空陣列（實測：同一支 worker 打 cloudflare.com 正常、打 GD 穩定
 *   520；同時從一般網路直連 GD 4/4 成功）。這不是本站程式的問題，也修不了對方的
 *   WAF，唯一的解法是不要從 Cloudflare 出去。
 *
 *   直連在此可行，因為 GD 回 `access-control-allow-origin: *`（實測）。原本註解說
 *   「上游不保證 CORS，瀏覽器直連會被擋」對 GD 並不成立。
 *
 * 直連的附帶好處：
 *   - 上游按 IP 限流。走後端時全站使用者共用一個出口 IP，直連則各自算自己的。
 *   - 音源不再依賴本站後端，播放器與音源真正分離：這支插件貼到任何一份
 *     musicweb 都能用，不必配一個對應的後端。
 *
 * 子音源：netease（簡體曲庫最全）、joox（港台繁體與粵語 live 版本多）。
 * item.subSource 記錄該首歌實際來自哪個子音源，取音源時原樣帶回上游。
 * audiomack 曾是第三個子音源，因播放不穩（URL 解析成功但常在客戶端播不出來，
 * 且疑似有地域限制）而移除 —— 它獨有的曲目沒有替代來源可救援。
 */
Object.defineProperty(exports, "__esModule", { value: true });

const PLATFORM = "WhyMusic";
const PAGE_SIZE = 20;

const GD_API = "https://music-api.gdstudio.xyz/api.php";
/** 對外呈現一個 WhyMusic，底下扇出到這些子音源 */
const SUB_SOURCES = ["netease", "joox"];
/**
 * 音質階梯（kbps）。上游實測支援這五檔（2026-08-22）：
 *   128 / 192 / 320 各自回不同大小的檔；740 與 999 都解到同一個無損檔
 *   （回報 br=986、約 33MB），所以最高兩檔實際是同一個來源、不是浪費。
 * 這份清單是音源自己的事 —— 播放器只把使用者選的數字原樣傳進來。
 */
const BITRATES = [128, 192, 320, 740, 999];
const DEFAULT_BITRATE = 320;

// ── 推薦分類與榜單 ID ──────────────────────────────────────────────────
// 五個分類，一個分類對**一份**榜單。刻意只給一份：一個分類配多份榜單就要抓多次，
// 而榜單回應動輒 200KB–2.4MB，抓兩份就讓推薦頁多等好幾秒。要在同一個分類裡呈現
// 不同面向（例如粵語要同時有最新與熱門），是把抓回來的那一份排兩次，不是抓兩份。
//
// 網易雲官方榜單（ID 穩定，內容由官方更新）：
//   3778678 — 熱歌榜（每小時更新，跨語種的總熱門）
//   3779629 — 新歌榜（華語為主，每天更新）
//   745956260 — 韓語榜（每天更新）
//   2809513713 — 歐美熱歌榜（每天更新）
//
// 叱咤903 是香港商業電台的粵語流行榜，第三方建立，非官方榜單。它是目前唯一還
// 在更新的粵語榜（官方的「港台榜」與「龍虎榜」都停在 2020 年初、只剩十來首），
// 但有 1000 首、2.4MB —— 所以推薦一律先走本站後端取裁切過的結果，見 recommend()。
//
// orders 是這份榜單要用幾種順序取樣：
//   chart — 榜單本身的順序（叱咤榜是按發行時間降序，也就是「最新」）
//   pop   — 按網易雲的 pop 熱度降序，也就是「熱門」
// 粵語兩種都要：叱咤榜有 1000 首，光看榜單原順序只會看到最近幾週發行的，
// 那些真正紅的粵語歌反而看不到。兩種順序是**同一份已抓回來的資料**排兩次，
// 不會多打一次上游 —— 所以「加上熱門」這件事在流量上是免費的。
// caption 是「這個分類的資料實際來自哪裡」。由音源自己回報而不是寫在 app 裡 ——
// app 不該知道任何音源用了什麼榜單，寫死了換音源就變謊話。
const CATEGORIES = {
    hot: { label: "熱門", caption: "網易雲熱歌榜", list: "3778678", orders: ["chart"] },
    cantonese: {
        label: "粵語", caption: "香港叱咤903專業推介（最新＋熱門）",
        list: "5097494848", orders: ["chart", "pop"],
    },
    cpop: { label: "中文", caption: "網易雲新歌榜", list: "3779629", orders: ["chart"] },
    kpop: { label: "Kpop", caption: "網易雲韓語榜", list: "745956260", orders: ["chart"] },
    western: {
        label: "歐美", caption: "網易雲歐美熱歌榜",
        list: "2809513713", orders: ["chart"],
    },
};
const DEFAULT_CATEGORY = "cantonese";

// ── 上游請求 ────────────────────────────────────────────────────────
// 分頁存活期間的記憶體快取。走後端時快取在後端（全站共用），直連之後每個瀏覽器
// 自己存一份 —— 命中率較低，但上游限流也變成各自計算，整體反而寬鬆。
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
    // 到上限就從最舊的開始清（Map 保留插入順序），清到八成滿為止
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
 *
 * 兩條路都留著是因為兩邊都可能被擋，而且擋法相反：目前是 GD 擋 Cloudflare
 * Worker（所以 proxy 那條不通、直連通），但也遇過使用者的網路連不到某些境外
 * 主機（那時就換成直連不通、proxy 通）。誰不通就換另一條，不必改程式。
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
        // 原生 App 沒有後端可退，直連失敗就是失敗，別再白試一次代理
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

/**
 * 這個宿主有沒有「本站後端」可用。插件會被載進三種宿主：網頁版（有後端）、
 * Cloudflare 版（有 worker）、以及打包進 APK 的原生 App（**沒有**任何後端）。
 * 原生宿主由 Capacitor 注入 window.Capacitor 判定，與前端的 core/native.ts 同一套依據。
 */
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
        // 上游對不支援的參數組合會回 HTML 錯誤頁；被擋時回的是 Cloudflare 錯誤頁
        throw new Error("回應非 JSON (HTTP " + response.status + "): " + text.slice(0, 100));
    }
    if (!response.ok || (data && data.detail)) {
        throw new Error((data && data.detail) || "HTTP " + response.status);
    }
    return data;
}

// ── 繁簡歸一化 ──────────────────────────────────────────────────────
// 上游（網易雲）資料多為簡體，本站 UI 與港樂曲目多為繁體，跨源比對同一首歌時
// 需要歸一化（「浮誇」↔「浮夸」）。
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
    // 實測補上：搜 moon tang 時「夜闌人靜」(joox) 與「夜阑人静」(netease) 因為
    // 缺這幾個字而沒被判成同一首，兩筆都列出來
    闌: '阑', 燈: '灯', 舞: '舞', 陽: '阳', 陰: '阴', 黃: '黄', 紅: '红', 綠: '绿',
    藍: '蓝', 銀: '银', 鐵: '铁', 鋼: '钢', 窗: '窗', 廳: '厅', 廣: '广', 場: '场',
    園: '园', 圖: '图', 畫: '画', 詳: '详', 談: '谈', 講: '讲', 論: '论', 議: '议',
};

/** 歸一化歌名/歌手：去括號註記、去標點空白、繁轉簡、轉小寫 */
function normalizeName(text) {
    const stripped = String(text || "")
        .toLowerCase()
        // 去掉 (Live)、（電視劇主題曲）、[Explicit] 這類註記
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
    if (!ta) return true;  // 目標無歌手資訊，歌名相符即可
    const ca = normalizeName(candidate.artist);
    if (!ca) return false;
    // 歌手可能是「陳奕迅 / MissG」這種拼接，歸一化後互相包含即算命中
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
        // GD 的子音源（netease / joox…），播放時要原樣帶回上游
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
        console.error("[why] search failed on " + SUB_SOURCES[i] + ": " + (r.reason && r.reason.message));
        return [];
    });
    // 全部子源都失敗時要拋錯，不能回空陣列。「查無此歌」和「上游整個連不上」
    // 若都顯示成一片空白，使用者只能猜是沒這首歌、還是程式壞了 —— GD 開始擋
    // Cloudflare 時就是這樣悶了一段時間才被發現。
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

/**
 * 音質降級階梯。使用者選了高音質，但不是每首歌都有 —— 上游多數時候會自己降
 * （要 999 回一個 br=904 的檔），但實測也有曲目在高音質直接回空字串。那時不該
 * 讓整首歌變成「無法播放」，而該退一步拿得到的音質。
 *
 * 刻意不是逐檔往下走（999→740→320→192→128）：740 與 999 解到的是同一個無損來源，
 * 999 失敗時 740 幾乎必然也失敗，白花一次往返。直接跳到 320（最普及的一檔）再到
 * 128（幾乎一定有），最多三次嘗試就見底。
 */
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
            console.error("[why] url failed " + source + "/" + songId + " br=" + br + ": " + err.message);
        }
    }
    return null;
}

/**
 * 取可播放的音源 URL。
 * 指定子源拿不到時（GD 上游對部分曲目回空字串），用歌名+歌手到其餘子源找同一首
 * 歌再試。繁簡歸一化讓「浮誇」也能在簡體源命中。
 *
 * exclude：呼叫端已知播不出來的子源。解析成功卻在客戶端播不出來（CDN 對該地區
 * 回 403、容器格式不支援…）只有播放器知道，所以要讓它排除壞掉的子源再要一次。
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
        // 主源已用 id 直取過，不重複試
        if (candidateSource === primary && opts.id) continue;
        try {
            const list = await searchSubSource(candidateSource, keyword, 1, 5);
            for (const candidate of list.slice(0, 3)) {
                if (!candidate.id || !isSameSong(candidate, opts)) continue;
                // 跨源救援也要走同一套降級階梯，否則換了源仍卡在同一個高音質上
                const hit = await getUrlWithFallback(candidate.id, candidateSource, bitrate);
                if (hit) {
                    return {
                        url: hit.url, source: candidateSource, id: candidate.id, bitrate: hit.bitrate,
                    };
                }
            }
        } catch (err) {
            console.error("[why] fallback search failed on " + candidateSource + ": " + err.message);
        }
    }
    return null;
}

// ── 專輯 ────────────────────────────────────────────────────────────
/**
 * 網易雲的公開端點。專輯資料只有它有 —— GD 的聚合 API 完全沒有專輯類型
 * （types=album/albuminfo/albumlist 都回 "not supported"）。
 *
 * 它一個 CORS 標頭都不送，所以：
 *   有後端（網頁版）→ 走本站的 /api/proxy 代抓
 *   沒後端（App 版）→ 直接打，由播放器的沙箱用原生 HTTP 救援（見 runner.ts）
 *
 * 專輯詳情用 /api/v1/album/{id}：舊的 /api/album/{id} 現在一律回 code -462
 * 要求綁定手機，v1 那條不用。
 */
async function neteaseRequest(path) {
    const cacheKey = "netease:" + path;
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;

    /**
     * 網易雲會**隨機**拒絕請求：同一個網址連打，回應在 code 200 與 code -462
     * （要求手機驗證、資料為空、HTTP 仍是 200）之間跳。原因是出口 IP ——
     * 它標記了部分 IP，而共用出口（Cloudflare）每次請求走哪個是隨機的。
     * 實測經 CF 的成功率約四成，家用網路直連百分之百。
     *
     * 所以有後端時一律走後端的 /api/why-album*：那裡會重試到成功（六次把
     * 成功率拉到 96%）並把結果放進全站共用快取，前端只發一個請求。
     * 沒有後端（App 版）才自己直連 —— 那時用的是裝置自己的 IP，本來就不會被擋。
     */
    const data = hostHasBackend()
        ? await fetchJson(path)
        : await fetchJson("https://music.163.com" + path);
    cacheSet(cacheKey, data, TTL.playlist);
    return data;
}

/** 網易雲專輯 → MusicItem（type=album，播放器據此開專輯頁而不是直接播） */
function albumToItem(raw) {
    if (!raw || !raw.id || !raw.name) return null;
    const artists = (raw.artists || (raw.artist ? [raw.artist] : []))
        .map(a => a && a.name).filter(Boolean).join(" / ");
    return {
        id: String(raw.id),
        title: String(raw.name),
        artist: artists,
        album: String(raw.name),
        artwork: thumb(raw.picUrl || raw.blurPicUrl),
        platform: PLATFORM,
        subSource: "netease",
        // 專輯裡有幾首。使用者在搜尋結果就看得出這是單曲還是專輯
        worksNum: Number(raw.size) || 0,
        type: "album",
    };
}

/**
 * 專輯搜尋。有後端時打本站端點（後端已經歸一化好，直接用）；
 * 沒有後端則直連網易雲並自己歸一化。
 */
async function searchAlbums(keyword, page, count) {
    if (hostHasBackend()) {
        const data = await neteaseRequest(
            "/api/why-album-search?kw=" + encodeURIComponent(keyword) +
            "&page=" + page + "&limit=" + count,
        );
        return (data && data.data) || [];
    }
    const offset = (Math.max(1, page) - 1) * count;
    const data = await neteaseRequest(
        "/api/search/get?s=" + encodeURIComponent(keyword) +
        "&type=10&limit=" + count + "&offset=" + offset,
    );
    const albums = (data && data.result && data.result.albums) || [];
    return albums.map(albumToItem).filter(Boolean);
}

// ── 推薦 ────────────────────────────────────────────────────────────
/**
 * 網易雲圖床支援 ?param=寬y高 取縮圖。榜單封面原圖一張 2~3MB，一頁列表
 * 幾十張就是幾十 MB —— 光封面就能拖垮冷啟動與流量。列表縮圖 300 已夠
 * Retina 螢幕用；播放中的大圖另有 getMusicArtwork 走 pic 端點拿高清。
 */
function thumb(picUrl) {
    const url = String(picUrl || "");
    if (!url) return "";
    if (!/\bmusic\.126\.net\//.test(url)) return url;
    // 順手升 https：圖床雙協定都通，http 在網頁版是 mixed content
    return url.replace(/^http:/, "https:")
        + (url.includes("?") ? "&" : "?") + "param=300y300";
}
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
        artwork: thumb(album.picUrl),
        platform: PLATFORM,
        subSource: "netease",
        picId: album.pic_str || (album.pic != null ? String(album.pic) : ""),
        lyricId: String(track.id),
        duration: track.dt ? Math.round(track.dt / 1000) : 0,
        type: "music",
    };
}

/**
 * 一份榜單按指定順序排列。
 *   chart — 原順序（榜單自己排好的）
 *   pop   — 熱度降序；同熱度以發行時間新者優先，否則前段會擠滿一堆 pop=100
 *           的曲目而順序毫無意義
 */
function sortTracks(tracks, order) {
    if (order !== "pop") return tracks;
    return tracks.slice().sort((a, b) =>
        ((b.pop || 0) - (a.pop || 0)) || ((b.publishTime || 0) - (a.publishTime || 0)));
}

/**
 * 多種順序交錯合併、同名同歌手去重、裁到 limit。
 * 交錯而非串接：串接的話 limit 會被第一種順序吃光，第二種等於沒接上。
 */
/**
 * 輪替視窗：從整份榜單裡取哪一段。
 *
 * 榜單很少動（叱咤一週一次、網易雲日榜一天一次），但它有的歌遠比畫面顯示的多
 * （粵語 1000 首、熱門與歐美 200、其餘 100，而畫面只放 80）—— 換一段取就有
 * 新歌可看，不必等上游更新。
 *
 * 用時間分桶而不是每次隨機：同一段時間內重複開、切分類再切回來，看到的是
 * 同一批歌 —— 清單在眼皮底下跳動比「一直是舊的」更糟。15 分鐘一桶，比一次
 * 聽歌的時間長，所以一個 session 內穩定，隔一陣子再開就換一批。
 * 取到尾端繞回開頭（池子不大，不繞的話後段只會拿到半頁）。
 */
var ROTATE_BUCKET_MS = 15 * 60 * 1000;

function rotateWindow(list, limit) {
    const total = list.length;
    if (total <= limit) return list.slice(0, limit);
    const bucket = Math.floor(Date.now() / ROTATE_BUCKET_MS);
    const offset = (bucket * limit) % total;
    const out = [];
    for (let i = 0; i < limit; i++) out.push(list[(offset + i) % total]);
    return out;
}

function mergeOrders(tracks, orders, limit) {
    const buckets = orders.map(order => sortTracks(tracks, order).map(trackToItem).filter(Boolean));
    const seen = new Set();
    // 先合併**整份**榜單再輪替 —— 要換一段取，就得先有完整的池子
    const merged = [];
    const maxLen = Math.max(0, ...buckets.map(b => b.length));
    for (let idx = 0; idx < maxLen; idx++) {
        for (const bucket of buckets) {
            const item = bucket[idx];
            if (!item) continue;
            const key = normalizeName(item.title) + "::" + normalizeName(item.artist);
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(item);
        }
    }
    return rotateWindow(merged, limit);
}

/** 直連 GD 抓整份榜單再自己排序裁切。只在後端不可用時才走這條 —— 見 recommend() */
async function recommendDirect(cat, limit) {
    const data = await gdRequest("playlist", { source: "netease", id: cat.list });
    const tracks = (data && data.playlist && data.playlist.tracks) || [];
    return mergeOrders(tracks, cat.orders || ["chart"], limit);
}

/**
 * 推薦。**先問本站後端**，失敗才直連 GD。
 *
 * 這個順序與搜尋／音源相反（那些是直連優先），原因是資料量差三個數量級：
 * 榜單回應 200KB–2.4MB（叱咤903 是 1000 首／2.4MB），而後端做同一件事只回
 * 裁切後的 40 首 ≈ 15KB，而且它的 TTL 快取是全站共用的，不像瀏覽器裡這份
 * 各自算。實測直連叱咤榜在良好網路要 4.3 秒，手機網路更久 —— 而粵語是預設
 * 分頁，等於每次開 app 都先付這筆。
 *
 * 直連那條仍然留著：部署在 Cloudflare 時後端打 GD 會被回 520（GD 擋 Worker
 * 出口），那時只有瀏覽器直連能拿到資料，慢也比空白好。
 */
async function recommend(category, limit) {
    const cat = CATEGORIES[category] || CATEGORIES[DEFAULT_CATEGORY];
    const key = category in CATEGORIES ? category : DEFAULT_CATEGORY;
    // 原生 App（APK）裡沒有本站後端，跳過那一步直接走直連 —— 不然每次切分類都
    // 要先白等一個必然失敗的請求（而且 SPA fallback 會回 index.html，還得靠
    // 「回應非 JSON」才判定失敗，訊息很難懂）。
    if (!hostHasBackend()) return await recommendDirect(cat, limit);
    try {
        const data = await fetchJson(
            "/api/recommend?cat=" + encodeURIComponent(key) + "&limit=" + limit,
        );
        const list = Array.isArray(data) ? data : (data && data.data) || [];
        if (list.length > 0) return list.slice(0, limit);
        // 後端回空清單（例如它自己打不到上游）→ 當作沒有這條路，往下直連
    } catch (err) {
        console.warn("[why] 後端推薦不可用，改直連 GD：" + err.message);
    }
    return await recommendDirect(cat, limit);
}

module.exports = {
    platform: PLATFORM,
    version: "1.10.0",
    author: "musicweb",
    // 同一首歌在不同子音源的 id 不同，需連同 subSource 才唯一
    primaryKey: ["id", "subSource"],
    cacheControl: "no-cache",
    // 歌曲走 GD 聚合（netease+joox），專輯走網易雲公開端點（GD 沒有專輯類型）
    supportedSearchType: ["music", "album"],

    async search(query, page, type) {
        const p = page || 1;
        if (type === "album") {
            const albums = await searchAlbums(query, p, PAGE_SIZE);
            return { isEnd: albums.length < PAGE_SIZE, data: albums };
        }
        const list = await searchAll(query, p, PAGE_SIZE);
        return {
            // 聚合多個子音源，回傳量少於單源頁大小即視為到底
            isEnd: list.length < PAGE_SIZE,
            data: list,
        };
    },

    /**
     * 專輯曲目。回傳的是 netease 曲目，所以照現有的播放鏈路就能播 ——
     * 不需要逐首跨源比對（那才是專輯功能上次被移除的真正原因：當時唯一的
     * 專輯來源是 audiomack，它的曲目在部分地區播不出來、又無從救援）。
     */
    async getAlbumInfo(albumItem) {
        if (hostHasBackend()) {
            const data = await neteaseRequest(
                "/api/why-album?id=" + encodeURIComponent(albumItem.id));
            return { musicList: (data && data.data) || [] };
        }
        const data = await neteaseRequest("/api/v1/album/" + encodeURIComponent(albumItem.id));
        const songs = (data && data.songs) || [];
        return { musicList: songs.map(trackToItem).filter(Boolean) };
    },

    async getMediaSource(musicItem, quality) {
        // quality 直接就是 kbps 字串（見上方 BITRATES）。收到認不出的值就用預設 ——
        // 舊版 app 可能還在傳 "low"/"standard"/"super" 這種名稱。
        const bitrate = BITRATES.indexOf(Number(quality)) >= 0 ? Number(quality) : DEFAULT_BITRATE;
        const result = await resolveUrl({
            id: musicItem.id,
            source: musicItem.subSource,
            bitrate,
            // 帶上歌名/歌手，指定子音源拿不到時可跨源找同一首歌
            title: musicItem.title,
            artist: musicItem.artist,
            exclude: musicItem._exclude || [],
        });
        if (!result || !result.url) return null;
        // 回報實際使用的子源（播放器才知道下一輪該排除哪一個）與**實際**位元率
        // —— 降級之後可能不是使用者要的那一檔，下載清單要顯示真實音質。
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

    /**
     * 推薦歌曲（本專案擴充的方法）。
     * category: "hot" | "cantonese" | "cpop" | "kpop" | "western"（預設 cantonese）
     * 沒有排序參數 —— 榜單自己就是排好的，一個分類對一份榜單。
     * app 不自己打推薦端點 —— 推薦是音源的能力，沒裝音源就該沒有推薦，
     * 這樣播放器才真的與音源分離。
     */
    async getRecommend(category, limit) {
        // limit 可能被舊版 app 傳成別的東西，取不到數字就用預設，
        // 免得裁切失效、整份 1000 首榜單被塞進清單
        const size = Number(limit) > 0 ? Math.floor(Number(limit)) : 40;
        const key = category in CATEGORIES ? category : DEFAULT_CATEGORY;
        return {
            data: await recommend(key, size),
            // 讓 app 能顯示「這批歌是哪來的」而不必自己知道任何榜單
            caption: CATEGORIES[key].caption,
        };
    },

};
