// 开发机：按 Run 和角色打出模型用量和输入 token 的缓存命中率。 的目标是 Explorer 调用的命中率 ≥ 50%，
//  的核心指标有「各角色 token 占比、缓存命中率」；HTTP 接口现在只有总数（GET /usage 按模型、按天），按角色的先用这个看。
// 只读打开 Melina 的数据库（usage_ledger 表，一次模型调用一行），不经过 Melina，Melina 在跑也能看。命中率的算法在 src/runtime/ledger.ts。
//
//   node test/dev/usage.ts [--data ~/.melina-dev] [--run <runId>] [--last 5]

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import { cacheHitRate } from '../../src/runtime/ledger.ts';

const { values } = parseArgs({
  options: {
    data: { type: 'string' },
    run: { type: 'string' },
    last: { type: 'string', default: '5' },
  },
});

const dataDir = resolve(values.data ?? join(homedir(), '.melina-dev'));
const dbPath = join(dataDir, 'melina.db');
if (!existsSync(dbPath)) {
  console.error(`没找到 ${dbPath}：用 --data 指定 Melina 的数据目录`);
  process.exit(1);
}
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

interface RunRow {
  id: string;
  statement: string;
  status: string;
}
interface RoleRow {
  role: string;
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  usd: number;
}

const runs: RunRow[] = values.run
  ? (db
      .prepare(
        "SELECT id, json_extract(data, '$.goal.statement') AS statement, status FROM runs WHERE id = ? ORDER BY seq DESC",
      )
      .all(values.run) as RunRow[])
  : (db
      .prepare(
        "SELECT id, json_extract(data, '$.goal.statement') AS statement, status FROM runs ORDER BY seq DESC LIMIT ?",
      )
      .all(Number(values.last)) as RunRow[]);
if (runs.length === 0) console.log('没有 Run');

const byRole = db.prepare(
  `SELECT role, count(*) AS calls, sum(input) AS input, sum(cache_read) AS cacheRead, sum(cache_write) AS cacheWrite,
          sum(output) AS output, sum(usd) AS usd
     FROM usage_ledger WHERE kind = 'model' AND run_id = ? GROUP BY role ORDER BY role`,
);

const pct = (n: number | undefined) => (n === undefined ? '—' : `${(n * 100).toFixed(1)}%`);
const tokens = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : String(n));

for (const run of runs) {
  const rows = byRole.all(run.id) as RoleRow[];
  const totalIn = rows.reduce((n, r) => n + r.input + r.cacheRead + r.cacheWrite, 0);
  console.log(`\n${run.id}（${run.status}）${run.statement.split('\n')[0]?.slice(0, 60) ?? ''}`);
  console.log('  角色        调用   输入（总）  命中     写入     输出     占输入   命中率   美元');
  for (const r of rows) {
    const input = r.input + r.cacheRead + r.cacheWrite;
    console.log(
      `  ${r.role.padEnd(10)} ${String(r.calls).padStart(5)} ${tokens(input).padStart(10)} ${tokens(r.cacheRead).padStart(8)}` +
        ` ${tokens(r.cacheWrite).padStart(8)} ${tokens(r.output).padStart(8)} ${pct(totalIn > 0 ? input / totalIn : undefined).padStart(8)}` +
        ` ${pct(cacheHitRate(r)).padStart(8)} ${r.usd.toFixed(4).padStart(8)}`,
    );
  }
  const all = rows.reduce(
    (t, r) => ({
      input: t.input + r.input,
      cacheRead: t.cacheRead + r.cacheRead,
      cacheWrite: t.cacheWrite + r.cacheWrite,
    }),
    { input: 0, cacheRead: 0, cacheWrite: 0 },
  );
  console.log(`  合计命中率 ${pct(cacheHitRate(all))}`);
}
db.close();
