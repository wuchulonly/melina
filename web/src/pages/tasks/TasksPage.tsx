// 任务页：页头右边「新建任务」，下面是列表。新建、接着做都在弹窗里（NewTaskDialog.tsx），不占列表上面的地方。

import { NewTaskLink } from '../../app/new-task.tsx';
import { Icon } from '../../components/Icon.tsx';
import { TaskList } from './TaskList.tsx';
import './tasks.css';

export function TasksPage() {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="page-title">任务</h1>
          <p className="page-sub">
            写下目标就开始。Melina 先摸清情况、起草完成标准，再一步步推进；觉得难了会自己开几条路一起试。
          </p>
        </div>
        <NewTaskLink className="btn btn-primary">
          <Icon name="plus" size={16} />
          新建任务
        </NewTaskLink>
      </header>
      <TaskList />
    </div>
  );
}
