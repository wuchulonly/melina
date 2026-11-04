import { readFileSync } from 'node:fs';
export type PromptName = 'explorer' | 'scoper' | 'selection' | 'watcher';
export type SharedPrompt = 'environment' | 'credentials' | 'workspace' | 'delivery' | 'sources';
export const PRINCIPLES_MARK = '{{principles}}';
const fragments = new Map<string, string>();
const cache = new Map<string, string>();
function read(file: string): string {
  let text = fragments.get(file);
  if (text === undefined) {
    text = readFileSync(new URL(`../prompts/${file}`, import.meta.url), 'utf8').trimEnd();
    fragments.set(file, text);
  }
  return text;
}
export function loadPrinciples(): string {
  return read('principles.md');
}
export function loadSharedPrompt(name: SharedPrompt): string {
  return read(`shared/${name}.md`);
}
export function loadPrompt(name: PromptName): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = read(`${name}.md`).replace(PRINCIPLES_MARK, () => loadPrinciples());
    if (name === 'explorer')
      text = [text, ...(['environment', 'credentials', 'workspace', 'delivery'] as const).map(loadSharedPrompt)].join(
        '\n\n',
      );
    if (name === 'scoper') text = text.replace('{{credentials}}', () => loadSharedPrompt('credentials'));
    text = [text, loadSharedPrompt('sources')].join('\n\n');
    cache.set(name, text);
  }
  return text;
}
