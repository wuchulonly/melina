// 开发机显式执行的 DeepSeek 原生接口探测。Key 只从环境变量读取，输出不含 Key。
// node test/dev/provider-errors.ts [deepseek-flash|deepseek-v4-pro] [--probe ok|auth|model]
import { parseArgs } from 'node:util';
import { deepseekProvider } from '../../src/models/builtin.ts';
import { classify } from '../../src/models/classify.ts';
import { normalizeContext } from '../../src/models/protocol.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { probe: { type: 'string', default: 'ok' } },
});
const provider = deepseekProvider();
const name = (positionals[0] ?? 'deepseek-flash').replace(/^deepseek\//, '');
const catalog = provider.getModels().find((m) => m.id === name);
if (!catalog) throw new Error(`未知 DeepSeek 模型：${name}`);
const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error('需要 DEEPSEEK_API_KEY');
if (!['ok', 'auth', 'model'].includes(values.probe)) throw new Error('--probe 必须为 ok、auth 或 model');
const model = {
  ...catalog,
  ...(values.probe === 'model' ? { id: 'missing-model-for-probe' } : {}),
  ...(process.env.DEEPSEEK_BASE_URL ? { baseUrl: process.env.DEEPSEEK_BASE_URL } : {}),
};
const reply = await provider
  .streamSimple(
    model,
    normalizeContext({ messages: [{ role: 'user', content: 'Reply OK.', timestamp: Date.now() }] }),
    {
      apiKey: values.probe === 'auth' ? 'invalid-key-for-probe' : key,
      signal: AbortSignal.timeout(60_000),
      reasoning: 'off',
      maxTokens: 64,
    },
  )
  .result();
console.log(
  JSON.stringify({
    model: model.id,
    stopReason: reply.stopReason,
    usage: reply.usage,
    ...(reply.errorMessage
      ? { error: reply.errorMessage.replaceAll(key, '[REDACTED]'), failure: classify(reply) }
      : {}),
  }),
);
