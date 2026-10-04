/**
 * /shipping 发运单管理（储运班的外送账本）
 * 发运单与槽车运力另记一本：新建 / 编辑 / 作废 / 改派别池。
 * 作废或改派别池会把靠它排出的出卤退回待排（已装完的照旧）；调度室改不了发运单。
 * 按池对账：累计外送量 vs 装车量，差过容差就把两边数字摆出来等储运班复核。
 * 消费模型：ShippingOrder、Pond、Schedule；复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>、<AppDialog>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { usePondStore } from '../stores/pondStore';
import { useShippingStore } from '../stores/shippingStore';
import {
  SHIPPING_ORDER_STATUS_OPTIONS,
  tankCarTotalCapacity,
  type ShippingOrder,
  type ShippingOrderDraft,
  type ShippingOrderStatus,
} from '../types/shippingOrder';
import { orderRemainingM3 } from '../types/shippingOrder';
import { reconcileByPond, RECONCILE_TOLERANCE_PCT } from '../utils/brine';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const STATUS_STYLE: Record<ShippingOrderStatus, string> = {
  有效: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  作废: 'border-slate-300 bg-slate-100 text-slate-500',
};

function emptyDraft(pondId: string): ShippingOrderDraft {
  return {
    orderNo: '',
    pondId,
    volumeM3: 800,
    tankCarCount: 7,
    tankCarCapacityM3: 120,
    loadedVolumeM3: 0,
    tankFarm: '东罐区',
    shipDate: today(),
    status: '有效',
    note: '',
  };
}

export default function ShippingBoard() {
  const pondStore = usePondStore();
  const shippingStore = useShippingStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<ShippingOrder | null>(null);
  const [cascadeTarget, setCascadeTarget] = createSignal<{ order: ShippingOrder; draft: ShippingOrderDraft } | null>(null);
  const [draft, setDraft] = createStore<ShippingOrderDraft>(emptyDraft(''));

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const filtered = createMemo<ShippingOrder[]>(() => {
    const keyword = shippingStore.keyword().trim().toLowerCase();
    return shippingStore.state.rows.filter((row) => {
      if (shippingStore.statusFilter() !== 'all' && row.status !== shippingStore.statusFilter()) return false;
      if (keyword === '') return true;
      const pond = pondOf(row.pondId);
      return (
        row.orderNo.toLowerCase().includes(keyword) ||
        row.tankFarm.toLowerCase().includes(keyword) ||
        (pond?.code ?? '').toLowerCase().includes(keyword)
      );
    });
  });

  const stats = createMemo(() => {
    const list = shippingStore.state.rows;
    const active = list.filter((row) => row.status === '有效');
    return {
      total: list.length,
      active: active.length,
      voided: list.length - active.length,
      carCapacity: Math.round(active.reduce((acc, row) => acc + tankCarTotalCapacity(row), 0) * 10) / 10,
      loaded: Math.round(list.reduce((acc, row) => acc + row.loadedVolumeM3, 0) * 10) / 10,
    };
  });

  /** 按池对账：调度室累计外送量 vs 储运班装车量 */
  const reconcileRows = createMemo(() =>
    reconcileByPond(pondStore.state.ponds, pondStore.state.schedules, shippingStore.state.rows),
  );
  const mismatchCount = createMemo(() => reconcileRows().filter((row) => row.mismatch).length);

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId));
    setDialogOpen(true);
  };

  const openEdit = (row: ShippingOrder): void => {
    setEditingId(row.id);
    setDraft({
      orderNo: row.orderNo,
      pondId: row.pondId,
      volumeM3: row.volumeM3,
      tankCarCount: row.tankCarCount,
      tankCarCapacityM3: row.tankCarCapacityM3,
      loadedVolumeM3: row.loadedVolumeM3,
      tankFarm: row.tankFarm,
      shipDate: row.shipDate,
      status: row.status,
      note: row.note,
    });
    setDialogOpen(true);
  };

  /** 保存前预判：作废或改派别池会触发 cascade，先二次确认 */
  const requestSubmit = (): void => {
    if (draft.pondId === '') {
      shippingStore.setMessage('请选择装车池号');
      return;
    }
    if (editingId() !== null) {
      const previous = shippingStore.state.rows.find((row) => row.id === editingId());
      if (previous !== undefined && (draft.status === '作废' || draft.pondId !== previous.pondId)) {
        setCascadeTarget({ order: previous, draft: { ...draft } });
        return;
      }
    }
    void submit();
  };

  const submit = async (): Promise<void> => {
    // cascadeTarget 优先：列表里的「作废」按钮也走这里，必须按原单 id 更新
    const target = cascadeTarget();
    if (target !== null) {
      await shippingStore.updateShippingOrder(target.order.id, { ...target.draft });
    } else if (editingId() === null) {
      await shippingStore.createShippingOrder({ ...draft });
    } else {
      await shippingStore.updateShippingOrder(editingId() as string, { ...draft });
    }
    setDialogOpen(false);
    setCascadeTarget(null);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await shippingStore.deleteShippingOrder(row.id);
    setDeleting(null);
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="发运单" value={stats().total} suffix="单" tone="primary" />
        <StatBadge label="有效" value={stats().active} suffix="单" tone="success" />
        <StatBadge label="作废" value={stats().voided} suffix="单" tone="default" />
        <StatBadge label="槽车总运力" value={stats().carCapacity} suffix="m³" tone="info" />
        <StatBadge label="已装车量" value={stats().loaded} suffix="m³" tone="info" />
        <StatBadge
          label="对账不符"
          value={mismatchCount()}
          suffix="池"
          tone={mismatchCount() > 0 ? 'warning' : 'success'}
          hint={`累计外送量与装车量相差超过 ${RECONCILE_TOLERANCE_PCT * 100}% 即转储运班复核`}
        />
      </div>

      <Show when={shippingStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {shippingStore.state.lastMessage}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">按池对账（调度室外送 vs 储运班装车）</h2>
          <span class="text-xs text-slate-400">容差 {RECONCILE_TOLERANCE_PCT * 100}%，差过容差即摆出来等储运班复核</span>
        </header>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th class="px-3 py-2">池号</th>
                <th class="px-3 py-2 text-right">调度室累计外送（m³）</th>
                <th class="px-3 py-2 text-right">储运班装车量（m³）</th>
                <th class="px-3 py-2 text-right">差（m³）</th>
                <th class="px-3 py-2">状态</th>
              </tr>
            </thead>
            <tbody>
              <For each={reconcileRows()}>
                {(row) => {
                  const pond = (): ReturnType<typeof pondOf> => pondOf(row.pondId);
                  return (
                    <tr class="border-b border-slate-100 hover:bg-slate-50/60">
                      <td class="px-3 py-2.5 font-medium text-slate-800">
                        {pond() === null ? '—' : `${pond()?.code} · ${pond()?.seriesName}`}
                      </td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.dispatchM3}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.loadedM3}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.diffM3 > 0 ? `+${row.diffM3}` : row.diffM3}</td>
                      <td class="px-3 py-2.5">
                        {row.mismatch ? (
                          <span class="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
                            待储运班复核
                          </span>
                        ) : (
                          <span class="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
                            一致
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </div>
      </section>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">发运单与槽车运力</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
            + 新建发运单
          </button>
        </header>

        <FilterBar
          keyword={shippingStore.keyword()}
          onKeyword={(value) => shippingStore.patchFilters({ keyword: value })}
          fields={[{ key: 'status', label: '状态', options: [...SHIPPING_ORDER_STATUS_OPTIONS] }]}
          values={{ status: shippingStore.statusFilter() }}
          onChange={(key, value) => {
            if (key === 'status') shippingStore.patchFilters({ status: value as ShippingOrderStatus | 'all' });
          }}
          onReset={() => shippingStore.resetFilters()}
          resultText={`命中 ${filtered().length} / ${shippingStore.state.rows.length} 单`}
        />

        <Show when={shippingStore.state.rows.length === 0}>
          <EmptyPanel
            title="还没有发运单"
            description="储运班建立发运单与槽车运力后，调度室的走水计划才能接上外送归属；作废或改派别池会把靠它排出的出卤退回待排。"
            actionText="新建第一条发运单"
            onAction={openCreate}
          />
        </Show>

        <Show when={shippingStore.state.rows.length > 0}>
          <ul class="space-y-2">
            <For each={filtered()}>
              {(row) => (
                <li class="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-3">
                  <div class="min-w-[180px] flex-1">
                    <p class="text-sm font-medium text-slate-800">
                      {row.orderNo}
                      <span class="ml-2 text-xs font-normal text-slate-500">{pondLabel(row.pondId)}</span>
                    </p>
                    <p class="text-xs text-slate-500">
                      发运日期 {row.shipDate} · 去向 {row.tankFarm}
                      {row.note !== '' ? ` · ${row.note}` : ''}
                    </p>
                  </div>
                  <div class="text-xs text-slate-600">
                    <p>
                      发运量 <span class="tabular-nums font-medium text-slate-800">{row.volumeM3}</span> m³
                    </p>
                    <p>
                      已装车 <span class="tabular-nums font-medium text-slate-800">{row.loadedVolumeM3}</span> m³
                    </p>
                  </div>
                  <div class="text-xs text-slate-600">
                    <p>
                      槽车 <span class="tabular-nums font-medium text-slate-800">{row.tankCarCount}</span> 辆 ×{' '}
                      <span class="tabular-nums font-medium text-slate-800">{row.tankCarCapacityM3}</span> m³
                    </p>
                    <p>
                      总运力 <span class="tabular-nums font-medium text-brine-700">{tankCarTotalCapacity(row)}</span> m³ · 剩余{' '}
                      <span class="tabular-nums font-medium text-brine-700">{orderRemainingM3(row)}</span> m³
                    </p>
                  </div>
                  <span class={`rounded border px-2 py-0.5 text-[11px] ${STATUS_STYLE[row.status]}`}>{row.status}</span>
                  <div class="flex flex-wrap items-center gap-2">
                    <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                      编辑
                    </button>
                    <Show when={row.status === '有效'}>
                      <button
                        class="text-xs text-amber-700 hover:underline"
                        onClick={() =>
                          setCascadeTarget({
                            order: row,
                            draft: {
                              orderNo: row.orderNo,
                              pondId: row.pondId,
                              volumeM3: row.volumeM3,
                              tankCarCount: row.tankCarCount,
                              tankCarCapacityM3: row.tankCarCapacityM3,
                              loadedVolumeM3: row.loadedVolumeM3,
                              tankFarm: row.tankFarm,
                              shipDate: row.shipDate,
                              status: '作废',
                              note: row.note,
                            },
                          })
                        }
                      >
                        作废
                      </button>
                    </Show>
                    <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                      删除
                    </button>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show when={shippingStore.state.rows.length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的发运单"
            description="可以切换池系或状态筛选条件，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => shippingStore.resetFilters()}
          />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '新建发运单' : '编辑发运单'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => requestSubmit()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>发运单号</span>
            <input class={INPUT} value={draft.orderNo} onInput={(event) => setDraft('orderNo', event.currentTarget.value)} placeholder="留空自动生成" />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>装车池号</span>
            <select class={INPUT} value={draft.pondId} onChange={(event) => setDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>发运量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={draft.volumeM3}
              onInput={(event) => setDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>已装车量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={draft.loadedVolumeM3}
              onInput={(event) => setDraft('loadedVolumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>槽车数量（辆）</span>
            <input
              type="number"
              min="0"
              step="1"
              class={INPUT}
              value={draft.tankCarCount}
              onInput={(event) => setDraft('tankCarCount', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>单车运力（m³/车）</span>
            <input
              type="number"
              step="1"
              class={INPUT}
              value={draft.tankCarCapacityM3}
              onInput={(event) => setDraft('tankCarCapacityM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>去向罐区</span>
            <input class={INPUT} value={draft.tankFarm} onInput={(event) => setDraft('tankFarm', event.currentTarget.value)} placeholder="如：东罐区" />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>发运日期</span>
            <input type="date" class={INPUT} value={draft.shipDate} onInput={(event) => setDraft('shipDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>状态</span>
            <select class={INPUT} value={draft.status} onChange={(event) => setDraft('status', event.currentTarget.value as ShippingOrderStatus)}>
              <For each={SHIPPING_ORDER_STATUS_OPTIONS}>{(status) => <option value={status}>{status}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注</span>
            <input class={INPUT} value={draft.note} onInput={(event) => setDraft('note', event.currentTarget.value)} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          槽车总运力 = {draft.tankCarCount} 辆 × {draft.tankCarCapacityM3} m³ ={' '}
          <span class="tabular-nums font-medium text-slate-700">
            {Math.round(draft.tankCarCount * draft.tankCarCapacityM3 * 10) / 10} m³
          </span>
          ；剩余可装 = 发运量 − 已装车 ={' '}
          <span class="tabular-nums font-medium text-slate-700">
            {Math.max(0, Math.round((draft.volumeM3 - draft.loadedVolumeM3) * 10) / 10)} m³
          </span>
          。调度室改不了发运单：作废或改派别池会把靠它排出的出卤退回待排，已装完的照旧。
        </p>
      </AppDialog>

      <AppDialog
        open={cascadeTarget() !== null}
        title={cascadeTarget()?.draft.status === '作废' ? '确认作废发运单？' : '确认改派别池？'}
        width="max-w-lg"
        onClose={() => setCascadeTarget(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setCascadeTarget(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void submit()}>
              {cascadeTarget()?.draft.status === '作废' ? '确认作废' : '确认改派'}
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          {cascadeTarget()?.draft.status === '作废'
            ? `作废后，靠「${cascadeTarget()?.order.orderNo}」排出的出卤会退回「待排」等调度员重排，已出卤（已装完）的照旧。`
            : `改派别池后，靠「${cascadeTarget()?.order.orderNo}」排出的出卤会退回「待排」等调度员重排，已出卤（已装完）的照旧。`}
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除发运单？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除发运单「{deleting()?.orderNo}」（{pondLabel(deleting()?.pondId ?? '')}）。删除后不可恢复。
        </p>
      </AppDialog>
    </div>
  );
}
