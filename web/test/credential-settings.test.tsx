// @vitest-environment jsdom
// 凭证设置即时校验注入方式；已保存的凭证展示给法和值状态。

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { Settings } from '../../src/core/config.ts';
import { setResource, subscribeResource } from '../src/api/resource.ts';
import { SETTINGS } from '../src/api/resources.ts';
import { credentialIssue } from '../src/pages/settings/credentials.ts';
import { SettingsPage } from '../src/pages/settings/SettingsPage.tsx';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('凭证能不能给容器', () => {
  it('环境变量：名单里的行，别的不行，说改用文件形式', () => {
    expect(credentialIssue({ env: 'GITHUB_TOKEN' })).toBeUndefined();
    expect(credentialIssue({ env: 'SLACK_BOT_TOKEN' })).toContain('不在 Melina 认的凭证名单里');
    expect(credentialIssue({ env: 'SLACK_BOT_TOKEN' })).toContain('文件形式');
  });

  it('文件：要绝对路径，不能放在 /、/workspace、/melina、/run/melina 下面', () => {
    expect(credentialIssue({ file: '/run/secrets/slack' })).toBeUndefined();
    expect(credentialIssue({ file: 'secrets/slack' })).toContain('绝对路径');
    expect(credentialIssue({ file: '/workspace/.env' })).toContain('/workspace');
    expect(credentialIssue({ file: '/run/secrets/../melina/x' })).toContain('/run/melina');
  });
});

describe('设置页上的凭证', () => {
  function pageText(settings: Settings): string {
    globalThis.fetch = (async () => new Promise<Response>(() => {})) as typeof fetch; // 数据由 setResource 放进去
    const stop = subscribeResource(SETTINGS, () => {});
    setResource(SETTINGS.key, settings);
    const html = renderToStaticMarkup(<SettingsPage />);
    stop();
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  }

  it('已保存的凭证展示注入位置和值状态，并允许修改给法', () => {
    const text = pageText({
      notify: true,
      credentials: [
        { id: '01M3CRCRCRCRCRCRCRCRCRCRC0', name: 'Slack', as: { file: '/run/secrets/slack' }, hasValue: true },
        { id: '01M3CRCRCRCRCRCRCRCRCRCRC1', name: 'GitHub', as: { env: 'GITHUB_TOKEN' }, hasValue: true },
      ],
    });
    expect(text).toContain('/run/secrets/slack');
    expect(text).toContain('GITHUB_TOKEN');
    expect(text.match(/已保存/g)).toHaveLength(2);
    expect(text.match(/改给法/g)).toHaveLength(2);
  });
});
