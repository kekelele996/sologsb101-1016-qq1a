/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：接入储运外送台账（发运单 / 槽车 / 罐区 / 对账复核四张新表），
 *       走水编排补外送归属（按池匹配有效发运单），原顺序与状态保持不动
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import type { ShipmentOrder } from '../types/shipment';
import type { TankFarm, TankTruck } from '../types/truck';
import { TANK_FARM_ID } from '../types/truck';
import type { ReconReview } from '../types/recon';
import { estimateEvapMm, round1 } from './brine';
import { checkDischarge, type DischargeCheck } from './dispatch';
import { nowIso, uuid } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;
  shipmentOrders!: Table<ShipmentOrder, string>;
  tankTrucks!: Table<TankTruck, string>;
  tankfarm!: Table<TankFarm, string>;
  reconReviews!: Table<ReconReview, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    // 历史版本号写死为 2，勿随 DB_SCHEMA_VERSION 常量改动
    this.version(2)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：接入储运外送台账，走水编排补外送归属 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, shipmentOrderId',
        shipmentOrders: 'id, code, pondId, status',
        tankTrucks: 'id, plateNo, status',
        tankfarm: 'id',
        reconReviews: 'id, pondId, reviewedAt',
      })
      .upgrade(async (tx) => {
        // 迁移 1：走水编排补外送归属 —— 按池匹配最早一张有效发运单；
        // 找不到则留空（null），等调度员重排时核单再接；原 orderIndex 与 state 一律不动。
        const orders = (await tx.table('shipmentOrders').toArray()) as ShipmentOrder[];
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.queuedForCapacity !== 'boolean') row.queuedForCapacity = false;
          if (typeof row.shortfallM3 !== 'number' || !Number.isFinite(row.shortfallM3)) row.shortfallM3 = 0;
          if (row.shipmentOrderId === undefined) {
            const matched = orders
              .filter((order) => order.pondId === row.pondId && order.status !== '已作废')
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
            row.shipmentOrderId = matched === undefined ? null : matched.id;
          }
        });
        // 迁移 2：罐区台账缺省建立一座（容量 0 表示待储运班录入，录入前出卤一律按池排队）
        if ((await tx.table('tankfarm').count()) === 0) {
          const stamp = nowIso();
          await tx.table('tankfarm').add({
            id: TANK_FARM_ID,
            name: '成品卤罐区',
            totalCapacityM3: 0,
            createdAt: stamp,
            updatedAt: stamp,
            revision: ROW_REVISION,
          });
        }
      });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验、走水计划、发运单与对账复核 */
export async function removePond(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.shipmentOrders, db.reconReviews],
    async () => {
      const gates = await db.gates.toArray();
      const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
      if (related.length > 0) await db.gates.bulkDelete(related);
      await db.observations.where('pondId').equals(id).delete();
      await db.assays.where('pondId').equals(id).delete();
      await db.schedules.where('pondId').equals(id).delete();
      await db.shipmentOrders.where('pondId').equals(id).delete();
      await db.reconReviews.where('pondId').equals(id).delete();
      await db.ponds.delete(id);
    },
  );
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 就地调整开度：同步推导闸门状态 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeAssay(id: string): Promise<void> {
  await db.assays.delete(id);
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/**
 * 出卤核单：推进出卤前，按发运单剩余量与槽车运力核一遍；
 * 罐区剩余容量不足时返回 queue 与还差多少方，由调用方决定排队。
 */
export async function verifyDischarge(scheduleId: string): Promise<DischargeCheck | null> {
  const schedule = await db.schedules.get(scheduleId);
  if (schedule === undefined) return null;
  const [orders, trucks, schedules, farm] = await Promise.all([
    db.shipmentOrders.toArray(),
    db.tankTrucks.toArray(),
    db.schedules.toArray(),
    db.tankfarm.get(TANK_FARM_ID),
  ]);
  return checkDischarge({
    schedule,
    orders,
    trucks,
    schedules,
    totalCapacityM3: farm?.totalCapacityM3 ?? 0,
  });
}

/** 罐区容量不足：按池排队并记下还差多少方（走水状态、池水位与目标密度本轮一律不动） */
export async function markScheduleQueued(scheduleId: string, shortfallM3: number): Promise<void> {
  await db.schedules.update(scheduleId, { queuedForCapacity: true, shortfallM3, updatedAt: nowIso() });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 * 同时接上外送归属（核单匹配的发运单）并清除罐区排队标记。
 */
export async function applyDischarge(
  scheduleId: string,
  actualDensity: number,
  shipmentOrderId?: string | null,
): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, {
      state: '已出卤',
      queuedForCapacity: false,
      shortfallM3: 0,
      ...(shipmentOrderId === undefined ? {} : { shipmentOrderId }),
      updatedAt: nowIso(),
    });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
      updatedAt: nowIso(),
    });
  });
}

