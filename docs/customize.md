# 把它改成你的行业

这份仓库当前开箱配置是站名为 MyHOT 的五领域站，保留了原有 AI 配置，并加入医疗、法律、军事和政策领域。精选标准、门槛和模块仍是共享配置；领域筛选质量的校准边界见 [精选与校准](selection.md)。要把它收敛为“法律热点”“HR 热点”“黄金热点”等单一行业站，要改的内容仍主要在 [`industry/`](../industry/)；先确认使用者自己的信源、重要性标准和分类，不要替他决定。

如果你用 Claude Code、Codex 这类 Agent，可以把下面这段直接发给它，然后回答它的问题：

```text
请读 AGENTS.md 和 docs/customize.md，把这个站改成「XX 行业」的热点站。
我关心的是：……（写你想盯的信源、你觉得什么消息重要、什么不重要，越具体越好）。
改完帮我跑 npm run typecheck、npm test 和 node scripts/smoke.ts，并告诉我还需要我自己决定哪些事。
```

下面是它（或者你）要做的事，按顺序。

## 1. 站名和文案：`industry/site.ts`

- `name`：站名。导航、标题、分享图、RSS、MCP、后台都用它。
- `subject`：站点概览使用的行业词；当前多领域 MyHOT 留空。各领域页面的名称来自 `taxonomy.ts` 的 `DOMAINS`，改站点概览词不会改领域归属。
- `homeTitle`、`description`、`tagline`：首页标题、一句话介绍、侧边栏小字。
- `mcpPrefix`：MCP 工具名前缀，比如 `lawhot` 会得到 `lawhot_get_latest`。
- `crawlerName`：抓取信源时报的名字，别用别人的站名。
- `ABOUT`：关于页的大标题、四个环节的说明、作者块（可选）、版权说明。
- `icp`：中国大陆网站的备案号，填了就显示在页脚。

站点地址不写在这里，部署时用环境变量 `SITE_URL` 设置。

## 2. 分类、标签和主题：`industry/taxonomy.ts`、`industry/topics.json`

- `DOMAINS`：领域名称、稳定 key、`enabled` 和判断指南 `guide` 的 owner；文章可以涉及多个领域。`all` 只表示概览或报告 scope，不是文章领域。每个领域的 `columns` 配置精选与动态的子栏目，`key` 标识展示入口，`label` 是显示名，`filters` 组合现有 `category`、`tag`、`channel` 筛选。概览和 AI 复用 `DEFAULT_COLUMNS`；领域及子栏目名单以 [`taxonomy.ts`](../industry/taxonomy.ts) 为准。
- `CATEGORIES`：类别与领域是独立维度。`key` 是网址和接口里的身份；`label` 用于卡片与默认子栏目；`section` 是日报里的分节；`guide` 告诉模型怎么归类。改变子栏目名称或顺序不需要重分析文章、重建数据或修改报告分节。
- `CATEGORY_TAGS`、`TOPIC_TAGS`、`ENTITY_TAGS`：模型打标签时只能从这里选。第一个标签必须是“分类标签”。
- `ENTITIES`：行业里的主要公司或机构，用于“公司”类主题页。`IDENTITY_LEXICON`、`PUBLISHER_DOMAINS` 用来防止模型在标题摘要里写进原文没提到的公司，别的行业没有这个需要可以清空。
- `ITEM_TYPES`：内容类型，和评分提示词里的权重表对应，改了要一起改提示词。
- `topics.json`：主题目录（`/topics`）。分三组：`company`（公司与机构）、`field`（方向）、`genre`（内容形态）。每个主题用 `tags` 或 `entityId` 决定收哪些内容。`slug` 是主题页路径的身份。

### 领域新增与停用

新增领域时，在 `DOMAINS` 增加唯一稳定 `key`、`label`、`enabled: true`、文章判断 `guide` 和子栏目 `columns`，再配置对应信源与词表。预筛、评分和写作的读者范围、结构化领域、导航、报告调度、MCP 和运行时 OpenAPI 都从这份配置派生；不用修改业务代码或数据库枚举。新领域的质量仍须按[校准流程](selection.md)准备人工样本，不沿用其他领域的合格结论。

停用时保留原条目，把 `enabled` 设为 `false`：当前导航与新报告调度不再包含该领域，结构化模型不再给新分析标注该 key。覆盖范围非空且不含任何启用领域的信源停止自动采集；空覆盖范围不代替文章判断，有启用领域时仍可采集。全部领域停用时自动采集关闭。后台试抓和手动抓取仍是管理员的显式动作。

历史文章、人工纠正、报告、同步 payload 和已有领域 URL 保留原身份，仍可读取；不批量改写历史归属，不删除或重命名曾使用的 key。浏览器中已停用的偏好暂不用于生成全局导航，也不删除原值；重新启用可继续使用。

配置随应用构建加载。更改后运行类型检查、测试和 Web 构建，按[部署流程](deploy.md)让 API、worker 与 Web 使用同一份配置；worker 启动时同步并取消已经停用的报告计划。重新启用使用原 key，按现有补报窗口恢复生产，不建立第二套生产流程。

改完主题后运行 `node --env-file=.env scripts/seed.ts`（Docker 里会在启动时自动运行），主题会更新进数据库。

## 3. 信源：`industry/sources.json`

