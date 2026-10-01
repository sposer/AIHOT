# 信源

信源在后台“信源”页管理：新建、试抓一次看看抓到什么、改频率、启停、看失败原因和最近的条目。首次启动时，`industry/sources.json` 里的示范信源会被导入。

## 创建时确定获取策略

`industry/sources.json` 和后台新建页使用同一套信源模型。创建时就确定：

- `kind` 和类型专属地址或查询参数
- `interval_minutes` 抓取间隔
- `config` 中的请求方法与请求头、列表解析规则、详情页补抓、`fetchPublicContent` 正文抓取、URL 允许或拒绝前缀、排序和噪声过滤
- `participation_mode`、分级、标签，以及站内和联合输出是否允许全文

之后可以在后台修改、试抓和手工强制抓取。每种 `kind` 支持的 `config` 项以 `packages/backend/src/sources/config-keys.ts` 为准；不认识的配置在保存和抓取边界都会明确拒绝，不会退回通用解析。

## 六种信源

| 类型 | 适合 | 需要 |
|---|---|---|
| `rss` | 有 RSS / Atom 的博客、媒体、Substack、公众号转 RSS 服务 | 无 |
| `web_list` | 没有 RSS 的网页列表（新闻页、博客列表、更新日志） | 写选择器；抓不到时可以经 Jina Reader 渲染（按次计费） |
| `json_list` | 返回 JSON 的接口（GitHub Releases 等） | 写字段路径 |
| `x_search` | X（推特）账号 | SocialData 的 key，按请求计费 |
| `mp_account` | 微信公众号 | 极致了（Dajiala）的 key，按请求计费 |
| `external` | 你自己的脚本推送进来的内容 | `INGEST_TOKEN`，见下文 |

### rss

```json
{ "feedUrl": "https://example.com/feed.xml" }
```

RSS、RDF 的 `content:encoded` 和 Atom 的 `content` 默认作为正文候选；只给摘要的订阅设置 `contentIsBody: false`，这些字段保留为 `excerpt`，不把文章标记为已取得正文。Nature Medicine 的订阅使用这一配置；全文通过原文页面的既有提取任务取得，再以新 revision 进入分析，不靠字段名或摘要长度推断全文。

`summaryIsBody: true` 表示 RSS 的 `description` 本身就是全文，默认关闭。`fetchPublicContent: true` 请求补抓缺失正文，不会替换已经确认的完整订阅正文；它与站内、对外的全文展示许可独立。`allowCategories` / `denyCategories` 按订阅里的分类过滤。

### web_list

```json
{
  "url": "https://example.com/news",
  "itemSelector": "article",
  "linkSelector": "a",
  "titleSelector": "h2",
  "publishedAtSelector": "time"
}
```

- `parseMode`：`html`（默认，用选择器）、`markdown`（经 Jina 渲染后按 Markdown 读）、`docusaurus_changelog`。
- `detail`：列表缺日期、标题或摘要时抓详情页补齐（`publishedAtSelector`、`titleSelector`、`summarySelector` 等）。
- `allowUrlPrefixes` / `denyUrlPrefixes`：只收某些路径下的文章。

### json_list

```json
{
  "url": "https://api.example.com/releases",
  "itemsPath": "items",
  "titlePaths": ["name"],
  "publishedAtPath": "published_at",
  "urlTemplate": "https://example.com/releases/{id}"
}
```

默认发 GET；需要 POST 时可设置 `method`、`headers` 和 `bodyJson`。用字段路径、过滤条件与 URL 模板把接口记录转换成条目。

### x_search

```json
{ "query": "from:SomeAccount -filter:replies" }
```

普通账号会被自动合并成一次搜索（每次最多二十几个账号），省请求数。

### mp_account

```json
{ "ghid": "gh_xxxxxxxx", "nickname": "公众号名称" }
```

每个公众号按它的抓取间隔检查一次（查列表按次计费），新文章的正文一并取回。

## 网络出口与复杂站点

`EGRESS_PROXY_URL` 是整个部署唯一的固定出站代理，适合解决服务器到海外公开内容的网络可达性。RSS、网页和 JSON 采集、正文与图片下载、模型榜数据及 Jina Reader 请求共用它和现有连接池；模型 API 不经过它，SocialData 与极致了调用保持 `direct` 路由。系统不读取代理列表，也不会逐请求更换 IP。

先按下面的边界选择采集方式：

