# 行业包

这个站和“行业”有关的一切都在这里。当前默认 MyHOT 配置覆盖五个领域；换成你的行业，主要就是改这个文件夹，步骤见 [把它改成你的行业](../docs/customize.md)。

`taxonomy.ts` 中的 `DOMAINS` 是领域名称和 key 的 owner；类别是另一套独立维度。`all` 仅作概览和报告范围，不是文章领域。逐篇归属及信源覆盖范围的区别见[架构说明](../docs/architecture.md)。

| 文件 | 内容 |
|---|---|
| `site.ts` | 站名、行业词、首页文案、关于页、备案号 |
| `taxonomy.ts` | 领域词表、分类、标签、公司与机构，以及防止模型写错公司的词表 |
| `topics.json` | 主题目录（`/topics`） |
| [`sources.json`](sources.json) | 首次导入的信源及其配置；列表和 URL 只维护在此文件 |
| `prompts/` | 每一步的提示词：预筛、评分、写作、结构化、归组、综述、日报、翻译 |
| `selection.ts` | 入选门槛 |
| `features.ts` | 模型榜、Codex 重置监控的开关 |
| `brand/` | 图标、Logo、日报周报月报的报头字 |
| `pages/` | 使用规则、隐私说明（模板，上线前按实际情况改写） |
| `changelog.json` | 更新日志 |
| `gold.example.jsonl` | 精选评测样本的格式示例 |
