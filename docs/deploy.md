# 部署

## 用 Docker（推荐）

需要一台装了 Docker（带 Compose）的机器。云服务器建议至少 2 核、4 GB 内存，构建镜像时要用到。

```bash
git clone https://github.com/KKKKhazix/AIHOT.git myhot
cd myhot
node scripts/init-env.ts --llm-key <你的模型 API Key>
docker compose up -d --build
```

`init-env.ts` 会生成 `.env`，填好随机密钥和管理员密码，并把密码打印一次。机器上没有 Node 的话，把 `.env.example` 复制成 `.env`，自己填 `ADMIN_PASSWORD`（至少 12 位）、`SESSION_SECRET`、`IMG_PROXY_SIGN_SECRET`、`POSTGRES_PASSWORD`（各用 `openssl rand -hex 32` 生成）和 `LLM_API_KEY`。

启动后打开 `http://服务器地址:3000`，后台在 `/admin`，用管理员密码登录。第一次启动会导入示范信源，一两分钟后开始出现内容；第一次导入的一百多条资料大约半小时处理完（每条都要预筛、评分，入选的还要写标题摘要）。

`docker compose` 会起五个容器：`db`（PostgreSQL 17）、`setup`（每次启动先跑数据库迁移和种子数据，然后退出）、`api`、`worker`（抓取、模型处理、定时任务）、`web`（网页）。

### 镜像发布与部署

源码仓持有应用构建，发布方在持有镜像的本机 Docker 上推送仓库，部署主机从仓库拉取运行，不搬运镜像包。`docker-compose.yml` 只定义镜像运行；源码目录的 `docker-compose.override.yml` 自动添加本地构建配置，不交给部署主机。

构建机需要 Node.js 24.11 以上、Git、tar 和 Docker。以下命令构建选定的已提交应用代码，镜像标签含构建时间及提交号；部署文件采用本仓库当前的运行契约：

```bash
npm run image:build -- --repository registry.example/myhot --ref HEAD
```

脚本只构建应用镜像。PostgreSQL 和可选 HTTPS 的 Caddy 保持原版，已有的目标平台镜像只重打私有仓库标签；本机缺少对应镜像时才拉取。三个本机镜像及消费文件就绪后交给发布方，构建脚本不推送、不导出镜像归档。`--platform` 默认为 `linux/amd64`，可以指定目标平台。

消费文件位于 `.data/releases/`，包含 `images.env`、`docker-compose.yml`、`.env.example` 和 `deploy/`，不包含本机 `.env`。发布方在同一本机 Docker 上执行三个镜像的 `docker push`，用 `docker buildx imagetools inspect` 核实仓库顶层摘要；`images.env` 保留构建脚本生成的唯一版本 tag 后交付部署主机。摘要记录在发布结果中用于核验，不追加到运行引用。发布与部署由消费侧的运维流程管理，源码仓不维护第二套发布所有者。

决策记录：decision: 运行引用使用包含构建时间和提交号的唯一版本 tag，仓库摘要仅用于发布核验; not 在 `images.env` 追加 `@sha256` because 当前部署不需要摘要约束

首次部署把这组消费文件放进独立服务目录，不复制源码构建覆盖文件。先拉取三个私有镜像，再生成本实例的随机密钥和管理员密码，无需在部署主机安装 Node：

```sh
. ./images.env
for image in "$APP_IMAGE" "$DB_IMAGE" "$CADDY_IMAGE"; do docker pull "$image"; done
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/settings" -w /settings \
  "$APP_IMAGE" node /app/scripts/init-env.ts
```

配置生成的 `.env`：按实际入口设置 `SITE_URL`、`PORT` 和模型的 `LLM_*`。使用其它网关时按其契约设置 `LLM_EXTRA_JSON`，通用配置可用 `{}`。首次检查时关闭采集、模型调用和外部推送，确认运行正常后再启用所需能力。

```sh
docker compose --env-file .env --env-file images.env config --quiet
docker compose --env-file .env --env-file images.env up -d --no-build
docker compose --env-file .env --env-file images.env exec -T web \
  node scripts/smoke.ts --base http://localhost:3000
```