/** 推进走水状态（出卤一步请走 verifyDischarge 核单后再调 applyDischarge） */
export async function advanceScheduleState(scheduleId: string, next: ScheduleState, actualDensity: number): Promise<void> {
  if (next === '已出卤') {
    await applyDischarge(scheduleId, actualDensity);
    return;
  }
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* ------------------------------ 发运单（储运班台账） ------------------------------ */

export async function listShipmentOrders(): Promise<ShipmentOrder[]> {
  const rows = await db.shipmentOrders.toArray();
  return rows.sort((a, b) => a.code.localeCompare(b.code));
}

export async function putShipmentOrder(row: ShipmentOrder): Promise<void> {
  await db.shipmentOrders.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/**
 * 作废发运单：靠它排出的出卤（未出卤的）退回待排、清外送归属，等调度员重排；
 * 已出卤的照旧。已装完的发运单按旧账照旧，不允许作废。
 */
export async function voidShipmentOrder(orderId: string): Promise<{ reverted: number }> {
  return db.transaction('rw', db.shipmentOrders, db.schedules, async () => {
    const order = await db.shipmentOrders.get(orderId);
    if (order === undefined) return { reverted: 0 };
    if (order.status === '已装完') throw new Error('发运单已装完，按旧账照旧，不能作废');
    if (order.status === '已作废') return { reverted: 0 };
    await db.shipmentOrders.update(orderId, { status: '已作废', updatedAt: nowIso() });
    const linked = await db.schedules.where('shipmentOrderId').equals(orderId).toArray();
    let reverted = 0;
    for (const schedule of linked) {
      if (schedule.state === '已出卤') continue;
      await db.schedules.update(schedule.id, {
        state: '待排',
        shipmentOrderId: null,
        queuedForCapacity: false,
        shortfallM3: 0,
        updatedAt: nowIso(),
      });
      reverted += 1;
    }
    return { reverted };
  });
}

/**
 * 改派别池：发运单改归属另一口池；原池靠它排出的出卤（未出卤的）退回待排，
 * 等调度员重排，已出卤的照旧。已装完 / 已作废的单不允许改派。
 */
export async function reassignShipmentOrder(orderId: string, nextPondId: string): Promise<{ reverted: number }> {
  return db.transaction('rw', db.shipmentOrders, db.schedules, async () => {
    const order = await db.shipmentOrders.get(orderId);
    if (order === undefined) return { reverted: 0 };
    if (order.status === '已装完') throw new Error('发运单已装完，按旧账照旧，不能改派');
    if (order.status === '已作废') throw new Error('发运单已作废，不能改派');
    if (order.pondId === nextPondId) return { reverted: 0 };
    await db.shipmentOrders.update(orderId, { pondId: nextPondId, updatedAt: nowIso() });
    const linked = await db.schedules.where('shipmentOrderId').equals(orderId).toArray();
    let reverted = 0;
    for (const schedule of linked) {
      if (schedule.state === '已出卤') continue;
      await db.schedules.update(schedule.id, {
        state: '待排',
        shipmentOrderId: null,
        queuedForCapacity: false,
        shortfallM3: 0,
        updatedAt: nowIso(),
      });
      reverted += 1;
    }
    return { reverted };
  });
}

/** 装车登记：累加已装车量，并按计划量自动推进发运单状态（待发运 → 装运中 → 已装完） */
export async function loadShipment(orderId: string, volumeM3: number): Promise<ShipmentOrder> {
  return db.transaction('rw', db.shipmentOrders, async () => {
    const order = await db.shipmentOrders.get(orderId);
    if (order === undefined) throw new Error('发运单不存在');
    if (order.status === '已作废') throw new Error('发运单已作废，不能登记装车');
    const loadedVolumeM3 = round1(order.loadedVolumeM3 + volumeM3);
    const status: ShipmentOrder['status'] = loadedVolumeM3 >= order.plannedVolumeM3 ? '已装完' : '装运中';
    const next: ShipmentOrder = { ...order, loadedVolumeM3, status, updatedAt: nowIso(), revision: ROW_REVISION };
    await db.shipmentOrders.put(next);
    return next;
  });
}

/* ------------------------------ 槽车与罐区 ------------------------------ */

export async function listTankTrucks(): Promise<TankTruck[]> {
  const rows = await db.tankTrucks.toArray();
  return rows.sort((a, b) => a.plateNo.localeCompare(b.plateNo));
}

export async function putTankTruck(row: TankTruck): Promise<void> {
  await db.tankTrucks.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeTankTruck(id: string): Promise<void> {
  await db.tankTrucks.delete(id);
}

export async function getTankFarm(): Promise<TankFarm | null> {
  const row = await db.tankfarm.get(TANK_FARM_ID);
  return row ?? null;
}

/** 维护罐区总容量（占用量由出卤与装车派生，不手工改） */
export async function saveTankFarmCapacity(totalCapacityM3: number, name?: string): Promise<void> {
  const existing = await db.tankfarm.get(TANK_FARM_ID);
  const stamp = nowIso();
  await db.tankfarm.put({
    id: TANK_FARM_ID,
    name: name ?? existing?.name ?? '成品卤罐区',
    totalCapacityM3,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  });
}

/* ------------------------------ 按池对账复核 ------------------------------ */

export async function listReconReviews(): Promise<ReconReview[]> {
  const rows = await db.reconReviews.toArray();
  return rows.sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt));
}

/** 储运班复核：把当前两边数字原样落账，数字再变则自动回到待复核 */
export async function reviewReconciliation(pondId: string, reviewer: string): Promise<ReconReview> {
  const [schedules, orders] = await Promise.all([db.schedules.toArray(), db.shipmentOrders.toArray()]);
  const scheduleTotalM3 = round1(
    schedules
      .filter((row) => row.pondId === pondId && row.state === '已出卤')
      .reduce((acc, row) => acc + row.volumeM3, 0),
  );
  const shipmentTotalM3 = round1(
    orders
      .filter((row) => row.pondId === pondId && row.status !== '已作废')
      .reduce((acc, row) => acc + row.loadedVolumeM3, 0),
  );
  const stamp = nowIso();
  const row: ReconReview = {
    id: uuid('recon'),
    pondId,
    scheduleTotalM3,
    shipmentTotalM3,
    diffM3: round1(scheduleTotalM3 - shipmentTotalM3),
    reviewer: reviewer.trim() === '' ? '储运班' : reviewer.trim(),
    reviewedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  };
  await db.reconReviews.put(row);
  return row;
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
  shipmentOrders: ShipmentOrder[];
  tankTrucks: TankTruck[];
  tankfarm: TankFarm[];
  reconReviews: ReconReview[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules, shipmentOrders, tankTrucks, tankfarm, reconReviews] =
    await Promise.all([
      db.ponds.toArray(),
      db.gates.toArray(),
      db.observations.toArray(),
      db.assays.toArray(),
      db.schedules.toArray(),
      db.shipmentOrders.toArray(),
      db.tankTrucks.toArray(),
      db.tankfarm.toArray(),
      db.reconReviews.toArray(),
    ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    ponds,
    gates,
    observations,
    assays,
    schedules,
    shipmentOrders,
    tankTrucks,
    tankfarm,
    reconReviews,
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.ponds,
      db.gates,
      db.observations,
      db.assays,
      db.schedules,
      db.shipmentOrders,
      db.tankTrucks,
      db.tankfarm,
      db.reconReviews,
    ],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.shipmentOrders.clear(),
        db.tankTrucks.clear(),
        db.tankfarm.clear(),
        db.reconReviews.clear(),
      ]);
      await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.schedules.bulkPut(snapshot.schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.shipmentOrders.bulkPut((snapshot.shipmentOrders ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.tankTrucks.bulkPut((snapshot.tankTrucks ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.tankfarm.bulkPut((snapshot.tankfarm ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
      await db.reconReviews.bulkPut((snapshot.reconReviews ?? []).map((row) => ({ ...row, revision: ROW_REVISION })));
    },
  );
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.ponds,
      db.gates,
      db.observations,
      db.assays,
      db.schedules,
      db.shipmentOrders,
      db.tankTrucks,
      db.tankfarm,
      db.reconReviews,
    ],
    async () => {
      await Promise.all([
        db.ponds.clear(),
        db.gates.clear(),
        db.observations.clear(),
        db.assays.clear(),
        db.schedules.clear(),
        db.shipmentOrders.clear(),
        db.tankTrucks.clear(),
        db.tankfarm.clear(),
        db.reconReviews.clear(),
      ]);
    },
  );
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules, shipmentOrders, tankTrucks, reconReviews] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
    db.shipmentOrders.count(),
    db.tankTrucks.count(),
    db.reconReviews.count(),
  ]);
  return { ponds, gates, observations, assays, schedules, shipmentOrders, tankTrucks, reconReviews };
}
