

CREATE TABLE runs (
  id         TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL,
  status     TEXT NOT NULL,           -- running | paused | done | cancelled | failed
  mode       TEXT NOT NULL,           -- direct | settling
  created_at TEXT NOT NULL,
  ended_at   TEXT,
  data       TEXT NOT NULL CHECK (json_valid(data))   -- Run：goal、workspace、config 都在里面
) STRICT;
CREATE INDEX runs_status ON runs (status);

CREATE TABLE bets (
  id     TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq    INTEGER NOT NULL,
  status TEXT NOT NULL,               -- active | closed
  data   TEXT NOT NULL CHECK (json_valid(data))       -- Bet
) STRICT;
CREATE INDEX bets_run_status ON bets (run_id, status);

CREATE TABLE branches (
  id     TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq    INTEGER NOT NULL,
  bet_id TEXT NOT NULL,
  state  TEXT NOT NULL,               -- starting | running | paused | succeeded | cancelled | failed
  data   TEXT NOT NULL CHECK (json_valid(data))       -- Branch
) STRICT;
CREATE INDEX branches_run_state ON branches (run_id, state);

CREATE TABLE snapshots (
  id        TEXT PRIMARY KEY,
  run_id    TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  parent    TEXT NOT NULL,            -- 父 snapshot 的 id，或 'root'
  data      TEXT NOT NULL CHECK (json_valid(data))    -- Snapshot
) STRICT;
CREATE INDEX snapshots_run_branch ON snapshots (run_id, branch_id);

CREATE TABLE observations (
  id        TEXT PRIMARY KEY,
  run_id    TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  branch_id TEXT,                     -- Scoper 的调用没有
  episode   INTEGER,
  tool      TEXT NOT NULL,
  data      TEXT NOT NULL CHECK (json_valid(data))    -- Observation；output 是句柄
) STRICT;
CREATE INDEX observations_branch_episode ON observations (branch_id, episode);

CREATE TABLE candidates (
  id        TEXT PRIMARY KEY,
  run_id    TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  data      TEXT NOT NULL CHECK (json_valid(data))    -- Candidate
) STRICT;
CREATE INDEX candidates_run ON candidates (run_id, seq);

CREATE TABLE branch_inbox (
  id        TEXT PRIMARY KEY,
  run_id    TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq       INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  kind      TEXT NOT NULL,            -- notice | human
  data      TEXT NOT NULL CHECK (json_valid(data))    -- InboxItem
) STRICT;
CREATE INDEX branch_inbox_branch_seq ON branch_inbox (branch_id, seq);

CREATE TABLE human_inputs (
  id     TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq    INTEGER NOT NULL,
  data   TEXT NOT NULL CHECK (json_valid(data))       -- HumanInput
) STRICT;
CREATE INDEX human_inputs_run_seq ON human_inputs (run_id, seq);

CREATE TABLE usage_ledger (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL,
  branch_id   TEXT,
  role        TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- model | tool
  at          TEXT NOT NULL,
  ms          INTEGER NOT NULL,
  provider    TEXT,
  model       TEXT,
  input       INTEGER NOT NULL DEFAULT 0,
  cache_read  INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0,
  output      INTEGER NOT NULL DEFAULT 0,
  usd         REAL NOT NULL DEFAULT 0,
  tool        TEXT,                   -- sh 记命令的第一个词
  exit_code   INTEGER,
  bytes       INTEGER,
  handle      TEXT
) STRICT;
CREATE INDEX usage_ledger_run ON usage_ledger (run_id);
CREATE INDEX usage_ledger_at ON usage_ledger (at);

CREATE TABLE events (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,                        -- system.updated 为 NULL
  type   TEXT NOT NULL,
  at     TEXT NOT NULL,
  data   TEXT NOT NULL CHECK (json_valid(data))       -- 事件的 data，格式见 src/core/events.ts 的 EVENT_DATA
) STRICT;
CREATE INDEX events_run_seq ON events (run_id, seq);

CREATE TABLE providers (
  provider   TEXT PRIMARY KEY,        -- 供应商 id；运行时目前仅启用 deepseek
  rpm        INTEGER,
  tpm        INTEGER,
  updated_at TEXT NOT NULL,
  -- 自定义供应商的接口和模型（CustomProvider 的 JSON）；内置目录的是 NULL
  custom     TEXT CHECK (custom IS NULL OR json_valid(custom))
) STRICT;

CREATE TABLE provider_keys (
  id         TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,           -- providers.provider
  name       TEXT,                    -- 给人看的名字；NULL 是没起
  api_key    BLOB NOT NULL,           -- 加密存，只写不读
  position   INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX provider_keys_order ON provider_keys (provider, position);

CREATE TABLE models (
  tier     TEXT NOT NULL CHECK (tier IN ('fast', 'strong')),
  provider TEXT NOT NULL,
  model    TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (tier, provider, model)
) STRICT;

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value))
) STRICT;

CREATE TABLE credentials (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  as_env     TEXT,                    -- 环境变量名
  as_file    TEXT,                    -- 容器里的绝对路径
  value      BLOB,                    -- 加密存，只写不读
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((as_env IS NULL) <> (as_file IS NULL))
) STRICT;

CREATE TABLE run_records (
  id     TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  kind   TEXT NOT NULL,
  seq    INTEGER NOT NULL
) STRICT;
CREATE INDEX run_records_run ON run_records (run_id, kind, seq);
CREATE INDEX events_run_type ON events (run_id, type, seq);

CREATE INDEX observations_run ON observations (run_id);
CREATE INDEX branch_inbox_run ON branch_inbox (run_id);

CREATE TABLE watch_notes (
  branch_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL UNIQUE,
  at TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  PRIMARY KEY (branch_id, rev)
) STRICT;
CREATE INDEX watch_notes_run_branch_seq ON watch_notes (run_id, branch_id, seq);
CREATE TRIGGER watch_notes_insert AFTER INSERT ON events WHEN NEW.type = 'watch.noted'
BEGIN
  INSERT INTO watch_notes (branch_id, rev, run_id, seq, at, data)
  VALUES (json_extract(NEW.data, '$.branchId'), json_extract(NEW.data, '$.rev'), NEW.run_id, NEW.seq, NEW.at, NEW.data);
END;

CREATE INDEX observations_watch_state ON observations (run_id, branch_id, json_extract(data, '$.role'), tool, seq);
CREATE INDEX events_run_type_branch_seq ON events
  (run_id, type, coalesce(json_extract(data, '$.branchId'), json_extract(data, '$.id')), seq);

CREATE INDEX observations_run_seq ON observations(run_id, seq);
CREATE INDEX observations_branch_seq ON observations(branch_id, seq);
