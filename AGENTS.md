# 给 Agent 的说明

这是一个行业热点网站框架；当前默认站名为 MyHOT，开箱配置覆盖五个领域。先读 [README](README.md)，再按任务读 `docs/` 中的 owner 文档。定制顺序见 [docs/customize.md](docs/customize.md)。

## 行业边界

- 行业配置归 `industry/`：站名文案、领域与分类、主题、信源、提示词、门槛、模块、品牌和条款页。换行业通常不需要改 `apps/` 或 `packages/`。
- 站名、信源、重要与噪声标准、分类，以及使用规则和隐私内容由使用者决定；不要代替使用者拍板。
- 保留既有评分结构、共享权重和门槛，不凭感觉改数值；领域筛选质量的校准边界与流程见 [docs/selection.md](docs/selection.md)。
- 逐篇 `domains[]` 来自结构化分析或人工 override；信源 `domains` 仅表示覆盖范围，不能作为文章领域回退值。`all` 是概览/报告范围，不是文章领域。完整契约见 [docs/architecture.md](docs/architecture.md)。

## 工程边界

- 项目当前处于开发阶段，仓库内契约按当前支持状态一次性替换，生产发布仍须单独授权。改动须覆盖定义、生产者、消费者、生成产物、测试与文档；同步删除被替代的路由、别名、格式、转换和兜底，不因旧实现或旧测试保留第二条路径。兼容仅用于任务明确要求或已核实的仓库外独立消费者、持久化用户数据边界，并在该边界声明支持状态、迁移动作及移除条件。
- Web 只通过 HTTP 读取 API；数据库、模型调用和密钥留在后端。所有公开出口共用 `packages/backend/src/publication/` 读取层。
- 读者请求不触发模型调用；付费请求必须经过回执和预算熔断。未知回执的恢复归 `docs/architecture.md` 中的回执边界。
- 开发和测试默认关闭 `COLLECT_ENABLED`、`MODEL_CALLS_ENABLED`、`FEISHU_CONTENT_PUSH_ENABLED`、`FEISHU_INTERNAL_ENABLED`、`INDEXNOW_SUBMIT_ENABLED`；测试不访问外部服务。需要验证模型链路的测试只在隔离测试运行器中开启 `MODEL_CALLS_ENABLED`，供应商连接指向本地 stub，不加载真实凭据，其余外部动作保持关闭。
- 信源默认只公开摘要和原文链接；只有来源明确允许时才启用 `site_fulltext`。公开内容对管理员和访客一致，后台只允许管理员。
- 数据库只走 [docs/deploy.md](docs/deploy.md#数据库初始化与迁移) 定义的基线和增量迁移边界。使用规则和隐私说明由站点运营者确认。

## 检查与交付

- 使用 Node.js 26.12.1+ 直接运行 TypeScript，项目依赖由 npm workspaces 管理。
- 改完必须运行类型检查、完整后端测试、Web 构建及 Web 测试，并在站点运行后执行 smoke。实际命令以根目录及 workspace manifests 为准；操作流程见 README 和 [docs/deploy.md](docs/deploy.md)。
- 验证受影响的重要行为；测试数据库名须以 `_test` 或 `_ci` 结尾。改行业词表时，同步更新使用示范行业数据的测试样例。
- 匹配周围代码风格，保持改动最小；不为简单样式改动加测试。不要提交 `.env`、密钥或 `.data/`，不要把 AIHOT 的名字或 Logo 用作站点品牌。
