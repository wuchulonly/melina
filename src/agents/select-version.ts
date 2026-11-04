import { MelinaError } from '../core/errors.ts';
import type { SelectVersion } from '../core/interfaces/agents.ts';
import type { ContextAssembler } from '../core/interfaces/context.ts';
import type { TextGenerator } from '../core/interfaces/models.ts';

export function createSelectVersion(deps: {
  generate: TextGenerator;
  assembler: Pick<ContextAssembler, 'forSelection'>;
}): SelectVersion {
  return async ({ run, request, model, signal }) => {
    const layout = deps.assembler.forSelection(run.id, request);
    const text = await deps.generate({
      meta: { runId: run.id, role: 'explorer', job: 'selection_call', sessionId: `${run.id}-selection`, model, signal },
      system: layout.system,
      prompt: layout.messages.map((m) => m.text).join('\n\n'),
    });
    signal.throwIfAborted();
    const clean = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
    let parsed: unknown;
    try {
      parsed = JSON.parse(clean);
    } catch (error) {
      // 无工具生成偶尔在 JSON 前后附说明；只容忍外层文字，字段仍按下面的规则校验。
      const fenced = clean.match(/```(?:json)?\s*\n([\s\S]*?)\n```/g);
      const body = fenced?.length === 1 ? fenced[0].replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1') : clean;
      const object = body.match(/\{[\s\S]*\}/)?.[0];
      if (!object) throw error;
      parsed = JSON.parse(object);
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('choice' in parsed) ||
      !('why' in parsed) ||
      typeof parsed.choice !== 'number' ||
      !Number.isInteger(parsed.choice) ||
      typeof parsed.why !== 'string' ||
      !parsed.why.trim()
    )
      throw new MelinaError('unavailable', '终局选择缺少有效的版本编号或理由');
    const version = request.versions[parsed.choice - 1];
    if (!version) throw new MelinaError('unavailable', '终局选择的版本编号越界');
    return { candidateId: version.candidateId, why: parsed.why.trim(), basedOnSeq: layout.basedOnSeq };
  };
}
