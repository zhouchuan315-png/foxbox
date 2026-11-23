import type { Db, SqlValue } from '../db/index.ts';
import type { Group } from '../../shared/types.ts';
import { conflict, notFound } from '../errors.ts';

const str = (v: SqlValue | undefined): string => (v == null ? '' : String(v));
const num = (v: SqlValue | undefined): number => (v == null ? 0 : Number(v));

const SELECT = `
  SELECT g.id, g.name, g.sort_order, g.created_at,
         (SELECT COUNT(*) FROM profiles p WHERE p.group_id = g.id AND p.deleted_at IS NULL) AS profile_count
  FROM groups g`;

function toGroup(row: Record<string, SqlValue>): Group {
  return {
    id: str(row.id),
    name: str(row.name),
    sortOrder: num(row.sort_order),
    createdAt: num(row.created_at),
    profileCount: num(row.profile_count),
  };
}

/**
 * 分组只是标签，不参与指纹一致性判断——
 * 但删组时必须把组内环境落到「未分组」而不是级联删除，
 * 否则用户点一下删除会连带丢掉环境。schema 里是 ON DELETE SET NULL。
 */
export class GroupRepo {
  constructor(private readonly db: Db) {}

  list(): Group[] {
    return this.db
      .prepare(`${SELECT} ORDER BY g.sort_order ASC, g.created_at ASC`)
      .all()
      .map(toGroup);
  }

  find(id: string): Group | undefined {
    const row = this.db.prepare(`${SELECT} WHERE g.id = ?`).get(id);
    return row ? toGroup(row) : undefined;
  }

  findOrThrow(id: string): Group {
    const group = this.find(id);
    if (!group) throw notFound(`分组不存在: ${id}`);
    return group;
  }

  create(id: string, name: string, sortOrder?: number, now = Date.now()): Group {
    const order = sortOrder ?? this.nextSortOrder();
    try {
      this.db
        .prepare('INSERT INTO groups (id, name, sort_order, created_at) VALUES (?, ?, ?, ?)')
        .run(id, name, order, now);
    } catch (error) {
      throw normalizeUniqueError(error, name);
    }
    return this.findOrThrow(id);
  }

  update(id: string, patch: { name?: string; sortOrder?: number }): Group {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.name !== undefined) {
      sets.push('name = ?');
      params.push(patch.name);
    }
    if (patch.sortOrder !== undefined) {
      sets.push('sort_order = ?');
      params.push(patch.sortOrder);
    }
    if (sets.length === 0) return this.findOrThrow(id);
    params.push(id);
    try {
      this.db.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    } catch (error) {
      throw normalizeUniqueError(error, patch.name ?? '');
    }
    return this.findOrThrow(id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  }

  private nextSortOrder(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS n FROM groups').get();
    return (row ? num(row.n) : 0) + 10;
  }
}

function normalizeUniqueError(error: unknown, name: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('UNIQUE')) return conflict(`分组名 "${name}" 已存在`);
  return new Error(message);
}
