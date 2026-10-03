# 模型榜

模型榜只对 AI 行业有意义。别的行业在 `industry/features.ts` 里关掉即可，见[定制方法](customize.md#6-ai-模型榜industryfeaturests)。

## 模型榜（`/leaderboard`）

把多家公开评测（Artificial Analysis、LMArena、LiveBench、Epoch、EQ-Bench、Vals 等）的成绩放在一起，算出一个尽量不和已知成绩冲突的完整排名，另有编程、推理、知识等分类榜。方法对读者公开：

- `/leaderboard/rules`：排名怎么算（共识方法 v15，加权不完整 Kemeny 排序）。
- `/leaderboard/sources`：每个评测来源测什么、状态如何、是否参与排名。

**更新**：每天 02:05、08:05、14:05、20:05 检查一遍所有上游。某个来源抓取失败时沿用它上一份快照；只有证据真的变了，才发布新的一轮。新装好的站在 worker 第一次启动时会立刻算一轮。

**需要的 key**：

- `ARTIFICIAL_ANALYSIS_API_KEY`：Artificial Analysis 这一项要它自己的 key。没有时这一项不参与，它的份额空着，不转给别的评测，所以榜单会和 AIHOT 的不一样。
- `GITHUB_TOKEN`（可选）：只读 token，提高读 GitHub 的配额。

**模型名录**：模型的显示名、厂商、发布日期，以及每家评测对同一个模型的不同叫法，放在 `database/seeds/` 的模型名录里，首次启动时导入（`scripts/seed.ts`）。这样新站抓到的成绩会归到和 AIHOT 一样的模型上。名录里没有的新模型，会按评测给出的名字自动建立，名字和厂商可能不够规整。

**价格**：表格里的官方 API 价格来自 `database/seeds/` 里的价格文件，每次刷新会给还没有价格的模型补上。厂商调价或者上了新模型，改这个文件后运行：

```bash
node --env-file=.env scripts/import-leaderboard-prices.ts
```

**代码**：

| 位置 | 内容 |
|---|---|
| `packages/backend/src/leaderboard/source-registry.json` | 评测来源登记：分组、状态、份额、说明 |
| `packages/backend/src/leaderboard/fetch/sources/` | 每个上游一个读取器 |
| `packages/backend/src/leaderboard/method/` | v15 的计算（`v15.ts`、`kemeny.ts`） |
| `apps/web/app/features/leaderboard/`、`apps/web/app/routes/leaderboard*.tsx` | 页面 |

**工具**：

```bash
node --env-file=.env scripts/lb-round.ts --fetch      # 立刻抓一遍并算一轮
node --env-file=.env scripts/lb-fetch-check.ts        # 只抓不写，和已存的快照逐行对比，检查读取器
```

**改方法**：`v15.ts` 里的每个常数都是方法的一部分，改了会改变读者看到的排名。改方法时，把 `/leaderboard/rules` 页面上的文字一起改掉，并升方法版本：页面上写的必须和实际算法一致。