后续更新重复构建和发布。新输入就绪后替换 `docker-compose.yml`、`images.env`、`.env.example` 和 `deploy/`，再执行拉取、启动及验证命令；不覆盖本实例的 `.env`，不删除数据卷。部署过程确需临时恢复文件时只在当次更新未完成期间使用，验证通过后清理，不在生产长期保留回退目录。数据库变更仍遵循下面的迁移边界，不把镜像切换视为数据回退。

### 数据库初始化与迁移

新库由 `database/migrations/0001_core.sql` 直接建立完整应用结构和默认预算。行业主题、示范信源和模型目录由 `scripts/seed.ts` 独立导入；pg-boss 的队列表由它自己在 `pgboss` schema 中管理。

`scripts/migrate.ts` 按编号顺序执行 SQL，每份迁移和它的 `schema_migrations` 记录在同一事务中提交，已执行的文件不会重跑。`setup` 完成迁移和 seed 后，API 和 worker 才启动。

首次真实部署后固定初始基线，后续数据库变更只在 `database/migrations/` 末尾按编号追加增量迁移；变更的当前应用契约与迁移一起部署，不修改已执行的基线。

`0003_remove_monitor.sql` 删除重置监控的四张专属表、专属模型设置及旧告警状态，不修改模型榜和通用运维功能。付费调用、内容投递回执和审计记录保留在共享历史表中，仍按[回执边界](architecture.md#几条不变的规则)处理。部署方须在升级前停止旧 API 和 worker，并为监控数据保留升级前数据库快照；运行 setup 和新应用后，worker 的调度同步会取消旧监控任务。专属监控数据随迁移删除；若要恢复，必须在当次更新验证完成前同时恢复快照和旧应用。验证成功后清理当次快照。

`0002_domains.sql` 将既有信源、分析、公开投影及精选同步 payload 一次性赋为 AI；文章 ID、现有 revision、事实和故事 ID 保持不变。新分析按 `input_revision` 产出文章领域，人工纠正由 editorial override 持有。信源的 `domains` 只说明覆盖范围，不决定文章归属。日报、周报和月报改为 `(kind, scope, key)` 唯一身份：既有报告属于 `ai`，历史修订仍通过原 `report_id` 关联；`all` 概览不复制 AI 报告，由同一报告生产与补报路径独立生成。迁移不修改 `0001_core.sql`；完成后应用只读写这一套契约，不保留 runtime fallback，报告详情使用 `/:kind/:scope/:key`。

部署这次变更前由部署方暂停旧 API 和 worker，在当次更新期间保留数据库快照，再执行 setup、新应用及验证。验证成功后清理该次快照，不长期保留生产回退目录。若验证完成前需要退回旧应用，必须同时恢复部署前数据库快照和上一版消费文件，不能只换回旧镜像：旧应用只认识 `(kind, key)`，无法正确处理迁移后的多范围报告。恢复快照会舍弃快照之后的写入，部署方应先保留这段数据供核对。

`0004_configurable_domains.sql` 解除信源、分析、公开投影和报告内固定五领域的数据库约束，领域合法身份统一由行业 taxonomy 的应用边界验证；不修改存量行、文章 revision、报告 ID 或同步 ledger。新增与停用领域按[定制流程](customize.md#领域新增与停用)操作，不为每次配置变化另加数据库枚举迁移。升级由部署方停止旧 API 和 worker、执行 setup，再启动消费同一份配置的新应用；已有历史 key 不删除、不重命名。

`0005_selectbench_domains.sql` 为逐条评测结果增加人工领域数组，历史结果保持未标注的 `[]`，不按信源覆盖或模型结果补填。随当前评测代码通过 setup 应用；领域金标、统计状态及历史报告的使用边界见[精选与校准](selection.md#校准)。

升级后的短暂排行窗口由已有任务自然收敛：旧应用写入的 `hot_rankings` 快照只存全球 Top 10，更新后领域视图先从该旧快照中筛公开成员；同一现存排行任务下一次计算才会把所有全球达标候选写入快照，之后各领域即可从完整候选中过滤、选代表并取 Top 10。无需兼容代码、额外迁移或新增刷新机制。

### 在中国大陆的服务器上

- 构建时 npm 走国内镜像：`docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`，然后 `docker compose up -d`。
- 拉取 Docker 镜像慢，先给 Docker 配置镜像加速。
- 海外公开内容抓不到时，在 `.env` 里设置唯一的固定出口 `EGRESS_PROXY_URL`；精确路由范围、Jina / external 的选择边界和不提供代理池的原因见[信源文档](sources.md#网络出口与复杂站点)。
- 对外提供网站服务需要先完成 ICP 备案，备案号填在 `industry/site.ts` 的 `icp`。

### 配域名和 HTTPS

先把域名解析到服务器，然后在 `.env` 里设置：

```bash
SITE_URL=https://example.com
SITE_DOMAIN=example.com
PORT=127.0.0.1:3000        # 3000 端口只给本机的 Caddy 用，不直接对外
TRUST_PROXY=true           # 访客地址从 Caddy 转来的请求头里读
```

再用带 HTTPS 的方式启动，Caddy 会自动申请和续期证书：

```bash
docker compose --profile https up -d --build
```

已经有 Nginx 的话，不用 Caddy，把站点反向代理到 `http://127.0.0.1:3000`，带上 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`，并在 `.env` 里设 `TRUST_PROXY=true`。`SITE_URL` 一定要写成读者实际访问的地址：生成的链接、RSS、分享图和 MCP 都用它。

### 更新

```bash
git pull
docker compose up -d --build
```

更新时由 `setup` 自动执行[数据库迁移](#数据库初始化与迁移)。

### 备份

在 `.env` 里配置 `DB_BACKUP_STORE_*`（任何 S3 兼容的对象存储），每天 04:10 自动备份到那里。也可以手动导出：

```bash
docker compose exec -T db pg_dump -U aihot aihot | gzip > myhot-$(date +%F).sql.gz
```

数据都在三个 Docker 卷里：`db`（数据库）、`data`（上传的图片、图片缓存、本地备份）、`caddy`（证书）。`docker compose down` 不会删除它们；`docker compose down -v` 会。

### 看日志

```bash
docker compose logs -f --tail 100 api worker web
```

后台的“运行”页能看到每个定时任务最近的结果，“信源”页能看到每个信源的抓取状况。

## 花多少钱

- **模型**：每条新资料至少预筛一次；可能入选的再评分两次，入选的还要写标题摘要、打标签、归组，另外还有日报和事件综述。我们用示范信源在本地试跑，第一次导入的 152 条资料一共用了大约 930 次模型调用。之后每天用多少，取决于你的信源每天更新多少条。后台“模型与评测”页能看到每一步的调用次数和输入输出 token 数。
- **付费采集**（X、公众号、Jina）：按请求计费，默认不启用，填了 key 才会用。
- 所有付费服务都有每分钟、每小时、每天的调用上限（后台“设置 → 预算”），超过就暂停，不会一夜之间刷爆账单。填 0 表示立即停用这个服务。

## 不用 Docker

需要 Node.js 24.11 以上和 PostgreSQL 16 或 17。

```bash
npm ci
node scripts/init-env.ts --llm-key <你的模型 API Key>
createdb myhot
```

在 `.env` 里加上：

```bash
DATABASE_URL=postgres://你的用户名@127.0.0.1:5432/myhot
API_BASE_URL=http://127.0.0.1:3001
```

然后：

```bash
node --env-file=.env scripts/migrate.ts
node --env-file=.env scripts/seed.ts
npm run build -w @aihot/web

node --env-file=.env apps/api/src/main.ts          # 接口，3001 端口
node --env-file=.env apps/worker/src/main.ts       # 后台任务
cd apps/web && NODE_ENV=production node --env-file=../../.env server.ts   # 网页，3000 端口
```

三个进程要一直运行，生产环境用 systemd 或 pm2 守护。

开发时用带热更新的方式：`npm run dev:api`、`npm run dev:worker`、`npm run dev:web`。开发时想免登录进后台，在 `.env` 里设 `DEV_AUTH_ROLE=admin`（生产环境会拒绝启动）。
