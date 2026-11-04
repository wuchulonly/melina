import { expect, test } from '@playwright/test';

test('任务页显示独立路线并能查看交付', async ({ page, request }) => {
  await request.post('/__fake/reset', { data: { start: 'end', speed: 0 } });
  const { runs } = await (await request.get('/api/runs')).json();
  const run = runs.find((r: { status: string }) => r.status === 'done');
  await page.goto(`/runs/${run.id}`);
  await expect(page.getByRole('heading', { name: run.statement })).toBeVisible();
  await expect(page.getByText('直解 1', { exact: true })).toBeVisible();
});

test('模型设置仍使用当前模型接口', async ({ page }) => {
  await page.goto('/models');
  await expect(page.getByRole('heading', { name: '模型' })).toBeVisible();
});
