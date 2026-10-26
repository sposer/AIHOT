-- Initial application schema and system budgets.
-- Times are UTC timestamptz; report calendars are computed in Asia/Shanghai by the application.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Sources and collection
-- ---------------------------------------------------------------------------
-- decision: validate domain membership in the application taxonomy; not repeat the registry in SQL
-- because configuration changes and disabled historical identities do not change storage structure.

CREATE TABLE sources (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('rss', 'web_list', 'json_list', 'x_search', 'mp_account', 'external')),
  config              jsonb NOT NULL DEFAULT '{}',
  tags                text[] NOT NULL DEFAULT '{}',
  domains             text[] NOT NULL DEFAULT '{}',
  first_party         boolean NOT NULL DEFAULT false,
  owner_entity_id     text,
  tier                text NOT NULL DEFAULT 'T2' CHECK (tier IN ('T1', 'T1_5', 'T2', 'EXCLUDE_MP')),
  participation_mode  text NOT NULL DEFAULT 'editorial' CHECK (participation_mode IN ('editorial', 'hot_signal', 'isolated')),
  signal_group_id     text,
  interval_minutes    integer NOT NULL DEFAULT 30 CHECK (interval_minutes BETWEEN 1 AND 1440),
  -- Two separate licences: showing full text on this site, and redistributing it (full RSS).
  site_fulltext       boolean NOT NULL DEFAULT false,
  syndicate_fulltext  boolean NOT NULL DEFAULT false,
  enabled             boolean NOT NULL DEFAULT true,
  health              text NOT NULL DEFAULT 'unknown' CHECK (health IN ('ok', 'degraded', 'failing', 'paused', 'unknown')),
  fail_count          integer NOT NULL DEFAULT 0,
  last_fetch_at       timestamptz,
  last_ok_at          timestamptz,
  last_error          text,
  -- Successful collection position; never advanced by a failed fetch.
  cursor              jsonb,
  next_fetch_at       timestamptz,
  icon_url            text,
  imported_from       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- An icon that cannot be found is retried monthly rather than every day.
  icon_checked_at     timestamptz
);

CREATE INDEX sources_due_idx ON sources (next_fetch_at) WHERE enabled;

CREATE TABLE fetch_runs (
  id            bigserial PRIMARY KEY,
  source_id     text NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed', 'skipped')),
  found_count   integer NOT NULL DEFAULT 0,
  new_count     integer NOT NULL DEFAULT 0,
  error         text,
  detail        jsonb
);

CREATE INDEX fetch_runs_source_idx ON fetch_runs (source_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Articles (one per real-world material) and their revisions
-- ---------------------------------------------------------------------------

CREATE TABLE articles (
  id                 text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,80}$'),
  source_id          text NOT NULL REFERENCES sources (id),
  identity_key       text NOT NULL UNIQUE,
  url                text NOT NULL,
  title              text NOT NULL,
  author             text,
  language           text,
  -- Trusted source publication time; null when unknown or claimed >1h in the future.
  published_at       timestamptz,
  published_at_claim timestamptz,
  discovered_at      timestamptz NOT NULL,
  source_updated_at  timestamptz,
  -- Timeline sort value: discovery time, or source time for archived backfill.
  timeline_at        timestamptz NOT NULL,
  backfill           boolean NOT NULL DEFAULT false,
  backfill_reason    text,
  revision           integer NOT NULL DEFAULT 1,
  content_hash       text,
  excerpt            text,
  body_text          text,
  body_html          text,
  body_status        text NOT NULL DEFAULT 'pending' CHECK (body_status IN ('pending', 'ok', 'unconfirmed', 'none')),
  media              jsonb NOT NULL DEFAULT '[]',
  x_post             jsonb,
  raw                jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Formal grouping opens the release gate early.
  grouped_at         timestamptz,
  processing_state   text NOT NULL DEFAULT 'new'
    CHECK (processing_state IN ('new', 'analyzed', 'skipped', 'failed', 'blocked')),
  processing_error   text,
  -- The safety net skips queued work; provider outages wait until the next retry time.
  processing_queued_at timestamptz,
  processing_attempts  integer NOT NULL DEFAULT 0,
  processing_retry_at  timestamptz,
  -- Long-form X Article content is kept apart from x_post so list reads stay small.
  x_article          jsonb
);

