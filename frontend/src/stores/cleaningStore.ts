/**
 * 清池班状态管理（Solid 原生能力）
 * 用 createSignal 维护清池单列表与筛选；开单 / 改期 / 退场 / 作废后，
 * 由 utils/db 在同一事务内同步池状态并按池重排走水编排（退回待排 / 挪水 / 排队缺方）。
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { liveQuery } from 'dexie';
import type { CleaningDraft, CleaningOrder, CleaningState } from '../types/cleaning';
import {
  CleaningConflictError,
  completeCleaningOrder,
  db,
  initDatabase,
  removeCleaningOrder,
  runCleaningReplan,
  saveCleaningOrder,
  voidCleaningOrder,
} from '../utils/db';
import { nowIso, today, uuid } from '../utils/id';

/** 清池单筛选条件 */
export interface CleaningFilters {
  keyword: string;
  seriesName: string | 'all';
  state: CleaningState | 'all';
}

const EMPTY_FILTERS: CleaningFilters = { keyword: '', seriesName: 'all', state: 'all' };

function createCleaningStore() {
  const [rows, setRows] = createSignal<CleaningOrder[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [lastMessage, setLastMessage] = createSignal('');
  const [filters, setFilters] = createSignal<CleaningFilters>({ ...EMPTY_FILTERS });

  // 与 observationStore 同理：建库必须放在 liveQuery querier 外，否则订阅采集不到可观测集合。
  void initDatabase();

  liveQuery(async () => db.cleaningOrders.toArray()).subscribe({
    next: (list) => {
      setRows(
        [...list].sort((a, b) => b.entryDate.localeCompare(a.entryDate) || b.createdAt.localeCompare(a.createdAt)),
      );
      setLoading(false);
      setError('');
    },
    error: (err: unknown) => {
      setError(err instanceof Error ? err.message : '读取清池单失败');
      setLoading(false);
    },
  });

  function patchFilters(patch: Partial<CleaningFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  /** 按池号 / 池系 / 班组长 / 备注过滤 */
  function visible(pondLabels: Map<string, string>): CleaningOrder[] {
    const current = filters();
    const keyword = current.keyword.trim().toLowerCase();
    return rows().filter((order) => {
      if (current.state !== 'all' && order.state !== current.state) return false;
      const label = pondLabels.get(order.pondId) ?? '';
      if (current.seriesName !== 'all' && !label.includes(current.seriesName)) return false;
      if (keyword === '') return true;
      return (
        label.toLowerCase().includes(keyword) ||
        order.crewLeader.toLowerCase().includes(keyword) ||
        order.note.toLowerCase().includes(keyword) ||
        order.entryDate.includes(keyword) ||
        (order.exitDate !== '' && order.exitDate.includes(keyword))
      );
    });
  }

  function emptyDraft(pondId: string): CleaningDraft {
    return {
      pondId,
      entryDate: today(),
      exitDate: '',
      residualDepthCm: 10,
      crewLeader: '',
      note: '',
    };
  }

  /** 开单 / 改期 / 改正水深：保存后按池重排 */
  async function saveOrder(draft: CleaningDraft, editingId: string | null): Promise<boolean> {
    const stamp = nowIso();
    const existing = editingId === null ? null : rows().find((row) => row.id === editingId) ?? null;
    const row: CleaningOrder = {
      id: existing?.id ?? uuid('clean'),
      pondId: draft.pondId,
      entryDate: draft.entryDate,
      exitDate: draft.exitDate,
      residualDepthCm: draft.residualDepthCm,
      crewLeader: draft.crewLeader.trim(),
      note: draft.note.trim(),
      // 退场日期一旦填写视为退场；清池班也可先开单不退场（exitDate 为空 = 清池中）
      state: draft.exitDate !== '' && draft.entryDate !== '' && draft.exitDate >= draft.entryDate ? '已退场' : '清池中',
      backfilled: existing?.backfilled ?? false,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      revision: 3,
    };
    try {
      const result = await saveCleaningOrder(row);
      setLastMessage(summarize(`清池单已保存（${row.state}）`, result));
      return true;
    } catch (err) {
      if (err instanceof CleaningConflictError) setLastMessage(err.message);
      else setLastMessage(err instanceof Error ? err.message : '保存清池单失败');
      return false;
    }
  }

  /** 退场登记：写退场日期与清完水深，编排归位重排 */
  async function complete(orderId: string, exitDate: string, residualDepthCm: number): Promise<void> {
    const result = await completeCleaningOrder(orderId, exitDate, residualDepthCm);
    setLastMessage(summarize(`已登记退场（清完剩 ${residualDepthCm} cm）`, result));
  }

  /** 作废清池单：按池重排 */
  async function voidOrder(orderId: string): Promise<void> {
    const result = await voidCleaningOrder(orderId);
    setLastMessage(summarize('清池单已作废，编排已按池重排', result));
  }

  async function deleteOrder(orderId: string): Promise<void> {
    const result = await removeCleaningOrder(orderId);
    setLastMessage(summarize('清池单已删除', result));
  }

  /** 手工重排（池状态调整 / 编排改派后兜底） */
  async function replan(): Promise<void> {
    const result = await runCleaningReplan();
    setLastMessage(summarize('已按清池单重新对账重排', result));
  }

  const stats = createMemo(() => {
    const list = rows();
    return {
      total: list.length,
      active: list.filter((row) => row.state === '清池中').length,
      exited: list.filter((row) => row.state === '已退场').length,
      voided: list.filter((row) => row.state === '已作废').length,
      backfilled: list.filter((row) => row.backfilled).length,
    };
  });

  return {
    rows,
    loading,
    error,
    lastMessage,
    setLastMessage,
    filters,
    patchFilters,
    resetFilters,
    visible,
    emptyDraft,
    saveOrder,
    complete,
    voidOrder,
    deleteOrder,
    replan,
    stats,
  };
}

function summarize(prefix: string, result: { returnedCount: number; relocatedCount: number; queuedCount: number; totalShortfallM3: number; runningUntouchedCount: number } | null): string {
  if (result === null) return prefix;
  return `${prefix}：退回待排 ${result.returnedCount} 条，挪走 ${result.relocatedCount} 条，排队 ${result.queuedCount} 条（缺 ${result.totalShortfallM3} m³），走水中照走完 ${result.runningUntouchedCount} 条`;
}

const store = createRoot(createCleaningStore);

export function useCleaningStore() {
  return store;
}
