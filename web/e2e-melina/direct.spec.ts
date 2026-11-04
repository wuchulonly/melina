import { createTask, expect, test } from './melina.ts';

test('真实 direct 演示经执行记录交付文件', async ({ page, melina }) => {
  await page.goto(melina.url);
  const id = await createTask(page, '创建演示说明');
  await expect
    .poll(async () => {
      const res = await page.request.get(`${melina.url}/api/runs/${id}`);
      return ((await res.json()) as { run: { status: string } }).run.status;
    })
    .toBe('done');
  await page.reload();
  const res = await page.request.get(`${melina.url}/api/runs/${id}`);
  const summary = (await res.json()) as { branches: { bet: { label: string } }[] };
  expect(summary.branches).toHaveLength(3);
  for (const branch of summary.branches)
    await expect(page.getByRole('button', { name: branch.bet.label, exact: true })).toBeVisible();
});