CREATE INDEX articles_source_idx ON articles (source_id, discovered_at DESC);
CREATE INDEX articles_discovered_idx ON articles (discovered_at DESC);
CREATE INDEX articles_processing_idx ON articles (processing_state, processing_retry_at) WHERE processing_state IN ('new', 'failed');
CREATE INDEX articles_url_idx ON articles (url);

CREATE TABLE article_revisions (
  article_id    text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  revision      integer NOT NULL,
  content_hash  text,
  title         text NOT NULL,
  body_text     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, revision)
);

-- The same material found through several entrances keeps one article and many discoveries.
CREATE TABLE article_discoveries (
  article_id     text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  source_id      text NOT NULL,
  via            text NOT NULL,
  discovered_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, source_id, via)
);

CREATE TABLE translations (
  article_id    text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  lang          text NOT NULL DEFAULT 'zh',
  revision      integer NOT NULL,
  title         text,
  body_html     text,
  body_text     text,
  complete      boolean NOT NULL DEFAULT true,
  origin        text NOT NULL DEFAULT 'model' CHECK (origin IN ('model', 'replay', 'source')),
  receipt_id    bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (article_id, lang)
);

-- Short posts, Chinese bodies and exhausted failures wait for a new revision before another attempt.
CREATE TABLE translation_attempts (
  article_id  text PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  revision    integer NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  outcome     text NOT NULL CHECK (outcome IN ('translated', 'partial', 'skipped', 'failed')),
  reason      text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Every quote of the same X post shares its translation; a longer rendering changes text_hash.
CREATE TABLE quote_translations (
  tweet_id    text PRIMARY KEY,
  text_hash   text NOT NULL,
  text_zh     text NOT NULL,
  origin      text NOT NULL DEFAULT 'model' CHECK (origin IN ('model', 'reused')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Paid request receipts and budgets
-- ---------------------------------------------------------------------------

CREATE TABLE receipts (
  id            bigserial PRIMARY KEY,
  -- Stable identity of one logical paid request: task + input revision + provider + model + prompt + config.
  logical_key   text NOT NULL UNIQUE,
  service       text NOT NULL,
  model         text,
  purpose       text NOT NULL,
  subject       text,
  status        text NOT NULL CHECK (status IN ('pending', 'received', 'completed', 'failed', 'unknown')),
  request       jsonb,
  response      jsonb,
  request_id    text,
  usage         jsonb,
  cost          numeric(14, 6),
  currency      text,
  cost_basis    text CHECK (cost_basis IN ('actual', 'estimated')),
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  origin        text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'replay', 'imported')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  received_at   timestamptz,
  completed_at  timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX receipts_service_time_idx ON receipts (service, created_at);
CREATE INDEX receipts_subject_idx ON receipts (subject);
CREATE INDEX receipts_status_idx ON receipts (status) WHERE status IN ('pending', 'unknown');

-- Retries retain their own usage and costs. not_sent records a failure before transport dispatch
-- without charging the budget; attempts sent to a provider remain independently accountable.
CREATE TABLE receipt_attempts (
  id           bigserial PRIMARY KEY,
  receipt_id   bigint NOT NULL REFERENCES receipts (id) ON DELETE CASCADE,
  attempt      integer NOT NULL,
  service      text NOT NULL,
  model        text,
  origin       text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'replay', 'imported')),
  status       text NOT NULL CHECK (status IN ('pending', 'received', 'failed', 'unknown', 'not_sent')),
  request_id   text,
  usage        jsonb,
  cost         numeric(14, 6),
  currency     text,
  cost_basis   text CHECK (cost_basis IN ('actual', 'estimated')),
  latency_ms   integer,
  error        text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  UNIQUE (receipt_id, attempt)
);

CREATE INDEX receipt_attempts_service_time_idx ON receipt_attempts (service, origin, started_at);
CREATE INDEX receipt_attempts_pending_idx ON receipt_attempts (started_at) WHERE status = 'pending';

-- Per-minute / hour / day request budgets for paid services. Any zero stops the service.
CREATE TABLE budgets (
  service     text PRIMARY KEY,
  per_minute  integer NOT NULL,
  per_hour    integer NOT NULL,
  per_day     integer NOT NULL,
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Circuit breakers start above normal model peaks; operators tune them in the admin.
-- decision: initialize budgets here; not industry seed because rerunning seed must keep
-- operator-edited or removed budgets unchanged.
INSERT INTO budgets (service, per_minute, per_hour, per_day, note) VALUES
  ('jina', 5, 50, 300, '正文兜底（按请求计费）'),
  ('socialdata', 10, 100, 1000, 'X 搜索（按请求计费）'),
  ('dajiala', 5, 60, 500, '公众号列表与正文（按请求计费）'),
  ('zhipu', 100, 2000, 20000, '模型调用熔断（智谱）'),
  ('deepseek', 100, 2000, 20000, '模型调用熔断（DeepSeek）'),
  ('dashscope', 100, 2000, 20000, '模型与向量调用熔断（阿里云百炼）'),
  ('mimo', 100, 2000, 20000, '模型调用熔断（小米 MiMo）'),
  ('llm', 300, 6000, 40000, '模型调用熔断（默认模型，所有步骤共用）'),
  ('embedding', 300, 6000, 40000, '向量调用熔断');

-- Unit prices entered by operators estimate variable costs; estimates stay apart from bills.
CREATE TABLE service_prices (
  service text NOT NULL,
  model text NOT NULL DEFAULT '',
  currency text NOT NULL CHECK (currency IN ('CNY', 'USD')),
  input_per_mtok numeric(14, 6),
  cached_per_mtok numeric(14, 6),
  output_per_mtok numeric(14, 6),
  per_request numeric(14, 6),
  source_url text,
  verified_on date,
  note text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service, model)
);

-- ---------------------------------------------------------------------------
-- Editorial judgements (append-only) and manual overrides
-- ---------------------------------------------------------------------------

CREATE TABLE analyses (
  id               bigserial PRIMARY KEY,
  article_id       text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  input_revision   integer NOT NULL,
  origin           text NOT NULL CHECK (origin IN ('model', 'replay', 'rule')),
  model            text,
  prompt_version   text,
  receipt_ids      bigint[] NOT NULL DEFAULT '{}',
  relevance        text CHECK (relevance IN ('pass', 'block', 'unknown')),
  domains          text[] NOT NULL DEFAULT '{}',
  category         text,  -- a key of CATEGORIES in industry/taxonomy.ts (checked in code, so an industry can change them)
  tags             text[] NOT NULL DEFAULT '{}',
  subjects         text[] NOT NULL DEFAULT '{}',
  title_zh         text,
  summary_zh       text,
  reason_zh        text,
  score            numeric(5, 2),
  selected         boolean,
  output           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX analyses_article_idx ON analyses (article_id, id DESC);

-- Manual corrections win over model output; version-checked so stale jobs cannot overwrite them.
CREATE TABLE editorial_overrides (
  article_id  text PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  fields      jsonb NOT NULL DEFAULT '{}',
  visibility  text CHECK (visibility IN ('public', 'summary-only', 'withdrawn')),
  reason      text,
  version     integer NOT NULL DEFAULT 1,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Public projection: the single place every public exit reads from
-- ---------------------------------------------------------------------------

CREATE TABLE publications (
  article_id          text PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  analysis_id         bigint,
  revision            integer NOT NULL DEFAULT 1,
  visibility          text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'summary-only', 'withdrawn')),
  -- Belongs to the public pool (/all): editorial source, relevant, has Chinese title and summary.
  eligible            boolean NOT NULL DEFAULT false,
  selected            boolean NOT NULL DEFAULT false,
  title               text NOT NULL,
  original_title      text,
  summary             text,
  reason              text,
  category            text,
  tags                text[] NOT NULL DEFAULT '{}',
  domains             text[] NOT NULL DEFAULT '{}',
  score               numeric(5, 2),
  source_id           text NOT NULL,
  channel             text NOT NULL CHECK (channel IN ('news', 'x')),
  first_party         boolean NOT NULL DEFAULT false,
  url                 text NOT NULL,
  published_at        timestamptz,
  discovered_at       timestamptz NOT NULL,
  timeline_at         timestamptz NOT NULL,
  backfill            boolean NOT NULL DEFAULT false,
  -- Release gate: first time the item met the selected conditions, and first release.
  selected_ready_at   timestamptz,
  visible_after       timestamptz,
  body_mode           text NOT NULL DEFAULT 'summary' CHECK (body_mode IN ('full', 'summary')),
  syndicate           boolean NOT NULL DEFAULT false,
  indexable           boolean NOT NULL DEFAULT false,
  story_id            bigint,
  fact_id             bigint,
  search_text         text NOT NULL DEFAULT '',
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Selected groups keep the earliest public pool member's timeline anchor when their representative changes.
  sort_at             timestamptz NOT NULL,
  seo_indexed_at      timestamptz,
  seo_excluded_at     timestamptz
);

CREATE INDEX publications_selected_timeline_idx ON publications (timeline_at DESC, article_id)
  WHERE visibility = 'public' AND selected;
CREATE INDEX publications_pool_timeline_idx ON publications (timeline_at DESC, article_id)
  WHERE visibility = 'public' AND eligible;
CREATE INDEX publications_pool_published_idx ON publications ((coalesce(published_at, discovered_at)) DESC, article_id)
  WHERE visibility = 'public' AND eligible;
CREATE INDEX publications_tags_idx ON publications USING gin (tags);
CREATE INDEX publications_domains_idx ON publications USING gin (domains);
CREATE INDEX publications_search_trgm_idx ON publications USING gin (search_text gin_trgm_ops);
CREATE INDEX publications_story_idx ON publications (story_id) WHERE story_id IS NOT NULL;
CREATE INDEX publications_eligible_updated_idx ON publications (updated_at) WHERE eligible;
CREATE INDEX publications_fact_idx ON publications (fact_id) WHERE fact_id IS NOT NULL;
CREATE INDEX publications_selected_release_idx ON publications (visible_after) WHERE selected AND visibility = 'public';
CREATE INDEX publications_indexable_timeline_idx ON publications (timeline_at DESC) WHERE visibility = 'public' AND indexable;
CREATE INDEX publications_selected_sort_idx ON publications (sort_at DESC, article_id) WHERE visibility = 'public' AND selected;
CREATE INDEX publications_selected_ready_idx ON publications (selected_ready_at) WHERE selected_ready_at IS NOT NULL;

-- One narrow search row per eligible item, maintained by the publish step. direct searches the
-- title/summary/subject/source text; body searches the beginning of full text allowed on this site.
CREATE TABLE pool_search (
  article_id  text PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  direct      text NOT NULL,
  body        text NOT NULL DEFAULT ''
);

CREATE INDEX pool_search_direct_trgm_idx ON pool_search USING gin (direct gin_trgm_ops);
CREATE INDEX pool_search_body_trgm_idx ON pool_search USING gin (body gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Selected sync ledger (v1 snapshot + changes)
-- ---------------------------------------------------------------------------
-- seq is assigned under a transaction-scoped advisory lock inside the short publish transaction,
-- so seq order equals commit order. visible_at holds the watermark back until the release gate passes.

CREATE TABLE selected_ledger (
  seq         bigint PRIMARY KEY,
  article_id  text NOT NULL,
  op          text NOT NULL CHECK (op IN ('upsert', 'remove')),
  changed_at  timestamptz NOT NULL DEFAULT now(),
  visible_at  timestamptz NOT NULL DEFAULT now(),
  payload     jsonb
);

CREATE INDEX selected_ledger_article_idx ON selected_ledger (article_id, seq DESC);
CREATE INDEX selected_ledger_visible_idx ON selected_ledger (visible_at) ;

CREATE TABLE selected_state (
  article_id    text PRIMARY KEY,
  in_set        boolean NOT NULL,
  payload_hash  text,
  last_seq      bigint NOT NULL
);

-- ---------------------------------------------------------------------------
-- Facts, stories (events) and heat
-- ---------------------------------------------------------------------------

CREATE TABLE stories (
  id                 bigserial PRIMARY KEY,
  public_id          uuid NOT NULL UNIQUE,
  title              text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'watching', 'settled')),
  action             text,
  frame              jsonb,
  first_report_at    timestamptz,
  latest_at          timestamptz,
  digest             text,
  digest_updated_at  timestamptz,
  latest             text,
  merged_into        bigint REFERENCES stories (id),
  version            integer NOT NULL DEFAULT 1,
  origin             text NOT NULL DEFAULT 'model' CHECK (origin IN ('model', 'replay', 'manual')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Factual summary shown when no digest has been written yet.
  summary            text
);

CREATE INDEX stories_latest_idx ON stories (latest_at DESC) WHERE merged_into IS NULL;

-- Old public ids of merged stories answer 308 to the survivor.
CREATE TABLE story_aliases (
  public_id   uuid PRIMARY KEY,
  story_id    bigint NOT NULL REFERENCES stories (id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE story_links (
  story_id    bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  other_id    bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  relation    text NOT NULL CHECK (relation IN ('storyline', 'related')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, other_id)
);

CREATE TABLE story_digests (
  story_id     bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  version      integer NOT NULL,
  digest       text NOT NULL,
  latest       text,
  receipt_id   bigint,
  article_ids  text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- Corrected titles and summaries rewrite the digest even without a new report.
  inputs_hash  text,
  PRIMARY KEY (story_id, version)
);

-- A fact is one concrete change supported by sources: subject, action, object, time, conditions.
CREATE TABLE facts (
  id           bigserial PRIMARY KEY,
  public_id    text NOT NULL UNIQUE,
  story_id     bigint REFERENCES stories (id),
  title        text NOT NULL,
  subject      text,
  action       text,
  object       text,
  conditions   text,
  occurred_at  timestamptz,
  version      integer NOT NULL DEFAULT 1,
  manual       boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX facts_story_idx ON facts (story_id);
CREATE INDEX facts_created_idx ON facts (created_at DESC);

CREATE TABLE fact_articles (
  fact_id     bigint NOT NULL REFERENCES facts (id) ON DELETE CASCADE,
  article_id  text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'report' CHECK (role IN ('primary', 'report', 'mention')),
  evidence    text,
  manual      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fact_id, article_id)
);

CREATE INDEX fact_articles_article_idx ON fact_articles (article_id);

-- Discussion evidence for heat: one row per participant and article, dated by source time.
CREATE TABLE story_signals (
  story_id         bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  article_id       text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  participant_key  text NOT NULL,
  source_id        text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('editorial', 'signal')),
  observed_at      timestamptz NOT NULL,
  PRIMARY KEY (story_id, article_id)
);

CREATE INDEX story_signals_time_idx ON story_signals (observed_at DESC);
CREATE INDEX story_signals_story_idx ON story_signals (story_id, observed_at DESC);

CREATE TABLE hot_rankings (
  id            bigserial PRIMARY KEY,
  computed_at   timestamptz NOT NULL DEFAULT now(),
  rule_version  text NOT NULL,
  entries       jsonb NOT NULL,
  evidence      jsonb,
  published     boolean NOT NULL DEFAULT true
);

CREATE INDEX hot_rankings_time_idx ON hot_rankings (computed_at DESC) WHERE published;

CREATE TABLE story_heat_hourly (
  story_id      bigint NOT NULL REFERENCES stories (id) ON DELETE CASCADE,
  hour          timestamptz NOT NULL,
  heat          numeric(10, 3) NOT NULL,
  participants  integer NOT NULL,
  cohort        integer NOT NULL DEFAULT 0,
  complete      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (story_id, hour)
);

-- Embeddings for event candidate recall (no pgvector: recall scans a bounded recent window).
CREATE TABLE embeddings (
  kind        text NOT NULL CHECK (kind IN ('fact', 'article', 'story')),
  ref_id      text NOT NULL,
  model       text NOT NULL,
  text_hash   text NOT NULL,
  vector      real[] NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref_id, model)
);

-- Grouping decisions for traceability (which candidates, which verdict, which receipt).
CREATE TABLE grouping_decisions (
  id           bigserial PRIMARY KEY,
  article_id   text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  fact_id      bigint,
  story_id     bigint,
  verdict      text NOT NULL,
  candidates   jsonb,
  receipt_id   bigint,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX grouping_decisions_article_idx ON grouping_decisions (article_id, id DESC);

-- Manual standalone decisions prevent automatic reattachment until an explicit admin regroup.
CREATE TABLE grouping_overrides (
  article_id  text PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  mode        text NOT NULL DEFAULT 'standalone' CHECK (mode IN ('standalone')),
  reason      text,
  actor       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Until regrouping decides a report again, its membership is not evidence for other reports.
CREATE TABLE regroup_pending (
  article_id   text PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Reports and topics
-- ---------------------------------------------------------------------------

CREATE TABLE reports (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('daily', 'weekly', 'monthly')),
  scope         text NOT NULL,
  key           text NOT NULL,
  window_start  timestamptz NOT NULL,
  window_end    timestamptz NOT NULL,
  content       jsonb NOT NULL,
  generated_at  timestamptz NOT NULL,
  model         text,
  revision      integer NOT NULL DEFAULT 1,
  origin        text NOT NULL DEFAULT 'model' CHECK (origin IN ('model', 'imported', 'manual')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, scope, key)
);

CREATE TABLE report_revisions (
  report_id     bigint NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
  revision      integer NOT NULL,
  content       jsonb NOT NULL,
  generated_at  timestamptz NOT NULL,
  reason        text,
  PRIMARY KEY (report_id, revision)
);

CREATE TABLE topics (
  slug        text PRIMARY KEY,
  name        text NOT NULL,
  grp         text NOT NULL CHECK (grp IN ('company', 'field', 'genre')),
  entity_id   text,
  tags        text[] NOT NULL,
  definition  text NOT NULL,
  related     text[] NOT NULL DEFAULT '{}',
  position    integer NOT NULL
);

-- ---------------------------------------------------------------------------
-- Notifications (F21)
-- ---------------------------------------------------------------------------

CREATE TABLE notify_targets (
  key          text PRIMARY KEY,
  purpose      text NOT NULL CHECK (purpose IN ('content', 'alert', 'feedback')),
  kind         text NOT NULL CHECK (kind IN ('feishu_webhook', 'feishu_chat', 'log')),
  enabled      boolean NOT NULL DEFAULT false,
  -- Content published before a slot was enabled is never back-filled into it.
  enabled_at   timestamptz,
  config_ref   text,
  note         text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deliveries (
  id             bigserial PRIMARY KEY,
  target_key     text NOT NULL REFERENCES notify_targets (key),
  subject_kind   text NOT NULL,
  subject_id     text NOT NULL,
  dedupe_key     text NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'skipped')),
  attempts       integer NOT NULL DEFAULT 0,
  payload        jsonb,
  response       text,
  origin         text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'imported')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_key, dedupe_key)
);

