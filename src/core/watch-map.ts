import type { WatchBody, WatchDirection } from './types.ts';

// 后置分类沿用 CTF steer 的 Heimdall 规则（MIT，见 extensions/ctf/steer.LICENSE）。
// 地图和命令拦截共用分类，定向验证不因使用小词表而被归入盲目爆破。
const BRUTE_RE =
  /brute|wordlist|dictionary|spray|hydra|hashcat|\bjohn\b|medusa|patator|jwt[-_]?(?:tool|cracker)|rockyou|dirbust|gobuster|ffuf|password.?crack|credential.?stuff|weak.?pass|secret.?brute|爆破|字典|弱口令|穷举/i;
const TARGETED_ANGLE_RE =
  /sqli(?:_login)?\.txt|lfi\.txt|(?:sqli|sql\s*inject|注入).{0,20}(?:字典|wordlist)|(?:字典|wordlist).{0,20}(?:sqli|sql\s*inject|注入|lfi)/i;
const TARGETED_SPRAY_RE =
  /targeted\s+spray|collected\s+pattern|口令规则|针对性(?:喷洒|爆破)|自构口令|定向喷洒|spray_(?:users|passwords|creds)\.txt|loot\.json|已成功登录|已登录.{0,16}(?:口令|密码|喷)|同一口令/i;
const GENERIC_BRUTE_RE = /rockyou|jwt|dirbust|secret.?brute|gobuster|ffuf|SECRET_KEY/i;

export function bruteLaterScore(text: string): number {
  if (TARGETED_SPRAY_RE.test(text) && !GENERIC_BRUTE_RE.test(text)) return 0;
  if (TARGETED_ANGLE_RE.test(text) && !/jwt|password.?spray|dirbust|弱口令|secret.?brute|gobuster|ffuf/i.test(text))
    return 0;
  return Number(BRUTE_RE.test(text));
}

/** 先做逻辑与定向验证，再考虑爆破；同类内沿用模型优先级及原始顺序。 */
export function compareWatchAngles(a: WatchDirection, b: WatchDirection): number {
  return (
    bruteLaterScore(`${a.direction} ${a.result}`) - bruteLaterScore(`${b.direction} ${b.result}`) ||
    (a.priority ?? 5) - (b.priority ?? 5)
  );
}

/** 纯投影：同一方向图始终生成同一短地图，不保存文本和编号的平行数组。 */
export function projectWatchMap(body: Pick<WatchBody, 'directions'>): {
  confirmed: WatchDirection[];
  angles: WatchDirection[];
} {
  const active = body.directions.filter((d) => !d.retired);
  const tried = (d: WatchDirection) => d.attempts.length + (d.archivedAttempts?.length ?? 0) > 0;
  const order = (a: WatchDirection, b: WatchDirection) => (a.priority ?? 5) - (b.priority ?? 5);
  return {
    confirmed: active.filter(tried).sort(order).slice(0, 8),
    angles: active
      .filter((d) => d.status === 'untried' && !tried(d))
      .sort(compareWatchAngles)
      .slice(0, 4),
  };
}
