# WhyMusic 音源

給 [WhyMusic](https://github.com/whypuss/musicweb) 播放器用的音源插件。

**刻意放在獨立的 repo：** 播放器本身不隨附音源、不預設任何來源、也不引用這裡的
任何檔案。它只透過插件介面問「給我一個可播的 URL」，不認識任何特定音源 ——
所以音源與播放器是兩個互不相干的東西，分開放才符合實情。

## 怎麼用

在 app 的「設置」頁貼上網址並按安裝：

```
https://raw.githubusercontent.com/whypuss/whymusic-sources/main/whymusic.js
https://raw.githubusercontent.com/whypuss/whymusic-sources/main/whymusicall.js
```

裝一次就把程式碼整份存進裝置的 localStorage，之後執行時不再回來抓 —— 換句話說
裝完就與這個 repo 無關了。代價是不會自動更新：音源改版後要重新貼一次網址。

> APK 版沒有後端可代抓，是 WebView 直接跨域抓這個網址，所以託管處必須送 CORS
> 標頭。`raw.githubusercontent.com` 會送 `access-control-allow-origin: *`。

## 這兩支是什麼

| 檔案 | 說明 |
|------|------|
| `whymusic.js` | 子音源 netease / joox，。含跨子源救援與繁簡歸一化 |
| `whymusicall.js` | 子源較多 |

兩支可以並存安裝，互不覆蓋（platform 名稱不同）。

## 插件介面

一支 CommonJS 檔案，`module.exports` 出這些方法就是一個音源（都可選）：

| 方法 | 用途 |
|------|------|
| `search(query, page, type)` | 搜尋，回 `{ isEnd, data }` |
| `getMediaSource(item, quality)` | 給一個可播的 URL，回 `{ url, source?, bitrate? }` |
| `getRecommend(category, limit)` | 推薦，回 `{ data, caption? }`。`caption` 是「這批歌哪來的」，由音源自報 |
| `getLyric(item)` | 歌詞 |
| `getMusicArtwork(item, size)` | 封面 |

`quality` 是使用者選的 kbps 字串；`bitrate` 要回**實際**用到的那一檔（音源降級時
不等於使用者要求的值，app 的下載清單顯示的是這個）。

載入時跑在 `new Function` 的沙箱裡：只有 `fetch`、計時器、`URL`、`btoa`/`atob`、
`console`，**沒有任何 npm 模組**。要什麼自己用 `fetch` 實作。
