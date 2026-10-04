/**
 * /shipments 储运发运台账（储运班）
 * 发运单开单 / 装车登记 / 作废 / 改派别池，槽车运力与罐区容量维护，按池对账复核。
 * 作废与改派会联动把靠它排出的出卤退回待排；调度室只读本页数据，改不了发运单。
 * 消费模型：ShipmentOrder、TankTruck、TankFarm、ReconReview、Schedule、Pond
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import { usePondStore } from '../stores/pondStore';
import { useShipmentStore } from '../stores/shipmentStore';
import { SHIPMENT_STATUS_OPTIONS, type ShipmentDraft, type ShipmentOrder, type ShipmentStatus } from '../types/shipment';
import { TRUCK_STATUS_OPTIONS, type TankTruck, type TruckDraft, type TruckStatus } from '../types/truck';
import { RECON_TOLERANCE_M3 } from '../types/recon';
import {
  availableTruckCapacityM3,
  orderRemainingM3,
  reconcileByPond,
  tankFarmOccupiedM3,
  truckDailyCapacityM3,
} from '../utils/dispatch';
import { round1 } from '../utils/brine';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';
const BTN_SMALL =
  'rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100 disabled:opacity-50';

const ORDER_STATUS_STYLE: Record<ShipmentStatus, string> = {
  待发运: 'border-slate-300 bg-slate-100 text-slate-600',
  装运中: 'border-amber-300 bg-amber-50 text-amber-700',
  已装完: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  已作废: 'border-rose-300 bg-rose-50 text-rose-500',
};

const TRUCK_STATUS_STYLE: Record<TruckStatus, string> = {
  可用: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  维修中: 'border-amber-300 bg-amber-50 text-amber-700',
};

function emptyOrderDraft(pondId: string): ShipmentDraft {
  return { code: '', pondId, plannedVolumeM3: 800, carrier: '', note: '' };
}

function emptyTruckDraft(): TruckDraft {
  return { plateNo: '', capacityM3: 60, tripsPerDay: 6, status: '可用' };
}

export default function ShipmentBoard() {
  const pondStore = usePondStore();
  const shipmentStore = useShipmentStore();

  const [orderDialogOpen, setOrderDialogOpen] = createSignal(false);
  const [editingOrderId, setEditingOrderId] = createSignal<string | null>(null);
  const [orderDraft, setOrderDraft] = createStore<ShipmentDraft>(emptyOrderDraft(''));
  const [loading, setLoading] = createSignal<ShipmentOrder | null>(null);
  const [loadVolume, setLoadVolume] = createSignal(0);
  const [reassigning, setReassigning] = createSignal<ShipmentOrder | null>(null);
  const [reassignPondId, setReassignPondId] = createSignal('');
  const [voiding, setVoiding] = createSignal<ShipmentOrder | null>(null);
  const [truckDialogOpen, setTruckDialogOpen] = createSignal(false);
  const [editingTruckId, setEditingTruckId] = createSignal<string | null>(null);
  const [truckDraft, setTruckDraft] = createStore<TruckDraft>(emptyTruckDraft());
  const [deletingTruck, setDeletingTruck] = createSignal<TankTruck | null>(null);
  const [farmDialogOpen, setFarmDialogOpen] = createSignal(false);
  const [farmCapacity, setFarmCapacity] = createSignal(0);
  const [reviewing, setReviewing] = createSignal<string | null>(null);
  const [reviewer, setReviewer] = createSignal('');
  const [keyword, setKeyword] = createSignal('');
  const [statusFilter, setStatusFilter] = createSignal<ShipmentStatus | 'all'>('all');

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  /* ------------------------------ 派生统计 ------------------------------ */

  const occupiedM3 = createMemo(() => tankFarmOccupiedM3(pondStore.state.schedules, shipmentStore.state.orders));

  const reconRows = createMemo(() =>
    reconcileByPond(pondStore.state.ponds, pondStore.state.schedules, shipmentStore.state.orders, shipmentStore.state.reviews),
  );

  const stats = createMemo(() => {
    const active = shipmentStore.state.orders.filter((row) => row.status !== '已作废');
    const farm = shipmentStore.state.tankFarm;
    const total = farm?.totalCapacityM3 ?? 0;
    return {
      orders: shipmentStore.state.orders.length,
      activeOrders: active.length,
      remainingM3: round1(active.reduce((acc, row) => acc + orderRemainingM3(row), 0)),
      truckCapacityM3: availableTruckCapacityM3(shipmentStore.state.trucks),
      farmTotalM3: total,
      farmRemainingM3: round1(Math.max(0, total - occupiedM3())),
      pendingRecon: reconRows().filter((row) => row.overTolerance && !row.reviewed).length,
    };
  });

  const filteredOrders = createMemo<ShipmentOrder[]>(() => {
    const series = pondStore.state.currentSeries;
    const key = keyword().trim().toLowerCase();
    return shipmentStore.state.orders.filter((row) => {
      const pond = pondOf(row.pondId);
      if (series !== null && pond?.seriesName !== series) return false;
      if (statusFilter() !== 'all' && row.status !== statusFilter()) return false;
      if (key === '') return true;
      return row.code.toLowerCase().includes(key) || row.carrier.toLowerCase().includes(key) || pondLabel(row.pondId).toLowerCase().includes(key);
    });
  });

  /** 作废确认时提示：还有几条未出卤的出卤计划靠这张单排的 */
  const linkedPendingCount = (orderId: string): number =>
    pondStore.state.schedules.filter((row) => row.shipmentOrderId === orderId && row.state !== '已出卤').length;

  /* ------------------------------ 发运单动作 ------------------------------ */

  const openCreateOrder = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingOrderId(null);
    setOrderDraft(emptyOrderDraft(pondId));
    setOrderDialogOpen(true);
  };

  const openEditOrder = (row: ShipmentOrder): void => {
    setEditingOrderId(row.id);
    setOrderDraft({ code: row.code, pondId: row.pondId, plannedVolumeM3: row.plannedVolumeM3, carrier: row.carrier, note: row.note });
    setOrderDialogOpen(true);
  };

  const submitOrder = async (): Promise<void> => {
    if (editingOrderId() === null && orderDraft.pondId === '') {
      shipmentStore.setMessage('请选择归属蒸发池');
      return;
    }
    if (editingOrderId() === null) {
      await shipmentStore.createOrder({ ...orderDraft });
    } else {
      await shipmentStore.updateOrder(editingOrderId() as string, { ...orderDraft });
    }
    setOrderDialogOpen(false);
  };

  const openLoad = (row: ShipmentOrder): void => {
    setLoading(row);
    setLoadVolume(orderRemainingM3(row));
  };

  const submitLoad = async (): Promise<void> => {
    const row = loading();
    if (row === null) return;
    if (!(loadVolume() > 0)) {
      shipmentStore.setMessage('装车量必须大于 0');
      return;
    }
    await shipmentStore.loadOrder(row.id, round1(loadVolume()));
    setLoading(null);
  };

  const openReassign = (row: ShipmentOrder): void => {
    setReassigning(row);
    const fallback = pondStore.state.ponds.find((pond) => pond.id !== row.pondId)?.id ?? '';
    setReassignPondId(fallback);
  };

  const submitReassign = async (): Promise<void> => {
    const row = reassigning();
    if (row === null || reassignPondId() === '') return;
    await shipmentStore.reassignOrder(row.id, reassignPondId());
    setReassigning(null);
  };

  const confirmVoid = async (): Promise<void> => {
    const row = voiding();
    if (row === null) return;
    await shipmentStore.voidOrder(row.id);
    setVoiding(null);
  };

  /* ------------------------------ 槽车 / 罐区 / 对账动作 ------------------------------ */

  const openCreateTruck = (): void => {
    setEditingTruckId(null);
    setTruckDraft(emptyTruckDraft());
    setTruckDialogOpen(true);
  };

  const openEditTruck = (row: TankTruck): void => {
    setEditingTruckId(row.id);
    setTruckDraft({ plateNo: row.plateNo, capacityM3: row.capacityM3, tripsPerDay: row.tripsPerDay, status: row.status });
    setTruckDialogOpen(true);
  };

  const submitTruck = async (): Promise<void> => {
    if (editingTruckId() === null) {
      await shipmentStore.createTruck({ ...truckDraft });
    } else {
      await shipmentStore.updateTruck(editingTruckId() as string, { ...truckDraft });
    }
    setTruckDialogOpen(false);
  };

  const openFarmDialog = (): void => {
    setFarmCapacity(shipmentStore.state.tankFarm?.totalCapacityM3 ?? 0);
    setFarmDialogOpen(true);
  };

  const submitFarm = async (): Promise<void> => {
    await shipmentStore.saveFarm(Math.max(0, round1(farmCapacity())));
    setFarmDialogOpen(false);
  };

  const openReview = (pondId: string): void => {
    setReviewing(pondId);
    setReviewer('');
  };

  const submitReview = async (): Promise<void> => {
    const pondId = reviewing();
    if (pondId === null) return;
    await shipmentStore.reviewRecon(pondId, reviewer());
    setReviewing(null);
  };

  const farmUsedPct = createMemo(() => {
    const total = stats().farmTotalM3;
    if (total <= 0) return 0;
    return Math.min(100, Math.round((occupiedM3() / total) * 1000) / 10);
  });

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="发运单" value={stats().orders} suffix="张" tone="primary" />
        <StatBadge label="有效单剩余可装" value={stats().remainingM3} suffix="m³" tone="info" />
        <StatBadge label="槽车可用运力" value={stats().truckCapacityM3} suffix="m³/日" tone="default" />
        <StatBadge
          label="罐区剩余容量"
          value={stats().farmRemainingM3}
          suffix={`/ ${stats().farmTotalM3} m³`}
          percent={stats().farmTotalM3 <= 0 ? 0 : (stats().farmRemainingM3 / stats().farmTotalM3) * 100}
          tone={stats().farmRemainingM3 <= 0 ? 'danger' : 'success'}
          hint="占用 = 累计已出卤 − 累计已装车；剩余不足时出卤按池排队"
        />
        <StatBadge
          label="对账待复核"
          value={stats().pendingRecon}
          suffix="口池"
          tone={stats().pendingRecon > 0 ? 'danger' : 'success'}
          hint={`两边差值超过 ${RECON_TOLERANCE_M3} m³ 即判超差，等储运班复核`}
        />
      </div>

      <Show when={shipmentStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {shipmentStore.state.lastMessage}
        </div>
      </Show>

      {/* 罐区容量 */}
      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">{shipmentStore.state.tankFarm?.name ?? '罐区'}容量</h2>
          <button type="button" class={BTN_GHOST} onClick={openFarmDialog}>
            调整总容量
          </button>
        </header>
        <div class="flex flex-wrap items-center gap-6 text-sm">
          <p class="text-slate-600">
            总容量 <span class="tabular-nums font-semibold text-slate-800">{stats().farmTotalM3}</span> m³
          </p>
          <p class="text-slate-600">
            已占用 <span class="tabular-nums font-semibold text-amber-700">{occupiedM3()}</span> m³（已出卤未装车）
          </p>
          <p class="text-slate-600">
            剩余 <span class="tabular-nums font-semibold text-brine-700">{stats().farmRemainingM3}</span> m³
          </p>
          <div class="flex min-w-[220px] flex-1 items-center gap-2">
            <div class="h-2 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                class={`h-full rounded-full ${farmUsedPct() >= 90 ? 'bg-rose-500' : 'bg-brine-600'}`}
                style={{ width: `${farmUsedPct()}%` }}
              />
            </div>
            <span class="w-14 text-right text-xs tabular-nums text-slate-500">{farmUsedPct()}%</span>
          </div>
        </div>
        <Show when={stats().farmTotalM3 <= 0}>
          <p class="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700">
            罐区总容量尚未录入，出卤核单会一律按池排队；请储运班先点「调整总容量」录入罐容。
          </p>
        </Show>
      </section>

      {/* 发运单台账 */}
      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">发运单台账</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreateOrder} disabled={pondStore.state.ponds.length === 0}>
            + 新建发运单
          </button>
        </header>

        <FilterBar
          keyword={keyword()}
          onKeyword={(value) => setKeyword(value)}
          fields={[
            { key: 'series', label: '池系', options: pondStore.seriesOptions() },
            { key: 'status', label: '状态', options: [...SHIPMENT_STATUS_OPTIONS] },
          ]}
          values={{ series: pondStore.state.currentSeries ?? 'all', status: statusFilter() }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
            if (key === 'status') setStatusFilter(value as ShipmentStatus | 'all');
          }}
          onReset={() => {
            setKeyword('');
            setStatusFilter('all');
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filteredOrders().length} / ${shipmentStore.state.orders.length} 张`}
        />

        <Show
          when={shipmentStore.state.orders.length > 0}
          fallback={
            <EmptyPanel
              title="还没有发运单"
              description="储运班在此开出第一张发运单，调度室推进出卤前会按发运单与槽车运力核单。"
              actionText="新建第一张发运单"
              onAction={openCreateOrder}
            />
          }
        >
          <div class="overflow-x-auto">
            <table class="w-full min-w-[1080px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">单号</th>
                  <th class="px-3 py-2">归属池</th>
                  <th class="px-3 py-2 text-right">计划量（m³）</th>
                  <th class="px-3 py-2 text-right">已装车（m³）</th>
                  <th class="px-3 py-2 text-right">剩余（m³）</th>
                  <th class="px-3 py-2">状态</th>
                  <th class="px-3 py-2">承运方 / 备注</th>
                  <th class="px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={filteredOrders()}>
                  {(row) => (
                    <tr class="border-b border-slate-100 hover:bg-slate-50/60">
                      <td class="px-3 py-2.5 font-medium text-slate-800">{row.code}</td>
                      <td class="px-3 py-2.5 text-xs text-slate-600">{pondLabel(row.pondId)}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.plannedVolumeM3}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.loadedVolumeM3}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums font-medium text-brine-700">{orderRemainingM3(row)}</td>
                      <td class="px-3 py-2.5">
                        <span class={`rounded border px-2 py-0.5 text-[11px] ${ORDER_STATUS_STYLE[row.status]}`}>{row.status}</span>
                      </td>
                      <td class="px-3 py-2.5 text-xs text-slate-600">
                        <p>{row.carrier === '' ? '—' : row.carrier}</p>
                        <Show when={row.note !== ''}>
                          <p class="text-slate-400">{row.note}</p>
                        </Show>
                      </td>
                      <td class="px-3 py-2.5">
                        <div class="flex flex-wrap items-center justify-end gap-2">
                          <button
                            class={BTN_SMALL}
                            disabled={row.status === '已作废' || row.status === '已装完'}
                            onClick={() => openLoad(row)}
                          >
                            装车登记
                          </button>
                          <button class="text-xs text-brine-700 hover:underline" onClick={() => openEditOrder(row)}>
                            编辑
                          </button>
                          <button
                            class="text-xs text-amber-700 hover:underline disabled:opacity-40"
                            disabled={row.status === '已作废' || row.status === '已装完'}
                            onClick={() => openReassign(row)}
                          >
                            改派
                          </button>
                          <button
                            class="text-xs text-rose-600 hover:underline disabled:opacity-40"
                            disabled={row.status === '已作废' || row.status === '已装完'}
                            onClick={() => setVoiding(row)}
                          >
                            作废
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <Show when={filteredOrders().length === 0}>
            <p class="py-4 text-center text-xs text-slate-400">没有符合筛选条件的发运单，可切换池系或状态筛选。</p>
          </Show>
        </Show>
      </section>

      {/* 槽车运力 */}
      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-[15px] font-semibold text-slate-800">槽车运力</h2>
          <button type="button" class={BTN_PRIMARY} onClick={openCreateTruck}>
            + 登记槽车
          </button>
        </header>
        <Show
          when={shipmentStore.state.trucks.length > 0}
          fallback={<EmptyPanel title="还没有槽车" description="登记槽车车牌、单车运力与每日趟数，出卤核单按可用日运力核。" actionText="登记第一辆槽车" onAction={openCreateTruck} />}
        >
          <div class="overflow-x-auto">
            <table class="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                  <th class="px-3 py-2">车牌号</th>
                  <th class="px-3 py-2 text-right">单车运力（m³/趟）</th>
                  <th class="px-3 py-2 text-right">每日趟数</th>
                  <th class="px-3 py-2 text-right">日运力（m³/日）</th>
                  <th class="px-3 py-2">状态</th>
                  <th class="px-3 py-2 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                <For each={shipmentStore.state.trucks}>
                  {(row) => (
                    <tr class="border-b border-slate-100 hover:bg-slate-50/60">
                      <td class="px-3 py-2.5 font-medium text-slate-800">{row.plateNo}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.capacityM3}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums">{row.tripsPerDay}</td>
                      <td class="px-3 py-2.5 text-right tabular-nums font-medium text-brine-700">{truckDailyCapacityM3(row)}</td>
                      <td class="px-3 py-2.5">
                        <span class={`rounded border px-2 py-0.5 text-[11px] ${TRUCK_STATUS_STYLE[row.status]}`}>{row.status}</span>
                      </td>
                      <td class="px-3 py-2.5">
                        <div class="flex items-center justify-end gap-2">
                          <button class="text-xs text-brine-700 hover:underline" onClick={() => openEditTruck(row)}>
                            编辑
                          </button>
                          <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeletingTruck(row)}>
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>

      {/* 按池对账 */}
      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3">
          <h2 class="text-[15px] font-semibold text-slate-800">按池对账（调度外送 vs 储运装车）</h2>
          <p class="mt-1 text-xs text-slate-500">
            同一口池的累计外送量与累计装车量按池号对账，差值超过 {RECON_TOLERANCE_M3} m³ 即摆出两边数字等储运班复核；复核后数字再变会重新待复核。
          </p>
        </header>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[920px] border-collapse text-sm">
            <thead>
              <tr class="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
                <th class="px-3 py-2">池号</th>
                <th class="px-3 py-2 text-right">调度累计外送（m³）</th>
                <th class="px-3 py-2 text-right">储运累计装车（m³）</th>
                <th class="px-3 py-2 text-right">差值（m³）</th>
                <th class="px-3 py-2">对账状态</th>
                <th class="px-3 py-2">最近复核</th>
                <th class="px-3 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <For each={reconRows()}>
                {(row) => (
                  <tr class={`border-b border-slate-100 ${row.overTolerance && !row.reviewed ? 'bg-rose-50/50' : 'hover:bg-slate-50/60'}`}>
                    <td class="px-3 py-2.5">
                      <span class="font-medium text-slate-800">{row.pondCode}</span>
                      <span class="ml-1.5 text-xs text-slate-400">{row.seriesName}</span>
                    </td>
                    <td class="px-3 py-2.5 text-right tabular-nums">{row.scheduleTotalM3}</td>
                    <td class="px-3 py-2.5 text-right tabular-nums">{row.shipmentTotalM3}</td>
                    <td
                      class={`px-3 py-2.5 text-right tabular-nums font-medium ${
                        row.overTolerance ? 'text-rose-600' : 'text-slate-600'
                      }`}
                    >
                      {row.diffM3 > 0 ? `+${row.diffM3}` : row.diffM3}
                    </td>
                    <td class="px-3 py-2.5">
                      <Show
                        when={row.overTolerance}
                        fallback={<span class="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">平</span>}
                      >
                        <Show
                          when={row.reviewed}
                          fallback={<span class="rounded border border-rose-300 bg-rose-50 px-2 py-0.5 text-[11px] text-rose-600">超差 · 待复核</span>}
                        >
                          <span class="rounded border border-sky-300 bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">超差 · 已复核</span>
                        </Show>
                      </Show>
                    </td>
                    <td class="px-3 py-2.5 text-xs text-slate-500">
                      <Show when={row.lastReview !== null} fallback="—">
                        {row.lastReview?.reviewer} · {row.lastReview?.reviewedAt.slice(0, 10)}
                      </Show>
                    </td>
                    <td class="px-3 py-2.5 text-right">
                      <Show when={row.overTolerance && !row.reviewed}>
                        <button class={BTN_SMALL} onClick={() => openReview(row.pondId)}>
                          复核确认
                        </button>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </section>

      {/* 新建 / 编辑发运单 */}
      <AppDialog
        open={orderDialogOpen()}
        title={editingOrderId() === null ? '新建发运单' : '编辑发运单'}
        onClose={() => setOrderDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setOrderDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitOrder()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>发运单号</span>
            <input class={INPUT} value={orderDraft.code} placeholder="留空自动生成" onInput={(event) => setOrderDraft('code', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>归属蒸发池{editingOrderId() !== null ? '（改归属请用「改派」）' : ''}</span>
            <select
              class={INPUT}
              value={orderDraft.pondId}
              disabled={editingOrderId() !== null}
              onChange={(event) => setOrderDraft('pondId', event.currentTarget.value)}
            >
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
            <span>计划发运量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={orderDraft.plannedVolumeM3}
              onInput={(event) => setOrderDraft('plannedVolumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>承运方</span>
            <input class={INPUT} value={orderDraft.carrier} onInput={(event) => setOrderDraft('carrier', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600 sm:col-span-2">
            <span>备注</span>
            <input class={INPUT} value={orderDraft.note} onInput={(event) => setOrderDraft('note', event.currentTarget.value)} />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          发运单只由储运班维护：装车量走「装车登记」累加，作废与改派会把靠它排出的出卤退回待排，已装完的单照旧不动。
        </p>
      </AppDialog>

      {/* 装车登记 */}
      <AppDialog
        open={loading() !== null}
        title={`装车登记 · ${loading()?.code ?? ''}`}
        width="max-w-lg"
        onClose={() => setLoading(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setLoading(null)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitLoad()}>
              登记装车
            </button>
          </>
        }
      >
        <p class="text-sm text-slate-600">
          计划 {loading()?.plannedVolumeM3} m³，已装 {loading()?.loadedVolumeM3} m³，剩余{' '}
          {loading() === null ? 0 : orderRemainingM3(loading() as ShipmentOrder)} m³。装车后罐区占用同步核减。
        </p>
        <label class="mt-3 flex flex-col gap-1 text-[13px] text-slate-600">
          <span>本次装车量（m³）</span>
          <input type="number" step="10" min="0" class={INPUT} value={loadVolume()} onInput={(event) => setLoadVolume(Number(event.currentTarget.value))} />
        </label>
      </AppDialog>

      {/* 改派别池 */}
      <AppDialog
        open={reassigning() !== null}
        title={`改派别池 · ${reassigning()?.code ?? ''}`}
        width="max-w-lg"
        onClose={() => setReassigning(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setReassigning(null)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitReassign()} disabled={reassignPondId() === ''}>
              确认改派
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          当前归属「{pondLabel(reassigning()?.pondId ?? '')}」。改派后，原池靠这张单排出的出卤（未出卤的{' '}
          {linkedPendingCount(reassigning()?.id ?? '')} 条）会退回待排、等调度员重排；已出卤的照旧。
        </p>
        <label class="mt-3 flex flex-col gap-1 text-[13px] text-slate-600">
          <span>改派到蒸发池</span>
          <select class={INPUT} value={reassignPondId()} onChange={(event) => setReassignPondId(event.currentTarget.value)}>
            <For each={pondStore.state.ponds.filter((pond) => pond.id !== reassigning()?.pondId)}>
              {(pond) => (
                <option value={pond.id}>
                  {pond.code} · {pond.seriesName} · {pond.stage}
                </option>
              )}
            </For>
          </select>
        </label>
      </AppDialog>

      {/* 作废确认 */}
      <AppDialog
        open={voiding() !== null}
        title="确认作废发运单？"
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
          将作废「{voiding()?.code}」（{pondLabel(voiding()?.pondId ?? '')}）。靠它排出的出卤（未出卤的{' '}
          {linkedPendingCount(voiding()?.id ?? '')} 条）会退回待排、等调度员重排；已出卤与已装车的照旧。
        </p>
      </AppDialog>

      {/* 新建 / 编辑槽车 */}
      <AppDialog
        open={truckDialogOpen()}
        title={editingTruckId() === null ? '登记槽车' : '编辑槽车'}
        width="max-w-lg"
        onClose={() => setTruckDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setTruckDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitTruck()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>车牌号</span>
            <input class={INPUT} value={truckDraft.plateNo} onInput={(event) => setTruckDraft('plateNo', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>状态</span>
            <select class={INPUT} value={truckDraft.status} onChange={(event) => setTruckDraft('status', event.currentTarget.value as TruckStatus)}>
              <For each={TRUCK_STATUS_OPTIONS}>{(status) => <option value={status}>{status}</option>}</For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>单车运力（m³/趟）</span>
            <input type="number" step="1" class={INPUT} value={truckDraft.capacityM3} onInput={(event) => setTruckDraft('capacityM3', Number(event.currentTarget.value))} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>每日趟数</span>
            <input type="number" step="1" min="0" class={INPUT} value={truckDraft.tripsPerDay} onInput={(event) => setTruckDraft('tripsPerDay', Number(event.currentTarget.value))} />
          </label>
        </div>
      </AppDialog>

      {/* 删除槽车确认 */}
      <AppDialog
        open={deletingTruck() !== null}
        title="确认删除槽车？"
        width="max-w-lg"
        onClose={() => setDeletingTruck(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeletingTruck(null)}>
              取消
            </button>
            <button
              class={BTN_DANGER}
              onClick={() => {
                const row = deletingTruck();
                if (row !== null) void shipmentStore.deleteTruck(row.id);
                setDeletingTruck(null);
              }}
            >
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除槽车「{deletingTruck()?.plateNo}」，可用日运力同步核减，出卤核单按剩余运力重新核。
        </p>
      </AppDialog>

      {/* 调整罐区容量 */}
      <AppDialog
        open={farmDialogOpen()}
        title="调整罐区总容量"
        width="max-w-lg"
        onClose={() => setFarmDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setFarmDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitFarm()}>
              保存
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          当前已占用 {occupiedM3()} m³（已出卤未装车，由出卤与装车自动派生，不手工改）。调大总容量后，排队中的出卤可重试核单。
        </p>
        <label class="mt-3 flex flex-col gap-1 text-[13px] text-slate-600">
          <span>总容量（m³）</span>
          <input type="number" step="50" min="0" class={INPUT} value={farmCapacity()} onInput={(event) => setFarmCapacity(Number(event.currentTarget.value))} />
        </label>
      </AppDialog>

      {/* 对账复核 */}
      <AppDialog
        open={reviewing() !== null}
        title={`对账复核 · ${pondLabel(reviewing() ?? '')}`}
        width="max-w-lg"
        onClose={() => setReviewing(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setReviewing(null)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submitReview()}>
              确认复核
            </button>
          </>
        }
      >
        <Show when={reviewing() !== null}>
          {(() => {
            const row = reconRows().find((item) => item.pondId === reviewing());
            if (row === undefined) return null;
            return (
              <div class="space-y-3">
                <div class="grid grid-cols-3 gap-2 text-center">
                  <div class="rounded-lg bg-slate-50 px-2 py-2.5">
                    <p class="text-xs text-slate-500">调度累计外送</p>
                    <p class="mt-0.5 text-lg font-bold tabular-nums text-slate-800">{row.scheduleTotalM3}</p>
                    <p class="text-[11px] text-slate-400">m³</p>
                  </div>
                  <div class="rounded-lg bg-slate-50 px-2 py-2.5">
                    <p class="text-xs text-slate-500">储运累计装车</p>
                    <p class="mt-0.5 text-lg font-bold tabular-nums text-slate-800">{row.shipmentTotalM3}</p>
                    <p class="text-[11px] text-slate-400">m³</p>
                  </div>
                  <div class="rounded-lg bg-rose-50 px-2 py-2.5">
                    <p class="text-xs text-rose-500">差值</p>
                    <p class="mt-0.5 text-lg font-bold tabular-nums text-rose-600">
                      {row.diffM3 > 0 ? `+${row.diffM3}` : row.diffM3}
                    </p>
                    <p class="text-[11px] text-rose-400">m³（容差 {RECON_TOLERANCE_M3}）</p>
                  </div>
                </div>
                <p class="text-xs leading-relaxed text-slate-500">
                  两边数字已摆出，复核只确认当前账面；之后任一数字再变（新出卤或新装车），该池自动回到待复核。
                </p>
                <label class="flex flex-col gap-1 text-[13px] text-slate-600">
                  <span>复核人</span>
                  <input class={INPUT} value={reviewer()} placeholder="储运班" onInput={(event) => setReviewer(event.currentTarget.value)} />
                </label>
              </div>
            );
          })()}
        </Show>
      </AppDialog>
    </div>
  );
}
