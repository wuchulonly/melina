import Type, { type TObject } from 'typebox';
import { invalid } from '../core/errors.ts';
import { isClosingTool, SubmitWatchArgs, TOOL, type ToolSpec } from '../core/tools.ts';
import type { Role } from '../core/types.ts';
import type { OutputInspector, ToolEnv, ToolExtension } from './session.ts';

export function validateExtensions(extensions: readonly ToolExtension[]): void {
  const names = new Set<string>(Object.values(TOOL));
  const fields = new Set(Object.keys(SubmitWatchArgs.properties));
  for (const extension of extensions) {
    const name = extension.spec.name;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || names.has(name)) throw invalid(`扩展工具名不合法或重复：${name}`);
    if (!extension.roles.length || typeof extension.run !== 'function')
      throw invalid(`扩展工具缺少角色或执行入口：${name}`);
    names.add(name);
    if (extension.observation) {
      const field = extension.observation.field;
      if (!extension.roles.includes('watcher') || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field) || fields.has(field))
        throw invalid(`观察者扩展字段不合法或重复：${field}`);
      fields.add(field);
    }
  }
}

export function availableExtensions(extensions: readonly ToolExtension[], role: Role): ToolExtension[] {
  return extensions.filter((extension) => extension.roles.includes(role));
}

/** 模型上下文和网关使用同一份稳定顺序；可选工具放在交付、收尾工具之前。 */
export function extendTools(tools: ToolSpec[], extensions: readonly ToolExtension[], role: Role): ToolSpec[] {
  if (role === 'watcher') {
    const fields = Object.fromEntries(
      availableExtensions(extensions, role).flatMap((e) =>
        e.observation ? [[e.observation.field, Type.Optional(e.observation.parameters)]] : [],
      ),
    );
    if (!Object.keys(fields).length) return tools;
    return tools.map((tool) =>
      tool.name === TOOL.submitWatch
        ? {
            ...tool,
            parameters: Type.Object(
              { ...(tool.parameters as TObject).properties, ...fields },
              { additionalProperties: false },
            ),
          }
        : tool,
    );
  }
  const extra = availableExtensions(extensions, role).map((extension) => extension.spec);
  if (!extra.length) return tools;
  const closing = tools.findIndex((tool) => tool.name === TOOL.deliver || isClosingTool(tool.name));
  const at = closing < 0 ? tools.length : closing;
  return [...tools.slice(0, at), ...extra, ...tools.slice(at)];
}

export function outputInspector(env: ToolEnv): OutputInspector | undefined {
  const inspectors = availableExtensions(env.deps.extensions ?? [], env.caller.role)
    .map((extension) => extension.inspect?.(env))
    .filter((inspector): inspector is OutputInspector => inspector !== undefined);
  if (!inspectors.length) return undefined;
  return {
    inspect: (output) => inspectors.reduce((text, inspector) => inspector.inspect(text), output),
    finish: async (outcome) => {
      let current = outcome;
      for (const inspector of inspectors) current = await inspector.finish(current);
      return current;
    },
  };
}
