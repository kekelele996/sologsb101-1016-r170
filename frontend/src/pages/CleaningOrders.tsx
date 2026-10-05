/**
 * /cleaning 清池班：蒸发池清池单
 * 清池班在蒸发池上开清池单（进场 / 退场日期、清完水深、班组长）。
 * 没退场前该池算「清池中」：挂在它上面的走水编排退回待排，走水中的照走完，
 * 其余挪到同池系别的在用池，挪不下按受纳容量排队并写明缺多少方；两边按池号对账。
 * 清池单改期 / 作废后按池重排。调度室那份（/schedules）自己留底，本页只管开单与对账。
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
import { CLEANING_STATE_OPTIONS, type CleaningDraft, type CleaningOrder, type CleaningState } from '../types/cleaning';
import { isOrderActive } from '../types/cleaning';
import { pondVolumeM3 } from '../utils/brine';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const STATE_STYLE: Record<CleaningState, string> = {
  清池中: 'border-rose-300 bg-rose-50 text-rose-700',
  已退场: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  已作废: 'border-slate-300 bg-slate-100 text-slate-500',
};

export default function CleaningOrders() {
  const pondStore = usePondStore();
  const cleaningStore = useCleaningStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [exitTarget, setExitTarget] = createSignal<CleaningOrder | null>(null);
  const [voidTarget, setVoidTarget] = createSignal<CleaningOrder | null>(null);
  const [deleteTarget, setDeleteTarget] = createSignal<CleaningOrder | null>(null);
  const [draft, setDraft] = createStore<CleaningDraft>(cleaningStore.emptyDraft(''));
  const [exitDate, setExitDate] = createSignal(today());
  const [residual, setResidual] = createSignal(10);

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (order: CleaningOrder): string => {
    const pond = pondOf(order.pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };
  const labelMap = createMemo(() => new Map(pondStore.state.ponds.map((pond) => [pond.id, `${pond.code} · ${pond.seriesName}`])));

  /** 可开单的池：在用 / 清池中（停用池先在台账启用）；已被生效单占用的给出标记 */
  const openablePonds = createMemo(() => pondStore.state.ponds.filter((pond) => pond.status !== '停用'));

  const openCreate = (): void => {
    const first = openablePonds().find((pond) => pondStore.activeOrderOf(pond.id) === null) ?? openablePonds()[0];
    setEditingId(null);
    setDraft(cleaningStore.emptyDraft(first?.id ?? ''));
    setDialogOpen(true);
  };

  const openEdit = (order: CleaningOrder): void => {
    setEditingId(order.id);
    setDraft({
      pondId: order.pondId,
      entryDate: order.entryDate,
      exitDate: order.exitDate,
      residualDepthCm: order.residualDepthCm,
      crewLeader: order.crewLeader,
      note: order.note,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      cleaningStore.setLastMessage('请选择要清的蒸发池');
      return;
    }
    if (draft.entryDate === '') {
      cleaningStore.setLastMessage('请填写进场日期');
      return;
    }
    if (draft.exitDate !== '' && draft.exitDate < draft.entryDate) {
      cleaningStore.setLastMessage('退场日期不能早于进场日期');
      return;
    }
    const ok = await cleaningStore.saveOrder({ ...draft }, editingId());
    if (ok) setDialogOpen(false);
  };

  const confirmExit = async (): Promise<void> => {
    const order = exitTarget();
    if (order === null) return;
    await cleaningStore.complete(order.id, exitDate(), residual());
    setExitTarget(null);
  };

  const confirmVoid = async (): Promise<void> => {
    const order = voidTarget();
    if (order === null) return;
    await cleaningStore.voidOrder(order.id);
    setVoidTarget(null);
  };

  const confirmDelete = async (): Promise<void> => {
    const order = deleteTarget();
    if (order === null) return;
    await cleaningStore.deleteOrder(order.id);
    setDeleteTarget(null);
  };

  /** 某张生效单的对账数据：挂在这口池上的走水编排去向 */
  const reconciliation = (order: CleaningOrder) => {
    const homeSchedules = pondStore.state.schedules.filter(
      (row) => (row.homePondId || row.pondId) === order.pondId && row.state !== '已出卤',
    );
    const running = homeSchedules.filter((row) => row.state === '走水中');
    const relocated = homeSchedules.filter((row) => row.disposition === '已挪池');
    const queued = homeSchedules.filter((row) => row.disposition === '排队待容');
    // 已退回待排但仍挂本池（极端情况下同池系无别的在用池，也会排队，所以这里只剩排队/本池）
    const returnedHome = homeSchedules.filter(
      (row) => row.disposition !== '已挪池' && row.state !== '走水中' && row.disposition !== '排队待容',
    );
    // 别的池清池后挪进本池的编排（本池作为受纳池）
    const inbound = pondStore.state.schedules.filter(
      (row) => row.pondId === order.pondId && (row.homePondId || row.pondId) !== order.pondId,
    );
    return { running, relocated, queued, returnedHome, inbound };
  };

  /** 同池系在用池的剩余受纳容量（供对账面板展示，解释为什么排队） */
  const seriesCapacity = (order: CleaningOrder): Array<{ code: string; freeM3: number }> => {
    const pond = pondOf(order.pondId);
    if (pond === null) return [];
    return pondStore.state.ponds
      .filter((candidate) => candidate.seriesName === pond.seriesName && candidate.id !== pond.id && candidate.status === '在用')
      .map((candidate) => {
        const latest = pondStore.state.observations
          .filter((obs) => obs.pondId === candidate.id)
          .sort((a, b) => a.date.localeCompare(b.date))
          .at(-1);
        const total = pondVolumeM3(candidate.areaM2, candidate.depthCm);
        const current = latest === undefined ? total : pondVolumeM3(candidate.areaM2, Math.min(latest.levelCm, candidate.depthCm));
        return { code: candidate.code, freeM3: Math.max(0, Math.round((total - current) * 10) / 10) };
      });
  };

  const codeOf = (pondId: string): string => pondOf(pondId)?.code ?? '（已删池）';

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="清池单" value={cleaningStore.stats().total} suffix="张" tone="primary" />
        <StatBadge label="清池中" value={cleaningStore.stats().active} suffix="张" tone="danger" />
        <StatBadge label="已退场" value={cleaningStore.stats().exited} suffix="张" tone="success" />
        <StatBadge label="已作废" value={cleaningStore.stats().voided} suffix="张" tone="default" />
        <StatBadge
          label="升级回填单"
          value={cleaningStore.stats().backfilled}
          suffix="张"
          tone="warning"
          hint="旧系统没有清池单，升级到 v3 时按池当时状态（清池中）补的单"
        />
      </div>

      <Show when={cleaningStore.lastMessage() !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {cleaningStore.lastMessage()}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-[15px] font-semibold text-slate-800">清池班 · 蒸发池清池单</h2>
            <p class="mt-0.5 text-xs text-slate-500">
              没退场前这口池算「清池中」：未走水的编排退回待排并挪到同池系别的在用池，走水中的照走完，挪不下排队写明缺方；调度室在走水编排页按池号对账。
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <button type="button" class={BTN_GHOST} onClick={() => void cleaningStore.replan()}>
              按池重排对账
            </button>
            <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={openablePonds().length === 0}>
              + 开清池单
            </button>
          </div>
        </header>

        <FilterBar
          keyword={cleaningStore.filters().keyword}
          onKeyword={(value) => cleaningStore.patchFilters({ keyword: value })}
          fields={[
            { key: 'seriesName', label: '池系', options: pondStore.seriesOptions() },
            { key: 'state', label: '状态', options: [...CLEANING_STATE_OPTIONS] },
          ]}
          values={{ seriesName: cleaningStore.filters().seriesName, state: cleaningStore.filters().state }}
          onChange={(key, value) => {
            if (key === 'seriesName') cleaningStore.patchFilters({ seriesName: value as string | 'all' });
            if (key === 'state') cleaningStore.patchFilters({ state: value as CleaningState | 'all' });
          }}
          onReset={() => cleaningStore.resetFilters()}
          resultText={`命中 ${cleaningStore.visible(labelMap()).length} / ${cleaningStore.rows().length} 张`}
        />

        <Show when={cleaningStore.rows().length === 0}>
          <EmptyPanel
            title="还没有清池单"
            description="清池班在蒸发池上开单，写清进场 / 退场日期和清完水深。未退场期间该池自动算清池中，走水编排自动退回、挪水或排队。"
            actionText="开第一张清池单"
            onAction={openCreate}
          />
        </Show>

        <Show when={cleaningStore.rows().length > 0}>
          <ul class="space-y-3">
            <For each={cleaningStore.visible(labelMap())}>
              {(order) => {
                const rec = (): ReturnType<typeof reconciliation> => reconciliation(order);
                const pond = (): ReturnType<typeof pondOf> => pondOf(order.pondId);
                const capacities = (): Array<{ code: string; freeM3: number }> => seriesCapacity(order);
                return (
                  <li
                    class={`rounded-lg border bg-white p-4 ${
                      isOrderActive(order) ? 'border-rose-200 ring-1 ring-rose-100' : 'border-slate-200'
                    }`}
                  >
                    <div class="flex flex-wrap items-start justify-between gap-3">
                      <div class="flex items-start gap-3">
                        <div>
                          <p class="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                            {pondLabel(order)}
                            <StageTag stage={pond()?.stage ?? null} status={pond()?.status ?? null} size="sm" />
                            <span class={`rounded border px-2 py-0.5 text-[11px] ${STATE_STYLE[order.state]}`}>{order.state}</span>
                            <Show when={order.backfilled}>
                              <span class="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                                升级回填
                              </span>
                            </Show>
                          </p>
                          <p class="mt-1 text-xs text-slate-500">
                            进场 <span class="tabular-nums text-slate-700">{order.entryDate}</span> · 退场{' '}
                            <span class="tabular-nums text-slate-700">{order.exitDate === '' ? '未退场' : order.exitDate}</span> ·
                            清完水深 <span class="tabular-nums text-slate-700">{order.residualDepthCm || '—'}</span> cm · 班组长{' '}
                            {order.crewLeader === '' ? '未填写' : order.crewLeader}
                          </p>
                          <Show when={order.note !== ''}>
                            <p class="mt-0.5 text-xs text-slate-400">备注：{order.note}</p>
                          </Show>
                        </div>
                      </div>
                      <div class="flex flex-wrap items-center gap-2">
                        <Show when={isOrderActive(order)}>
                          <button
                            class="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700 transition hover:bg-emerald-100"
                            onClick={() => {
                              setExitTarget(order);
                              setExitDate(today());
                              setResidual(order.residualDepthCm || 10);
                            }}
                          >
                            登记退场
                          </button>
                          <button
                            class="rounded-md border border-rose-300 bg-rose-50 px-2.5 py-1 text-xs text-rose-700 transition hover:bg-rose-100"
                            onClick={() => setVoidTarget(order)}
                          >
                            作废
                          </button>
                        </Show>
                        <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(order)}>
                          {isOrderActive(order) ? '改期 / 修改' : '查看'}
                        </button>
                        <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleteTarget(order)}>
                          删除
                        </button>
                      </div>
                    </div>

                    {/* 两边按池号对账：这口池上走水编排的去向 */}
                    <Show when={isOrderActive(order)}>
                      <div class="mt-3 grid gap-2 rounded-lg border border-slate-200 bg-slate-50/70 p-3 text-xs sm:grid-cols-2 xl:grid-cols-4">
                        <div class="rounded-md border border-amber-200 bg-amber-50/70 p-2">
                          <p class="font-medium text-amber-800">走水中照走完（{rec().running.length}）</p>
                          <For each={rec().running}>
                            {(row) => (
                              <p class="mt-1 tabular-nums text-amber-700">
                                {row.planDate} · {row.volumeM3} m³
                                <Show when={row.disposition === '已挪池'}>（在 {codeOf(row.pondId)} 继续走）</Show>
                              </p>
                            )}
                          </For>
                        </div>
                        <div class="rounded-md border border-sky-200 bg-sky-50/70 p-2">
                          <p class="font-medium text-sky-800">已挪别的在用池（{rec().relocated.length}）</p>
                          <For each={rec().relocated}>
                            {(row) => (
                              <p class="mt-1 tabular-nums text-sky-700">
                                {row.planDate} · {row.volumeM3} m³ → {codeOf(row.pondId)}
                              </p>
                            )}
                          </For>
                        </div>
                        <div class="rounded-md border border-rose-200 bg-rose-50/70 p-2">
                          <p class="font-medium text-rose-800">排队待容（{rec().queued.length}）</p>
                          <For each={rec().queued}>
                            {(row) => (
                              <p class="mt-1 tabular-nums text-rose-700">
                                {row.planDate} · {row.volumeM3} m³ · 缺 <span class="font-semibold">{row.shortfallM3}</span> m³
                              </p>
                            )}
                          </For>
                        </div>
                        <div class="rounded-md border border-slate-200 bg-white p-2">
                          <p class="font-medium text-slate-700">同池系在用池空余受纳（m³）</p>
                          <Show
                            when={capacities().length > 0}
                            fallback={<p class="mt-1 text-slate-400">同池系没有别的在用池可受纳</p>}
                          >
                            <For each={capacities()}>
                              {(item) => (
                                <p class="mt-1 tabular-nums text-slate-600">
                                  {item.code} · 余 {item.freeM3} m³
                                </p>
                              )}
                            </For>
                          </Show>
                          <Show when={rec().inbound.length > 0}>
                            <p class="mt-2 border-t border-slate-100 pt-1 text-slate-500">
                              另有 {rec().inbound.length} 条别池清池后挪入本池
                            </p>
                          </Show>
                        </div>
                      </div>
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </section>

      {/* 开单 / 改期 */}
      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '开清池单' : '清池单改期 / 修改'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submit()}>
              保存并按池重排
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池（按池号对账）</span>
            <select class={INPUT} value={draft.pondId} onChange={(event) => setDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={openablePonds()}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                    {pondStore.activeOrderOf(pond.id) !== null ? '（已有未退场清池单）' : ''}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>班组长</span>
            <input class={INPUT} value={draft.crewLeader} onInput={(event) => setDraft('crewLeader', event.currentTarget.value)} placeholder="如：赵清" />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>进场日期</span>
            <input type="date" class={INPUT} value={draft.entryDate} onInput={(event) => setDraft('entryDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>退场日期（未退场留空）</span>
            <input type="date" class={INPUT} value={draft.exitDate} onInput={(event) => setDraft('exitDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>清完剩余水深（cm）</span>
            <input
              type="number"
              min="0"
              step="1"
              class={INPUT}
              value={draft.residualDepthCm}
              onInput={(event) => setDraft('residualDepthCm', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注</span>
            <input class={INPUT} value={draft.note} onInput={(event) => setDraft('note', event.currentTarget.value)} placeholder="清池原因 / 注意事项" />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          保存（或改期、退场、作废）后自动按池重排：该池未走水的走水编排退回待排，走水中的照走完，其余挪到同池系别的在用池，挪不下按受纳容量排队并写明缺多少方。
        </p>
      </AppDialog>

      {/* 退场登记 */}
      <AppDialog
        open={exitTarget() !== null}
        title="登记清池退场"
        width="max-w-lg"
        onClose={() => setExitTarget(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setExitTarget(null)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void confirmExit()}>
              确认退场并重排
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>退场日期</span>
            <input type="date" class={INPUT} value={exitDate()} onInput={(event) => setExitDate(event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>清完剩余水深（cm）</span>
            <input type="number" min="0" step="1" class={INPUT} value={residual()} onInput={(event) => setResidual(Number(event.currentTarget.value))} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          退场后该池恢复「在用」，之前退回 / 挪走 / 排队的编排归位原池并按池重新安排。
        </p>
      </AppDialog>

      {/* 作废确认 */}
      <AppDialog
        open={voidTarget() !== null}
        title="作废清池单？"
        width="max-w-lg"
        onClose={() => setVoidTarget(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setVoidTarget(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmVoid()}>
              确认作废
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将作废「{voidTarget() === null ? '' : pondLabel(voidTarget() as CleaningOrder)}」的清池单，池子恢复在用，之前退回 / 挪走 / 排队的走水编排按池重排归位。
        </p>
      </AppDialog>

      {/* 删除确认 */}
      <AppDialog
        open={deleteTarget() !== null}
        title="删除清池单？"
        width="max-w-lg"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleteTarget(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除「{deleteTarget() === null ? '' : pondLabel(deleteTarget() as CleaningOrder)}」的清池单记录，并按池重排走水编排。建议已执行过的单据用作废而不是删除，以便留档。
        </p>
      </AppDialog>
    </div>
  );
}