1. 有稳定 RSS、公开网页列表或 JSON 接口：直接配置对应 `kind`，让条件请求、按域名并发和退避生效
2. 公开页面必须渲染后才能得到稳定列表或详情：使用 Jina；它按请求计费并继续经过回执与预算
3. 需要站点专属登录态、浏览器交互、多步请求，或内置配置无法稳定表达：在独立采集器里完成这些步骤，再通过 `external` 接口推送规范化条目

默认不提供代理池。信源级策略、条件请求、同域名限流与 `Retry-After` 已负责降低请求量和控制重试；轮换出口会让 403、429、超时和慢请求难以归因，也不能替代 Jina、授权访问或站点专属采集逻辑。确实需要特殊网络身份的来源，应由拥有该授权的 external 采集器单独负责，不把轮换逻辑扩散到公共采集链。

## 分级、参与方式与全文

- **分级** `tier`：`T1` 官方一手（官网、官方博客、机构）、`T1_5` 官方账号与准官方创作者、`T2` 媒体与个人、`EXCLUDE_MP` 不参与精选。入选门槛按分级不同（`industry/selection.ts`）。
- **参与方式** `participation_mode`：`editorial` 进精选和全部动态；`hot_signal` 不单独展示，只作为“大家在讨论什么”的热度证据；`isolated` 不进任何公开页面。
- **一手** `first_party`：来源是当事方自己。事件页会优先展示一手报道。
- **全文**：`site_fulltext` 决定站内能不能显示全文，`syndicate_fulltext` 决定全文 RSS 能不能带正文。两者**默认都关**，只显示摘要和原文链接；来源明确允许时再打开。公众号、付费墙内容不会因为技术上抓得到就获得全文展示。

## 抓取频率

每个信源有自己的抓取间隔。每天 04:20 会按近 7 天的产出自动调整：产出多的抓得勤，最短 15 分钟；免费信源最长 60 分钟，按次计费的信源最长 120–180 分钟。

同一目标域名的普通请求在进程内限制并发，并在最短间隔上增加可配置的随机抖动；远端对 429 或 503 返回 `Retry-After` 时，该域名的后续请求会等待，RSS、Web、JSON 与 X 的信源调度把它作为最低等待时间且不会缩短原有连续失败退避。详情页按 `detail.maxFetches` 限制每轮总数，并用小并发读取。RSS、Web、JSON、X 和公众号的采集记录共用 HTTP 观测，显示目标域名、`direct` / `egress` 路由、是否经过固定代理、请求数、流量、状态码、排队时间、最慢请求和错误类别。DNS 检查失败或超时也会记录目标和耗时；复用付费回执而没有新网络请求时，不会产生虚构的 HTTP 记录。

直连 RSS、直连网页 GET、无请求体的 JSON GET 会保存 `ETag` / `Last-Modified`，内容未变化时远端返回 304，本轮不重复下载和解析。首次导入完成前不会保存验证器，避免首轮回灌上限导致余下条目永久漏采；Jina 和非 GET 请求不使用这套条件请求。

抓取失败不推进位置，下次从同一处继续；连续失败的信源在后台标红，每周一会在运营群发一份信源周报（配置了飞书内部群时）。

## 规则：旧文不刷屏

首次发现时原文已经发布超过 48 小时的资料、新信源第一次导入的存量条目、标记为回灌的推送，都按原文时间归档：不进入“今天”，也不推送。这条规则所有入口共用，防止一次性导入历史内容刷屏。

## 外部推送接口

自己写脚本抓的内容，可以推进站里，走和普通采集一样的判重、精选和归组。

```
POST /api/ingest/items
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

{
  "sourceId": "my-crawler",
  "sourceName": "我的抓取脚本",
  "items": [
    { "title": "必填", "url": "必填", "publishedAt": "2026-10-01T08:00:00+08:00", "author": "可选" }
  ]
}
```

- `INGEST_TOKEN` 在 `.env` 里设置，至少 16 位；不设置时接口一律返回 401。
- 每次最多 50 条；每个客户端每分钟最多 10 次。
- 返回 `{"ok": true, "created": <新建条数>}`。缺标题或网址的条目会被跳过，同一请求里重复的网址只取第一条。
- `sourceId` 不存在时会自动建一个 `external` 信源，默认不进公开页面：到后台把它的参与方式改成 `editorial` 才会出现在站上。
- 条目的 `raw._aihot.backfill` 为 `true` 时按历史回灌处理（不进入“今天”、不推送）。
