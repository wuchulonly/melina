import { auditTask } from './audit/task.ts';

export function evalTasks() {
  return [auditTask()];
}
