/**
 * /cleaning 清池班清池单
 * 在蒸发池上开清池单（进场/退场日期、清完水深），联动走水重排；
 * 未退场前这口池算清池中。底部按池号与调度室台账对账。
 * 消费模型：CleaningOrder、Pond、Schedule；复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>、<StageTag>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { useCleaningStore } from '../stores/cleaningStore';
import { usePondStore } from '../stores/pondStore';
import { CLEANING_STATE_OPTIONS, type CleaningOrder, type CleaningState } from '../types/cleaning';
import { today } from '../utils/id';
// 受纳容量与清池窗口口径与 db 层重排一致
import { inCleaningWindow } from '../utils/cleaningPlanner';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const ORDER_STATE_STYLE: Record<CleaningState, string> = {
  清池中: 'border-rose-300 bg-rose-50 text-rose-700',
  已清完: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  已作废: 'border-slate-300 bg-slate-100 text-slate-500',
};

export default function CleaningBoard() {
  const store = useCleaningStore();
  const pondStore = usePondStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [completing, setCompleting] = createSignal<CleaningOrder | null>(null);
  const [completeDepth, setCompleteDepth] = createSignal(8);
  const [voiding, setVoiding] = createSignal<CleaningOrder | null>(null);
  const [draft, setDraft] = createStore(store.emptyDraft(''));

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  /** 该单据联动出去的走水计划（挪入他池 + 排队） */
  const affectedSchedules = (orderId: string) =>
    pondStore.state.schedules.filter((row) => row.cleaningOrderId === orderId);

  const filtered = createMemo<CleaningOrder[]>(() => {
    const current = store.filters();
    const keyword = current.keyword.trim().toLowerCase();
    return store.state.rows.filter((order) => {
      if (current.state !== 'all' && order.state !== current.state) return false;
      if (keyword === '') return true;
      const pond = pondOf(order.pondId);
      return (
        (pond ? `${pond.code} ${pond.seriesName}` : '').toLowerCase().includes(keyword) ||
        order.crew.toLowerCase().includes(keyword) ||
        order.note.toLowerCase().includes(keyword)
      );
    });
  });

  const stats = createMemo(() => {
    const rows = store.state.rows;
    const active = rows.filter((r) => r.state === '清池中');
    const queuedSchedules = pondStore.state.schedules.filter((row) => row.queued === true);
    const shortTotal = Math.round(queuedSchedules.reduce((acc, row) => acc + (row.shortM3 ?? 0), 0) * 10) / 10;
    const backfilled = rows.filter((r) => r.backfilled).length;
    return {
      active: active.length,
      done: rows.filter((r) => r.state === '已清完').length,
      void: rows.filter((r) => r.state === '已作废').length,
      queued: queuedSchedules.length,
      shortTotal,
      backfilled,
    };
  });

  /** 两边按池号对账：清池单口径（单据状态=清池中）vs 台账口径 */
  const reconciliation = createMemo(() => {
    return pondStore.state.ponds.map((pond) => {
      const order = pondStore.state.cleaningOrders.find((o) => o.pondId === pond.id && o.state === '清池中');
      const orderSaysCleaning = order !== undefined;
      const ledgerSaysCleaning = pond.status === '清池中';
      return {
        pond,
        order,
        matched: orderSaysCleaning === ledgerSaysCleaning,
        moved: pondStore.state.schedules.filter(
          (row) => row.cleaningOrderId === order?.id && row.queued !== true && row.pondId !== pond.id,
        ).length,
        queued: pondStore.state.schedules.filter((row) => row.cleaningOrderId === order?.id && row.queued === true).length,
      };
    });
  });

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(store.emptyDraft(pondId));
    setDialogOpen(true);
  };

  const openEdit = (order: CleaningOrder): void => {
    setEditingId(order.id);
    setDraft({
      pondId: order.pondId,
      enterDate: order.enterDate,
      exitDate: order.exitDate,
      remainDepthCm: order.remainDepthCm,
      crew: order.crew,
      state: order.state,
      note: order.note,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      store.setMessage('请选择要清的蒸发池');
      return;
    }
    if (draft.exitDate !== '' && draft.exitDate < draft.enterDate) {
      store.setMessage('退场日期不能早于进场日期');
      return;
    }
    if (editingId() === null) {
      await store.createOrder({ ...draft });
    } else {
      await store.updateOrder(editingId() as string, { ...draft });
    }
    setDialogOpen(false);
  };

  const confirmVoid = async (): Promise<void> => {
    const order = voiding();
    if (order === null) return;
    await store.voidOrder(order.id);
    setVoiding(null);
  };

  const confirmComplete = async (remainDepthCm: number): Promise<void> => {
    const order = completing();
    if (order === null) return;
    await store.completeOrder(order.id, remainDepthCm);
    setCompleting(null);
  };

  const openComplete = (order: CleaningOrder): void => {
    setCompleteDepth(order.remainDepthCm);
    setCompleting(order);
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="清池中" value={stats().active} suffix="口" tone="danger" />
        <StatBadge label="已清完" value={stats().done} suffix="单" tone="success" />
        <StatBadge label="已作废" value={stats().void} suffix="单" tone="default" />
        <StatBadge label="走水排队待排" value={stats().queued} suffix="条" tone="warning" />
        <StatBadge label="排队缺口" value={stats().shortTotal} suffix="m³" tone="danger" hint="各受纳池合计仍缺的受纳容量" />
        <StatBadge label="升级回填单" value={stats().backfilled} suffix="单" tone="info" hint="旧数据无清池单，按池子当时状态回填" />
      </div>

      <Show when={store.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {store.state.lastMessage}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">清池班清池单</h2>
          <div class="flex flex-wrap gap-2">
            <button class={BTN_GHOST} onClick={() => void store.reallocateAll()}>
              按池重排
            </button>
            <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
              + 开清池单
            </button>
          </div>
        </header>

        <FilterBar
          keyword={store.filters().keyword}
          onKeyword={(value) => store.patchFilters({ keyword: value })}
          fields={[{ key: 'state', label: '状态', options: [...CLEANING_STATE_OPTIONS] }]}
          values={{ state: store.filters().state }}
          onChange={(key, value) => {
            if (key === 'state') store.patchFilters({ state: value as CleaningState | 'all' });
          }}
          onReset={() => store.resetFilters()}
          resultText={`命中 ${filtered().length} / ${store.state.rows.length} 单`}
        />

        <p class="mb-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          清池单写清进场 / 退场日期与清完水深：进场到退场（含未填退场）这口池算「清池中」。窗口内未走水的走水编排自动退回待排，
          走水中 / 已出卤的照走完；其余按受纳容量挪到同池系其他在用池，挪不下排队并写明缺多少方。改期或作废后按池重排。
        </p>

        <Show when={store.state.rows.length === 0}>
          <EmptyPanel
            title="还没有清池单"
            description="清池班进场清池前在这里开单：选池、填进场与预计退场日期、清完水深。系统会自动把挂在该池上的走水编排挪到同池系其他在用池，容量不够就排队并标出缺口。"
            actionText="开第一张清池单"
            onAction={openCreate}
          />
        </Show>

        <Show when={store.state.rows.length > 0}>
          <div class="space-y-2.5">
            <For each={filtered()}>
              {(order) => {
                const affected = () => affectedSchedules(order.id);
                const moved = () => affected().filter((row) => row.queued !== true);
                const queued = () => affected().filter((row) => row.queued === true);
                const overdue = () =>
                  order.state === '清池中' &&
                  order.exitDate !== '' &&
                  order.exitDate < today() &&
                  inCleaningWindow(today(), order.enterDate, order.exitDate);
                return (
                  <article class="rounded-lg border border-slate-200 bg-slate-50/60 p-3.5">
                    <div class="flex flex-wrap items-start justify-between gap-3">
                      <div class="min-w-[220px]">
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="text-sm font-semibold text-slate-800">{pondLabel(order.pondId)}</span>
                          <StageTag stage={pondOf(order.pondId)?.stage ?? null} size="sm" />
                          <span class={`rounded border px-1.5 py-0.5 text-[11px] ${ORDER_STATE_STYLE[order.state]}`}>
                            {order.state}
                          </span>
                          <Show when={order.backfilled}>
                            <span class="rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 text-[11px] text-sky-700">
                              升级回填
                            </span>
                          </Show>
                          <Show when={overdue()}>
                            <span class="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">
                              已过退场日
                            </span>
                          </Show>
                        </div>
                        <p class="mt-1 text-xs text-slate-500">
                          进场 <span class="tabular-nums font-medium text-slate-700">{order.enterDate}</span>
                          {' → '}退场{' '}
                          <span class="tabular-nums font-medium text-slate-700">
                            {order.exitDate === '' ? '未约定' : order.exitDate}
                          </span>
                          {' · '}清完水深 <span class="tabular-nums font-medium text-slate-700">{order.remainDepthCm}</span> cm
                          {' · '}负责人 {order.crew === '' ? '未填写' : order.crew}
                        </p>
                        <Show when={order.note !== ''}>
                          <p class="mt-0.5 text-xs text-slate-400">{order.note}</p>
                        </Show>
                      </div>

                      <div class="flex flex-wrap items-center gap-2">
                        <button
                          class="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50"
                          disabled={order.state !== '清池中'}
                          onClick={() => openComplete(order)}
                        >
                          登记退场
                        </button>
                        <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(order)}>
                          改期/编辑
                        </button>
                        <button
                          class="text-xs text-rose-600 hover:underline disabled:opacity-40"
                          disabled={order.state !== '清池中'}
                          onClick={() => setVoiding(order)}
                        >
                          作废
                        </button>
                      </div>
                    </div>

                    <Show when={affected().length > 0}>
                      <div class="mt-2.5 rounded-md border border-slate-200 bg-white p-2.5">
                        <p class="mb-1.5 text-[11px] font-medium text-slate-500">
                          联动走水编排：挪走 {moved().length} 条 · 排队 {queued().length} 条
                        </p>
                        <ul class="space-y-1">
                          <For each={affected()}>
                            {(row) => {
                              const target = pondOf(row.pondId);
                              return (
                                <li class="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                                  <span class="tabular-nums">{row.planDate}</span>
                                  <span>{row.volumeM3} m³</span>
                                  <span class={`rounded border px-1.5 py-px text-[10px] ${
                                    row.state === '走水中'
                                      ? 'border-amber-300 bg-amber-50 text-amber-700'
                                      : 'border-slate-300 bg-slate-50 text-slate-600'
                                  }`}>
                                    {row.state}
                                  </span>
                                  <Show
                                    when={row.queued === true}
                                    fallback={
                                      <span>
                                        挪至 <span class="font-medium text-brine-700">{target?.code ?? '—'}</span>
                                      </span>
                                    }
                                  >
                                    <span class="font-medium text-rose-700">
                                      排队待排，受纳容量缺 {row.shortM3 ?? 0} m³（仍挂 {pondOf(row.originPondId ?? row.pondId)?.code ?? '原池'}）
                                    </span>
                                  </Show>
                                </li>
                              );
                            }}
                          </For>
                        </ul>
                      </div>
                    </Show>
                  </article>
                );
              }}
            </For>
          </div>
        </Show>
      </section>

      {/* 两边按池号对账：清池单口径 vs 调度室台账口径 */}
      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">按池号对账（清池班 ↔ 调度室台账）</h2>
          <button class={BTN_GHOST} onClick={() => void store.reallocateAll()}>
            对账不一致时按池重排
          </button>
        </header>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th class="px-3 py-2">池号</th>
                <th class="px-3 py-2">池系 / 阶段</th>
                <th class="px-3 py-2">清池单口径</th>
                <th class="px-3 py-2">台账状态</th>
                <th class="px-3 py-2 text-right">已挪走</th>
                <th class="px-3 py-2 text-right">排队</th>
                <th class="px-3 py-2">对账</th>
              </tr>
            </thead>
            <tbody>
              <For each={reconciliation()}>
                {(item) => (
                  <tr class="border-b border-slate-100 align-middle hover:bg-slate-50/60">
                    <td class="px-3 py-2.5 font-medium text-slate-800">{item.pond.code}</td>
                    <td class="px-3 py-2.5">
                      <div class="flex items-center gap-2">
                        <span class="text-xs text-slate-500">{item.pond.seriesName}</span>
                        <StageTag stage={item.pond.stage} size="sm" />
                      </div>
                    </td>
                    <td class="px-3 py-2.5 text-xs">
                      <Show
                        when={item.order !== undefined}
                        fallback={<span class="text-slate-400">无有效清池单</span>}
                      >
                        <span class="text-rose-700">清池中</span>
                        <span class="ml-1 tabular-nums text-slate-500">
                          {item.order?.enterDate} ~ {item.order?.exitDate === '' ? '未定' : item.order?.exitDate}
                        </span>
                      </Show>
                    </td>
                    <td class="px-3 py-2.5 text-xs">
                      <StageTag stage={null} status={item.pond.status} size="sm" />
                    </td>
                    <td class="px-3 py-2.5 text-right tabular-nums text-slate-600">{item.moved}</td>
                    <td class="px-3 py-2.5 text-right tabular-nums text-slate-600">{item.queued}</td>
                    <td class="px-3 py-2.5">
                      <span
                        class={`rounded border px-1.5 py-0.5 text-[11px] ${
                          item.matched
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                            : 'border-rose-300 bg-rose-50 text-rose-700'
                        }`}
                      >
                        {item.matched ? '一致' : '不一致'}
                      </span>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <p class="mt-2 text-xs text-slate-400">
          调度室这份台账自己留：清池单开 / 改期 / 作废 / 退场后会自动按池重排，台账状态以有效清池单为准。
        </p>
      </section>

      {/* 新建 / 编辑清池单 */}
      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '开清池单' : '改期 / 编辑清池单'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submit()}>
              保存并联动重排
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池{editingId() !== null ? '（已开单据不可改池，如需换池请作废后重开）' : ''}</span>
            <select
              class={INPUT}
              value={draft.pondId}
              disabled={editingId() !== null}
              onChange={(event) => setDraft('pondId', event.currentTarget.value)}
            >
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id} disabled={editingId() === null && pondStore.activeCleaningOrder(pond.id) !== undefined}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                    {pondStore.activeCleaningOrder(pond.id) !== undefined ? '（清池中）' : ''}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>清池负责人</span>
            <input class={INPUT} value={draft.crew} onInput={(event) => setDraft('crew', event.currentTarget.value)} placeholder="清池班带班人" />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>进场日期</span>
            <input type="date" class={INPUT} value={draft.enterDate} onInput={(event) => setDraft('enterDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>预计退场日期（可留空）</span>
            <input type="date" class={INPUT} value={draft.exitDate} onInput={(event) => setDraft('exitDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>清完后剩余水深（cm）</span>
            <input
              type="number"
              min="0"
              step="1"
              class={INPUT}
              value={draft.remainDepthCm}
              onInput={(event) => setDraft('remainDepthCm', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>单据状态（在列表用「登记退场 / 作废」流转）</span>
            <input class={`${INPUT} bg-slate-50 text-slate-500`} value={draft.state} readonly />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注</span>
            <input class={INPUT} value={draft.note} onInput={(event) => setDraft('note', event.currentTarget.value)} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          保存后按池重排：清池窗口内未走水的走水编排退回待排并挪到同池系其他在用池（走水中 / 已出卤不动），
          受纳容量不够的排队并写明缺口方数；清完水深在「登记退场」时回写为该池有效水深。
        </p>
      </AppDialog>

      {/* 退场登记 */}
      <AppDialog
        open={completing() !== null}
        title="登记清池退场"
        width="max-w-lg"
        onClose={() => setCompleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setCompleting(null)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void confirmComplete(completeDepth())}>
              确认退场并恢复在用
            </button>
          </>
        }
      >
        <div class="space-y-3 text-sm text-slate-600">
          <p>
            {pondOf(completing()?.pondId ?? '') === null
              ? '该池'
              : `${pondOf(completing()?.pondId ?? '')?.code}（${pondOf(completing()?.pondId ?? '')?.seriesName}）`}
            退场后恢复「在用」，有效水深按实测清完水深回写；排队待排的走水编排回到原池待调度。
          </p>
          <label class="flex items-center gap-2 text-[13px]">
            <span>清完后剩余水深（cm）</span>
            <input
              type="number"
              min="0"
              step="1"
              class="w-28 rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500"
              value={completeDepth()}
              onInput={(event) => setCompleteDepth(Number(event.currentTarget.value))}
            />
          </label>
        </div>
      </AppDialog>

      {/* 作废确认 */}
      <AppDialog
        open={voiding() !== null}
        title="作废清池单？"
        width="max-w-lg"
        onClose={() => setVoiding(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setVoiding(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmVoid()}>
              确认作废
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          作废「{pondLabel(voiding()?.pondId ?? '')}」的清池单后，挂在它上面、被挪到他池或排队的走水编排会回到原池，
          并按其余有效清池单重新按池重排。
        </p>
      </AppDialog>
    </div>
  );
}
