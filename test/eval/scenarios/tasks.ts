// 九道业务探索题：目标明确，规则与正确结果需要实验确认。
import { aliasFixture, cacheFixture, publishFixture } from './delivery.ts';
import { solveAlias, solveCache, solvePublish } from './delivery-solve.ts';
import { type ScenarioDefinition, scenarioTask } from './kit.ts';
import { batchFixture, resumeFixture, snapshotFixture } from './records.ts';
import { solveBatch, solveResume, solveSnapshot } from './records-solve.ts';
import { inventoryFixture, refundFixture, settlementFixture } from './workflow.ts';
import { solveInventory, solveRefund, solveSettlement } from './workflow-solve.ts';

const DEFINITIONS: readonly ScenarioDefinition[] = [
  {
    id: 'web-export-snapshot',
    env: 'web',
    title: '结账导出的快照时点（难）',
    goal: '应用交接修正，在下一批数据到达前固定结账快照，并验证它在后续数据到达后仍保持原版次与金额。',
    controls: '比较原始普通读取、未完成作业下载、下一批实时读取与不同导出档位的结果。',
    answer: 'job_id、report_id、profile、revision、row_count、amount_cents、checksum',
    generate: snapshotFixture,
    solve: solveSnapshot,
  },
  {
    id: 'web-batch-dependencies',
    env: 'web',
    title: '订单到运单的批量依赖（难）',
    goal: '通过批量依赖引用取得目标订单对应的运单、标签和追踪号，确认实际采用的解析档位。',
    controls: '比较普通单项读取、依赖正序与倒序，以及支持和不支持引用的批量档位。',
    answer: 'order_id、shipment_id、label_id、tracking_code、profile、checksum',
    generate: batchFixture,
    solve: solveBatch,
  },
  {
    id: 'workflow-resume',
    env: 'workflow',
    title: '暂停工单的输入版本恢复（难）',
    goal: '将目标工单输入更新一次为交接数量，再从合适检查点恢复并完成工单。',
    controls: '使用控制工单验证普通恢复；比较旧检查点、不同档位预检和完成后重复恢复。',
    answer: 'case_id、job_id、input_revision、quantity、receipt',
    generate: resumeFixture,
    solve: solveResume,
  },
  {
    id: 'web-cache-consistency',
    env: 'web',
    title: '商品区域缓存的一致性（难）',
    goal: '把商品价格更新为交接值，定位陈旧兼容路径，并使所有区域副本达到同一新版本。',
    controls: '比较普通读取、更新后陈旧响应、局部失效和非法失效参数，再核对每个区域。',
    answer: 'product_id、revision、price_cents、checksum、stale_path、scope',
    generate: cacheFixture,
    solve: solveCache,
  },
  {
    id: 'web-resource-alias',
    env: 'web',
    title: '素材别名与修订版渲染（难）',
    goal: '沿素材别名查明实际资源，取得交接指定修订版的文本渲染结果及摘要。',
    controls: '比较普通素材清单、非法资源编号、缩略图，以及最新与指定修订的文本输出。',
    answer: 'render_id、initial_resource、final_resource、revision、profile、checksum、text',
    generate: aliasFixture,
    solve: solveAlias,
  },
  {
    id: 'workflow-version-restore',
    env: 'workflow',
    title: '历史版本的完整发布恢复（难）',
    goal: '把目标页面的正文和资源一起恢复到交接历史版次，并核对实际发布结果。',
    controls: '比较正常最新发布、非法版次、提前取结果和正文资源混合版次的发布档位。',
    answer: 'publication_id、page_id、revision、asset_revision、profile、checksum',
    generate: publishFixture,
    solve: solvePublish,
  },
  {
    id: 'workflow-refund-retry',
    env: 'workflow',
    title: '退款确认丢失后的重试对账（难）',
    goal: '完成两张批准退款工单并同步账本，确认每张工单恰好记账一次，金额和余额正确。',
    controls:
      '比较空账本、确认丢失后的同键重试、异工单同键冲突、原工单换键重复、非批准金额和过早对账；第二张工单按正常流程完成。',
    answer: 'order_id、refund_ids、refunded_cents、ledger_entries、remaining_cents、checksum',
    generate: refundFixture,
    solve: solveRefund,
  },
  {
    id: 'workflow-settlement-events',
    env: 'workflow',
    title: '迟到更正事件的结算关账（难）',
    goal: '从完整分页事件流确定最新更正后的结算金额，生成一致的预览并确认目标批次关账。',
    controls: '比较控制批次正常关账、事件未齐、旧批次版次和遗漏更正的预览确认，再读取最终批次状态。',
    answer: 'batch_id、preview_id、settlement_id、revision、gross_cents、refund_cents、fee_cents、net_cents、checksum',
    generate: settlementFixture,
    solve: solveSettlement,
  },
  {
    id: 'workflow-inventory-release',
    env: 'workflow',
    title: '库存预留的延迟释放（难）',
    goal: '在旧预留过期后释放它并刷新可售索引，保留有效预留，完成目标数量的订单并核对余量。',
    controls: '控制商品正常下单一件；比较目标库存不足、未过期释放失败和释放后陈旧索引，再读取实际订单。',
    answer: 'order_id、sku、units、remaining_available、checksum',
    generate: inventoryFixture,
    solve: solveInventory,
  },
];

export function businessTasks() {
  return DEFINITIONS.map(scenarioTask);
}