CREATE INDEX deliveries_status_idx ON deliveries (status, created_at);

-- Short leases keep concurrent same-title cards out before the formal identity is known.
CREATE TABLE delivery_leases (
  lease_key   text PRIMARY KEY,
  holder      text NOT NULL,
  expires_at  timestamptz NOT NULL
);

-- ---------------------------------------------------------------------------
-- Admin identity, audit, feedback, settings and job runs
-- ---------------------------------------------------------------------------

CREATE TABLE admin_users (
  id              bigserial PRIMARY KEY,
  feishu_union_id text UNIQUE,
  email           text UNIQUE,
  display_name    text,
  role            text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
);

-- Opaque session ids are stored hashed; the cookie carries the random value only.
CREATE TABLE admin_sessions (
  id_hash      text PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  csrf_token   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  actor       text NOT NULL,
  action      text NOT NULL,
  subject     text,
  reason      text,
  before      jsonb,
  after       jsonb,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_subject_idx ON audit_log (subject, created_at DESC);

CREATE TABLE feedback (
  id                bigserial PRIMARY KEY,
  content           text NOT NULL,
  email             text,
  page_url          text,
  screenshot_key    text,
  source_hash       text NOT NULL,
  status            text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triaged', 'replied', 'resolved', 'spam')),
  note              text,
  forwarded_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- The forwarding sweep retries feedback that has not reached the internal Feishu chat.
  forward_error     text
);

CREATE TABLE feedback_bans (
  source_hash  text PRIMARY KEY,
  reason       text,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- External ingest reports (POST /api/ingest/items).
CREATE TABLE ingest_events (
  id           bigserial PRIMARY KEY,
  client       text NOT NULL,
  kind         text NOT NULL,
  status       text NOT NULL,
  summary      jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ingest_events_client_idx ON ingest_events (client, created_at DESC);

-- Small key-value settings editable from the admin (e.g. about-page QR code file names).
CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Stored files (screenshots, QR codes, OG cache) addressed by content hash.
CREATE TABLE stored_files (
  key           text PRIMARY KEY,
  content_type  text NOT NULL,
  bytes         integer NOT NULL,
  purpose       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz
);

-- Last run of every scheduled job, for the operations view.
CREATE TABLE job_runs (
  id           bigserial PRIMARY KEY,
  job          text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed', 'skipped')),
  detail       jsonb,
  error        text
);

CREATE INDEX job_runs_job_idx ON job_runs (job, started_at DESC);

-- ---------------------------------------------------------------------------
-- SelectBench
-- ---------------------------------------------------------------------------
-- Selection-model comparison runs on the human gold set, imported by scripts/eval-selection.ts.

CREATE TABLE selectbench_runs (
  id text PRIMARY KEY,
  label text NOT NULL,
  split text,
  sample_size integer NOT NULL,
  seed integer,
  prompt_version text,
  models text[] NOT NULL,
  summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  imported_by text
);

CREATE TABLE selectbench_results (
  run_id text NOT NULL REFERENCES selectbench_runs (id) ON DELETE CASCADE,
  model text NOT NULL,
  case_id text NOT NULL,
  title text NOT NULL,
  stratum text,
  gold text NOT NULL,
  -- Per-case human annotation; never inferred from source coverage or model output.
  domains text[] NOT NULL DEFAULT '{}',
  decision text,
  score numeric(5, 2),
  relevance text,
  category text,
  reason text,
  receipt_id bigint,
  error text,
  PRIMARY KEY (run_id, model, case_id)
);

-- New out-of-line values use lz4; full-text search also keeps its body column compressed with lz4.
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET default_toast_compression = lz4', current_database()); END $$;
ALTER TABLE pool_search ALTER COLUMN body SET COMPRESSION lz4;
