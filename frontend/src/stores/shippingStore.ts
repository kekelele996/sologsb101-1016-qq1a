/**
 * 发运单状态管理（Solid 原生能力）
 * 储运班的外送账本：发运单与槽车运力另记一本，调度室只选外送归属、改不了发运单。
 * 作废 / 改派别池由储运班操作，靠它排出的出卤退回待排、等调度员重排（已装完的照旧）。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { ShippingOrder, ShippingOrderDraft } from '../types/shippingOrder';
import {
  db,
  initDatabase,
  putShippingOrder,
  removeShippingOrder,
  updateShippingOrderWithCascade,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';

interface ShippingState {
  rows: ShippingOrder[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createShippingStore() {
  const [state, setState] = createStore<ShippingState>({
    rows: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [keyword, setKeyword] = createSignal('');
  const [statusFilter, setStatusFilter] = createSignal<ShippingOrder['status'] | 'all'>('all');

  // 建库必须放在 querier 外（与 scheduleStore 同理），否则 liveQuery 采集不到可观测性集合。
  void initDatabase();

  liveQuery(async () => {
    return db.shippingOrders.toArray();
  }).subscribe({
    next: (list) => {
      setState(
        'rows',
        [...list].sort((a, b) => a.shipDate.localeCompare(b.shipDate) || a.orderNo.localeCompare(b.orderNo)),
      );
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取发运单失败' });
    },
  });

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  function patchFilters(patch: Partial<{ keyword: string; status: ShippingOrder['status'] | 'all' }>): void {
    if (patch.keyword !== undefined) setKeyword(patch.keyword);
    if (patch.status !== undefined) setStatusFilter(patch.status);
  }

  function resetFilters(): void {
    setKeyword('');
    setStatusFilter('all');
  }

  async function createShippingOrder(draft: ShippingOrderDraft): Promise<ShippingOrder> {
    const stamp = nowIso();
    const row: ShippingOrder = {
      id: uuid('ship'),
      orderNo: draft.orderNo.trim() || `FY-${Date.now()}`,
      pondId: draft.pondId,
      volumeM3: draft.volumeM3,
      tankCarCount: draft.tankCarCount,
      tankCarCapacityM3: draft.tankCarCapacityM3,
      loadedVolumeM3: draft.loadedVolumeM3,
      tankFarm: draft.tankFarm.trim() || '东罐区',
      shipDate: draft.shipDate,
      status: draft.status,
      note: draft.note.trim(),
      createdAt: stamp,
      updatedAt: stamp,
      revision: 2,
    };
    await putShippingOrder(row);
    setState('lastMessage', `已新建发运单：${row.orderNo}`);
    return row;
  }

  async function updateShippingOrder(orderId: string, draft: ShippingOrderDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === orderId);
    if (existing === undefined) return;
    await updateShippingOrderWithCascade(
      orderId,
      {
        ...draft,
        orderNo: draft.orderNo.trim() || existing.orderNo,
        tankFarm: draft.tankFarm.trim() || existing.tankFarm,
        note: draft.note.trim(),
      },
      existing,
    );
    const voided = draft.status === '作废' && existing.status === '有效';
    const reassigned = draft.pondId !== existing.pondId;
    setState(
      'lastMessage',
      voided
        ? `发运单已作废，靠它排出的出卤已退回待排`
        : reassigned
          ? `发运单已改派别池，靠它排出的出卤已退回待排`
          : '发运单已更新',
    );
  }

  /** 储运班作废发运单：靠它排出的出卤退回待排，已装完的照旧 */
  async function voidShippingOrder(orderId: string): Promise<void> {
    const existing = state.rows.find((row) => row.id === orderId);
    if (existing === undefined) return;
    await updateShippingOrderWithCascade(orderId, { ...existing, status: '作废' }, existing);
    setState('lastMessage', `发运单 ${existing.orderNo} 已作废，靠它排出的出卤已退回待排`);
  }

  async function deleteShippingOrder(orderId: string): Promise<void> {
    await removeShippingOrder(orderId);
    setState('lastMessage', '发运单已删除');
  }

  /** 按池号取有效发运单（调度室选外送归属用） */
  function activeOrdersOfPond(pondId: string): ShippingOrder[] {
    return state.rows.filter((row) => row.pondId === pondId && row.status === '有效');
  }

  return {
    state,
    keyword,
    statusFilter,
    patchFilters,
    resetFilters,
    setMessage,
    createShippingOrder,
    updateShippingOrder,
    voidShippingOrder,
    deleteShippingOrder,
    activeOrdersOfPond,
  };
}

const store = createRoot(createShippingStore);

export function useShippingStore() {
  return store;
}
