/**
 * 储运外送状态管理（Solid 原生能力）
 * 发运单 / 槽车 / 罐区 / 按池对账复核：储运班台账，调度室只读不改发运单。
 * 作废与改派会联动把靠它排出的出卤退回待排；装车登记自动腾罐容、推进发运单状态。
 */
import { createRoot } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { ShipmentDraft, ShipmentOrder } from '../types/shipment';
import type { TankFarm, TankTruck, TruckDraft } from '../types/truck';
import type { ReconReview } from '../types/recon';
import {
  ROW_REVISION,
  db,
  initDatabase,
  loadShipment,
  putShipmentOrder,
  putTankTruck,
  reassignShipmentOrder,
  removeTankTruck,
  reviewReconciliation,
  saveTankFarmCapacity,
  voidShipmentOrder,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';

interface ShipmentState {
  orders: ShipmentOrder[];
  trucks: TankTruck[];
  tankFarm: TankFarm | null;
  reviews: ReconReview[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createShipmentStore() {
  const [state, setState] = createStore<ShipmentState>({
    orders: [],
    trucks: [],
    tankFarm: null,
    reviews: [],
    loading: true,
    error: '',
    lastMessage: '',
  });

  // 同 observationStore：建库必须放在 querier 外，否则 liveQuery 采集不到可观测性集合。
  void initDatabase();

  liveQuery(async () => {
    const [orders, trucks, farms, reviews] = await Promise.all([
      db.shipmentOrders.toArray(),
      db.tankTrucks.toArray(),
      db.tankfarm.toArray(),
      db.reconReviews.toArray(),
    ]);
    return { orders, trucks, farm: farms[0] ?? null, reviews };
  }).subscribe({
    next: ({ orders, trucks, farm, reviews }) => {
      setState({
        orders: [...orders].sort((a, b) => a.code.localeCompare(b.code)),
        trucks: [...trucks].sort((a, b) => a.plateNo.localeCompare(b.plateNo)),
        tankFarm: farm,
        reviews: [...reviews].sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt)),
        loading: false,
        error: '',
      });
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取储运台账失败' });
    },
  });

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  /* ------------------------------ 发运单 ------------------------------ */

  async function createOrder(draft: ShipmentDraft): Promise<void> {
    const stamp = nowIso();
    const code = draft.code.trim() === '' ? `FY-${Date.now().toString(36).toUpperCase()}` : draft.code.trim();
    await putShipmentOrder({
      id: uuid('shipment'),
      code,
      pondId: draft.pondId,
      plannedVolumeM3: draft.plannedVolumeM3,
      loadedVolumeM3: 0,
      status: '待发运',
      carrier: draft.carrier.trim(),
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    setState('lastMessage', `已开出发运单 ${code}`);
  }

  /** 编辑发运单：只允许改单号 / 计划量 / 承运方 / 备注；改归属池必须走改派（带退回联动） */
  async function updateOrder(orderId: string, draft: ShipmentDraft): Promise<void> {
    const existing = state.orders.find((row) => row.id === orderId);
    if (existing === undefined) return;
    await putShipmentOrder({
      ...existing,
      code: draft.code.trim() === '' ? existing.code : draft.code.trim(),
      plannedVolumeM3: draft.plannedVolumeM3,
      carrier: draft.carrier.trim(),
      note: draft.note.trim(),
    });
    setState('lastMessage', `发运单 ${existing.code} 已更新`);
  }

  async function voidOrder(orderId: string): Promise<void> {
    try {
      const { reverted } = await voidShipmentOrder(orderId);
      setState(
        'lastMessage',
        reverted > 0 ? `发运单已作废，${reverted} 条出卤计划已退回待排，等调度员重排` : '发运单已作废',
      );
    } catch (err) {
      setState('lastMessage', err instanceof Error ? err.message : '作废失败');
    }
  }

  async function reassignOrder(orderId: string, pondId: string): Promise<void> {
    try {
      const { reverted } = await reassignShipmentOrder(orderId, pondId);
      setState(
        'lastMessage',
        reverted > 0 ? `发运单已改派别池，${reverted} 条出卤计划已退回待排，等调度员重排` : '发运单已改派别池',
      );
    } catch (err) {
      setState('lastMessage', err instanceof Error ? err.message : '改派失败');
    }
  }

  async function loadOrder(orderId: string, volumeM3: number): Promise<void> {
    try {
      const next = await loadShipment(orderId, volumeM3);
      setState(
        'lastMessage',
        `已登记装车 ${volumeM3} m³：${next.code} 累计装车 ${next.loadedVolumeM3} m³（${next.status}），罐区占用同步核减`,
      );
    } catch (err) {
      setState('lastMessage', err instanceof Error ? err.message : '装车登记失败');
    }
  }

  /* ------------------------------ 槽车 ------------------------------ */

  async function createTruck(draft: TruckDraft): Promise<void> {
    const stamp = nowIso();
    await putTankTruck({
      id: uuid('truck'),
      plateNo: draft.plateNo.trim() === '' ? '未登记车牌' : draft.plateNo.trim(),
      capacityM3: draft.capacityM3,
      tripsPerDay: draft.tripsPerDay,
      status: draft.status,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    });
    setState('lastMessage', `已登记槽车 ${draft.plateNo}`);
  }

  async function updateTruck(truckId: string, draft: TruckDraft): Promise<void> {
    const existing = state.trucks.find((row) => row.id === truckId);
    if (existing === undefined) return;
    await putTankTruck({
      ...existing,
      plateNo: draft.plateNo.trim() === '' ? existing.plateNo : draft.plateNo.trim(),
      capacityM3: draft.capacityM3,
      tripsPerDay: draft.tripsPerDay,
      status: draft.status,
    });
    setState('lastMessage', `槽车 ${existing.plateNo} 已更新`);
  }

  async function deleteTruck(truckId: string): Promise<void> {
    await removeTankTruck(truckId);
    setState('lastMessage', '槽车已删除');
  }

  /* ------------------------------ 罐区与对账 ------------------------------ */

  async function saveFarm(totalCapacityM3: number): Promise<void> {
    await saveTankFarmCapacity(totalCapacityM3);
    setState('lastMessage', `罐区总容量已调整为 ${totalCapacityM3} m³`);
  }

  async function reviewRecon(pondId: string, reviewer: string): Promise<void> {
    const row = await reviewReconciliation(pondId, reviewer);
    setState(
      'lastMessage',
      `已复核：调度外送 ${row.scheduleTotalM3} m³ / 储运装车 ${row.shipmentTotalM3} m³，差 ${row.diffM3} m³`,
    );
  }

  return {
    state,
    setMessage,
    createOrder,
    updateOrder,
    voidOrder,
    reassignOrder,
    loadOrder,
    createTruck,
    updateTruck,
    deleteTruck,
    saveFarm,
    reviewRecon,
  };
}

const store = createRoot(createShipmentStore);

export function useShipmentStore() {
  return store;
}
