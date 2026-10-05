/**
 * 清池单状态管理（Solid 原生能力）
 * 用 createStore 维护清池班开的清池单；开单 / 改期 / 作废 / 退场都联动走水重排（逻辑在 db 层事务里）。
 */
import { createMemo, createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { CleaningDraft, CleaningOrder, CleaningState } from '../types/cleaning';
import {
  applyCleaningOrder,
  completeCleaningOrder,
  db,
  initDatabase,
  putCleaningOrder,
  reallocateAllCleaning,
  removeCleaningOrder,
  voidCleaningOrder,
} from '../utils/db';
import { today, uuid } from '../utils/id';
import { ROW_REVISION } from '../utils/db';

/** 清池单筛选条件 */
export interface CleaningFilters {
  keyword: string;
  state: CleaningState | 'all';
}

const EMPTY_FILTERS: CleaningFilters = { keyword: '', state: 'all' };

interface CleaningState_ {
  rows: CleaningOrder[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function emptyDraft(pondId: string): CleaningDraft {
  return {
    pondId,
    enterDate: today(),
    exitDate: '',
    remainDepthCm: 8,
    crew: '',
    state: '清池中',
    note: '',
  };
}

function createCleaningStore() {
  const [state, setState] = createStore<CleaningState_>({
    rows: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [filters, setFilters] = createSignal<CleaningFilters>({ ...EMPTY_FILTERS });

  // 与 pondStore / observationStore 同一注意事项：建库放在 liveQuery querier 之外
  void initDatabase();

  liveQuery(async () => db.cleaningOrders.toArray()).subscribe({
    next: (list) => {
      setState(
        'rows',
        [...list].sort((a, b) => b.enterDate.localeCompare(a.enterDate) || a.pondId.localeCompare(b.pondId)),
      );
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取清池单失败' });
    },
  });

  function patchFilters(patch: Partial<CleaningFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  /** 某池当前是否挂着「清池中」单据 */
  function activeOrderOf(pondId: string): CleaningOrder | undefined {
    return state.rows.find((row) => row.pondId === pondId && row.state === '清池中');
  }

  const activeCount = createMemo(() => state.rows.filter((row) => row.state === '清池中').length);

  async function createOrder(draft: CleaningDraft): Promise<CleaningOrder | null> {
    const now = new Date().toISOString();
    const order: CleaningOrder = {
      id: uuid('cleaning'),
      pondId: draft.pondId,
      enterDate: draft.enterDate,
      exitDate: draft.exitDate,
      remainDepthCm: draft.remainDepthCm,
      crew: draft.crew.trim(),
      state: '清池中',
      backfilled: false,
      note: draft.note.trim(),
      createdAt: now,
      updatedAt: now,
      revision: ROW_REVISION,
    };
    const result = await applyCleaningOrder(order);
    setState(
      'lastMessage',
      `清池单已开：影响 ${result.affected} 条走水编排，挪走 ${result.moved} 条、排队 ${result.queued} 条` +
        (result.shortTotal > 0 ? `，合计缺 ${result.shortTotal} m³` : ''),
    );
    return order;
  }

  /** 改期 / 改清完水深：清池中单据按池重排；历史单据仅改备注等字段 */
  async function updateOrder(orderId: string, draft: CleaningDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === orderId);
    if (existing === undefined) return;
    // 编辑弹层不改状态：状态流转只走「登记退场 / 作废」，避免绕过走水联动
    const next: CleaningOrder = {
      ...existing,
      pondId: existing.pondId,
      enterDate: draft.enterDate,
      exitDate: draft.exitDate,
      remainDepthCm: draft.remainDepthCm,
      crew: draft.crew.trim(),
      note: draft.note.trim(),
    };
    if (existing.state === '清池中') {
      const result = await applyCleaningOrder(next);
      setState(
        'lastMessage',
        `清池单已改期并按池重排：影响 ${result.affected} 条，挪走 ${result.moved} 条、排队 ${result.queued} 条` +
          (result.shortTotal > 0 ? `，合计缺 ${result.shortTotal} m³` : ''),
      );
    } else {
      await putCleaningOrder(next);
      setState('lastMessage', '历史清池单已更新（不联动走水重排）');
    }
  }

  async function voidOrder(orderId: string): Promise<void> {
    await voidCleaningOrder(orderId);
    setState('lastMessage', '清池单已作废，挂在它上面的走水编排已回原池并按池重排');
  }

  async function completeOrder(orderId: string, remainDepthCm: number): Promise<void> {
    await completeCleaningOrder(orderId, remainDepthCm);
    setState('lastMessage', `已登记退场：池恢复在用，有效水深回写为 ${remainDepthCm} cm，排队计划回到原池待调度`);
  }

  async function reallocateAll(): Promise<void> {
    const result = await reallocateAllCleaning();
    setState(
      'lastMessage',
      `已按池整体重排：挪走 ${result.moved} 条、排队 ${result.queued} 条` +
        (result.shortTotal > 0 ? `，合计缺 ${result.shortTotal} m³` : '，容量足够'),
    );
  }

  async function deleteOrder(orderId: string): Promise<void> {
    await removeCleaningOrder(orderId);
    setState('lastMessage', '清池单已删除（仅历史单据可删）');
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    setMessage,
    activeOrderOf,
    activeCount,
    createOrder,
    updateOrder,
    voidOrder,
    completeOrder,
    reallocateAll,
    deleteOrder,
    emptyDraft,
  };
}

const store = createRoot(createCleaningStore);

export function useCleaningStore() {
  return store;
}