这是首次启动时导入的信源，已经存在的不会被覆盖；完整配置和 URL 以 [`industry/sources.json`](../industry/sources.json) 为准，不在文档中复制名单。上线后更常用的是后台“信源”页：能新建、试抓、调频率、看失败原因。信源覆盖范围和文章领域归属的关系见[信源文档](sources.md)与[架构说明](architecture.md)。

每个信源的关键字段：

| 字段 | 含义 |
|---|---|
| `kind` | `rss`、`web_list`（网页列表，配选择器）、`json_list`（JSON 接口）、`x_search`（X 账号，需要 SocialData）、`mp_account`（公众号，需要极致了）、`external`（外部推送） |
| `config` | 每种信源的配置，见 [信源](sources.md) |
| `tier` | 信源分级：`T1` 官方一手、`T1_5` 官方账号与准官方、`T2` 媒体与个人、`EXCLUDE_MP` 不参与精选。不同分级的入选门槛不同 |
| `participation_mode` | `editorial` 进精选和全部动态；`hot_signal` 只作热度证据；`isolated` 不进任何公开页面 |
| `first_party` | 是不是当事方自己发的（官网、官方账号） |
| `site_fulltext` | 站内能不能展示全文。**默认关**：只展示摘要和原文链接。只有来源明确允许时才打开 |

中国大陆的很多行业，一手信息在公众号上。公众号信源需要极致了（Dajiala）的 key，按请求计费，有预算熔断。

## 4. 精选标准：`industry/prompts/`

这是最值得花时间的一步：你的行业 KnowHow 就写在这里。

| 文件 | 作用 |
|---|---|
| `prefilter.md` | 预筛：这条资料是不是这个行业的事。宽召回，只拦明显无关的 |
| `selection-score.md` | **评分标准**：给 0–100 分。里面有内容类型、五个维度、各类型的权重、必须正常评价的价值、必须压住的噪声 |
| `content-understanding.md` | 入选内容的写法：中文标题、答案先行的摘要、推荐理由、标签 |
| `rules-domain.md` | 行业术语的翻译与保留规则（示例是 AI 术语：LLM 译作大语言模型、Token 保留英文……） |
| `summarize-*.md` | 其他内容的标题摘要写法 |
| `structure.md` | 按文章内容判断领域，并抽取分类、标签、主体公司和事实 |
| `group-*.md` | 事件归组：两篇报道是不是同一件事 |
| `story-digest.md`、`report-*.md` | 事件综述、日报导语、周报月报 |
| `translate-*.md` | 全文翻译 |

提示词里用 `{{siteName}}` 指代站名，`{{domainNames}}` 与 `{{domainGuide}}` 来自启用领域配置，`{{> 文件名}}` 引用另一份提示词。改提示词不用改代码。

**建议的做法**：先保留结构（五个维度加权、噪声压制规则、安全边界），只把“什么算重要”“什么算噪声”的例子换成你的行业。比如法律行业，“新法规正式公布、重要判决、监管处罚”应该正常评价，“律所营销软文、课程广告”要压住。

## 5. 门槛与校准：`industry/selection.ts`

门槛和五维权重由 `industry/selection.ts` 共享管理。需要调整时，按 [精选与校准](selection.md) 确认当前校准边界，再准备标注样本、运行评测并检查错例；不要凭感觉改数字。

## 6. 品牌：`industry/brand/`

- `logo.svg`、`icon.png`（512）、`icon-192.png`、`apple-icon.png`（180）、`favicon.ico`：站点图标。
- `nameplates/`：日报、周报、月报页顶部的报头字（比如“AI日报”）。换了行业词以后重新生成：
  ```bash
  npm pack @fontsource/noto-sans-sc@5.3.0 && tar xzf fontsource-noto-sans-sc-5.3.0.tgz
  node scripts/nameplates.ts package
  ```
- 关于页的二维码：在后台“设置”里上传，或者把图片放进 `industry/brand/contact/`。
- 网页左上角的站名标志在 `apps/web/app/components/Logo.tsx`，默认用站名文字；有自己的 Logo 可以换成图片。

请不要使用 AIHOT 的名字和 Logo。

## 7. 页面文案：`industry/pages/`、`industry/changelog.json`

- `pages/terms.md`、`pages/privacy.md`：使用规则和隐私说明。**现在是模板**，上线前按你的实际情况改写，必要时请专业人士看一下。
- `changelog.json`：更新日志。新条目写在最前面，把 `latestVersion` 改成它的日期和时间。

## 8. 模型和部署

- 模型：`.env` 里的 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，任何 OpenAI 兼容接口都行，所有步骤默认都用它。想让某一步用别家模型，见 `.env.example`。
- 部署：见 [部署](deploy.md)。

## 改完以后检查

```bash
npm run typecheck
DATABASE_URL=postgres://…/myhot_test npm test     # 库名必须以 _test 或 _ci 结尾
node scripts/smoke.ts --base http://localhost:3000   # 站点跑起来以后
```

`tests/` 里有些测试用的是示例行业的分类、标签和公司（比如 `ai-models`、“模型发布”、Anthropic）。改了 `industry/taxonomy.ts` 以后这些测试会失败，把例子换成你行业里的对应项即可，测的规则本身不用改。

然后打开网站看一眼首页、全部动态、日报和关于页，再去后台“信源”页看信源是不是都抓成功了。
