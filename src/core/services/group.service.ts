import { newId } from '../db/ids.ts';
import type { AuditRepo } from '../repositories/audit.repo.ts';
import type { GroupRepo } from '../repositories/group.repo.ts';
import type { Group } from '../../shared/types.ts';

/** 分组是纯组织手段，没有副作用，所以这里只有一层薄封装：校验 + 审计 */
export class GroupService {
  constructor(private readonly deps: { groups: GroupRepo; audit: AuditRepo }) {}

  list(): Group[] {
    return this.deps.groups.list();
  }

  create(name: string, sortOrder?: number): Group {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('分组名不能为空');
    const group = this.deps.groups.create(newId(), trimmed, sortOrder);
    this.deps.audit.log('group.create', null, { groupId: group.id, name: group.name });
    return group;
  }

  update(id: string, patch: { name?: string; sortOrder?: number }): Group {
    const group = this.deps.groups.update(id, {
      ...patch,
      ...(patch.name === undefined ? {} : { name: patch.name.trim() }),
    });
    this.deps.audit.log('group.update', null, { groupId: id, fields: Object.keys(patch) });
    return group;
  }

  /** 删组不删环境：组内环境会落回「未分组」，这一点在 UI 上要提示 */
  remove(id: string): void {
    this.deps.groups.remove(id);
    this.deps.audit.log('group.delete', null, { groupId: id });
  }
}
