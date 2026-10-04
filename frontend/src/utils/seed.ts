/**
 * 演示数据播种（幂等）
 * 父 → 子 → 孙三层链路：蒸发池 → 闸门串级 / 卤水日观测 → 离子组分分析 → 走水编排
 * 所有 id 固定，保证 /gates、/observations、/assays、/schedules 打开就有真实串级与数据。
 */
import { db, ROW_REVISION } from './db';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule } from '../types/schedule';
import type { ShippingOrder } from '../types/shippingOrder';
import { autoVerdict, estimateEvapMm } from './brine';

const SEED_TIME = '2026-09-01T00:30:00.000Z';

/** 固定 id，便于文档与深链验证 */
export const SEED_IDS = {
  pondA: 'pond-north-01',
  pondB: 'pond-north-02',
  pondC: 'pond-north-03',
  pondD: 'pond-south-04',
  pondE: 'pond-south-05',
} as const;

function wrap<T>(row: Omit<T, 'createdAt' | 'updatedAt' | 'revision'>): T {
  return { ...row, createdAt: SEED_TIME, updatedAt: SEED_TIME, revision: ROW_REVISION } as T;
}

/** 生成观测记录，evapMm 由经验公式估算 */
function observation(
  id: string,
  pondId: string,
  date: string,
  densityGcm3: number,
  tempC: number,
  levelCm: number,
  windLevel: number,
): Observation {
  return wrap<Observation>({
    id,
    pondId,
    date,
    densityGcm3,
    tempC,
    levelCm,
    windLevel,
    evapMm: estimateEvapMm(densityGcm3, tempC, levelCm, windLevel),
  });
}

/** 生成化验记录，verdict 默认自动判定 */
function assay(
  id: string,
  pondId: string,
  date: string,
  liGpl: number,
  kGpl: number,
  mgGpl: number,
  naGpl: number,
  labName: string,
  manual?: { verdict: Assay['verdict']; verdictManual: true },
): Assay {
  return wrap<Assay>({
    id,
    pondId,
    date,
    liGpl,
    kGpl,
    mgGpl,
    naGpl,
    labName,
    verdict: manual?.verdict ?? autoVerdict(liGpl, kGpl),
    verdictManual: manual?.verdictManual ?? false,
  });
}

export async function seedDatabase(): Promise<void> {
  const exists = await db.ponds.count();
  if (exists > 0) return;

  // ---------------- 蒸发池（5 口，跨 2 个池系、3 个阶段） ----------------
  const ponds: Pond[] = [
    wrap<Pond>({ id: SEED_IDS.pondA, code: '北-01', seriesName: '北部一系', areaM2: 12000, depthCm: 45, stage: '钠盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondB, code: '北-02', seriesName: '北部一系', areaM2: 9000, depthCm: 40, stage: '钾盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondC, code: '北-03', seriesName: '北部一系', areaM2: 6800, depthCm: 35, stage: '锂盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondD, code: '南-04', seriesName: '南部二系', areaM2: 15000, depthCm: 50, stage: '钠盐', status: '在用' }),
    wrap<Pond>({ id: SEED_IDS.pondE, code: '南-05', seriesName: '南部二系', areaM2: 7200, depthCm: 38, stage: '钾盐', status: '清池中' }),
  ];

  // ---------------- 闸门串级（上游 → 下游，形成完整走向链） ----------------
  const gates: Gate[] = [
    wrap<Gate>({ id: 'gate-a-b', fromPondId: SEED_IDS.pondA, toPondId: SEED_IDS.pondB, openingPct: 65, widthCm: 120, state: '半开', note: '北部一系主走水通道' }),
    wrap<Gate>({ id: 'gate-b-c', fromPondId: SEED_IDS.pondB, toPondId: SEED_IDS.pondC, openingPct: 40, widthCm: 100, state: '半开', note: '进入锂盐阶段前的控流闸' }),
    wrap<Gate>({ id: 'gate-d-e', fromPondId: SEED_IDS.pondD, toPondId: SEED_IDS.pondE, openingPct: 80, widthCm: 140, state: '半开', note: '南部二系主走水通道' }),
    wrap<Gate>({ id: 'gate-b-e', fromPondId: SEED_IDS.pondB, toPondId: SEED_IDS.pondE, openingPct: 0, widthCm: 90, state: '关闭', note: '跨池系调水备用闸，当前关闭' }),
  ];

  // ---------------- 卤水日观测（每池 2–4 条，密度随日期递增） ----------------
  // 北-01 最新密度 1.118 ≥ 目标 1.115（可出卤）；南-04 最新密度 1.102 ≥ 目标 1.098（可出卤，但罐区容量不足会排队）
  const observations: Observation[] = [
    observation('obs-a1', SEED_IDS.pondA, '2026-08-20', 1.045, 28, 45, 2),
    observation('obs-a2', SEED_IDS.pondA, '2026-08-30', 1.062, 30, 43, 3),
    observation('obs-a3', SEED_IDS.pondA, '2026-09-10', 1.086, 29, 41, 2),
    observation('obs-a4', SEED_IDS.pondA, '2026-09-22', 1.118, 26, 39, 3),
    observation('obs-b1', SEED_IDS.pondB, '2026-08-22', 1.112, 27, 40, 2),
    observation('obs-b2', SEED_IDS.pondB, '2026-09-02', 1.14, 29, 38, 3),
    observation('obs-b3', SEED_IDS.pondB, '2026-09-14', 1.168, 28, 36, 2),
    observation('obs-c1', SEED_IDS.pondC, '2026-08-25', 1.195, 26, 35, 1),
    observation('obs-c2', SEED_IDS.pondC, '2026-09-05', 1.222, 27, 33, 2),
    observation('obs-c3', SEED_IDS.pondC, '2026-09-18', 1.248, 25, 31, 2),
    observation('obs-d1', SEED_IDS.pondD, '2026-08-21', 1.038, 30, 50, 4),
    observation('obs-d2', SEED_IDS.pondD, '2026-09-01', 1.055, 31, 48, 3),
    observation('obs-d3', SEED_IDS.pondD, '2026-09-12', 1.074, 29, 46, 2),
    observation('obs-d4', SEED_IDS.pondD, '2026-09-24', 1.102, 27, 44, 3),
    observation('obs-e1', SEED_IDS.pondE, '2026-08-24', 1.12, 28, 38, 2),
    observation('obs-e2', SEED_IDS.pondE, '2026-09-04', 1.146, 29, 36, 2),
  ];

  // ---------------- 离子组分分析（含达标 / 接近 / 未达标三种判定） ----------------
  const assays: Assay[] = [
    assay('assay-a1', SEED_IDS.pondA, '2026-09-22', 0.12, 6.4, 42.5, 88.2, '盐湖中心化验室'),
    assay('assay-b1', SEED_IDS.pondB, '2026-09-14', 0.72, 15.5, 21.8, 58.4, '盐湖中心化验室'),
    assay('assay-c1', SEED_IDS.pondC, '2026-09-05', 1.05, 18.2, 9.6, 26.1, '盐湖中心化验室'),
    assay('assay-c2', SEED_IDS.pondC, '2026-09-18', 1.32, 22.6, 8.4, 24.3, '盐湖中心化验室'),
    assay('assay-d1', SEED_IDS.pondD, '2026-09-24', 0.08, 4.2, 48.9, 96.5, '南部化验站'),
    assay('assay-e1', SEED_IDS.pondE, '2026-09-04', 0.48, 13.6, 24.2, 61.7, '南部化验站', {
      verdict: '接近',
      verdictManual: true,
    }),
  ];

  // ---------------- 发运单（储运班账本，另记一本；调度室只选外送归属，改不了发运单） ----------------
  const shippingOrders = buildShippingOrders(ponds);

  // ---------------- 走水编排（覆盖四种状态，orderIndex 决定先后；外送归属按池号接上发运单） ----------------
  const orderIdByPond = new Map(shippingOrders.map((order) => [order.pondId, order.id]));
  const schedules: Schedule[] = [
    wrap<Schedule>({
      id: 'schedule-a1',
      pondId: SEED_IDS.pondA,
      shippingOrderId: orderIdByPond.get(SEED_IDS.pondA) ?? '',
      planDate: '2026-10-02',
      targetDensity: 1.115,
      volumeM3: 1200,
      operator: '韩江',
      state: '已排',
      orderIndex: 1,
      queueReason: '',
    }),
    wrap<Schedule>({
      id: 'schedule-d1',
      pondId: SEED_IDS.pondD,
      shippingOrderId: orderIdByPond.get(SEED_IDS.pondD) ?? '',
      planDate: '2026-10-04',
      targetDensity: 1.098,
      volumeM3: 1600,
      operator: '王锐',
      state: '已排',
      orderIndex: 2,
      queueReason: '',
    }),
    wrap<Schedule>({
      id: 'schedule-b1',
      pondId: SEED_IDS.pondB,
      shippingOrderId: orderIdByPond.get(SEED_IDS.pondB) ?? '',
      planDate: '2026-10-06',
      targetDensity: 1.175,
      volumeM3: 900,
      operator: '韩江',
      state: '走水中',
      orderIndex: 3,
      queueReason: '',
    }),
    wrap<Schedule>({
      id: 'schedule-c1',
      pondId: SEED_IDS.pondC,
      shippingOrderId: orderIdByPond.get(SEED_IDS.pondC) ?? '',
      planDate: '2026-10-12',
      targetDensity: 1.255,
      volumeM3: 600,
      operator: '李文',
      state: '待排',
      orderIndex: 4,
      queueReason: '',
    }),
    wrap<Schedule>({
      id: 'schedule-e1',
      pondId: SEED_IDS.pondE,
      shippingOrderId: orderIdByPond.get(SEED_IDS.pondE) ?? '',
      planDate: '2026-09-28',
      targetDensity: 1.15,
      volumeM3: 700,
      operator: '王锐',
      state: '已出卤',
      orderIndex: 5,
      queueReason: '',
    }),
  ];

  await db.transaction('rw', [db.ponds, db.gates, db.observations, db.assays, db.schedules, db.shippingOrders], async () => {
    await db.ponds.bulkPut(ponds);
    await db.gates.bulkPut(gates);
    await db.observations.bulkPut(observations);
    await db.assays.bulkPut(assays);
    await db.shippingOrders.bulkPut(shippingOrders);
    await db.schedules.bulkPut(schedules);
  });
}

/**
 * 按池构建储运班发运单（幂等：仅在发运单表为空时由播种 / v3 迁移调用）。
 * 槽车运力 = 槽车数量 × 单车运力；南-05 已装车 750 m³，与已出卤 700 m³ 差 50 m³（超容差），
 * 用于演示「累计外送量 vs 装车量」对账不符、摆出来等储运班复核。
 */
export function buildShippingOrders(ponds: Pond[]): ShippingOrder[] {
  const plans: Record<string, { farm: string; volume: number; cars: number; perCar: number; loaded: number; shipDate: string }> = {
    '北-01': { farm: '东罐区', volume: 1200, cars: 10, perCar: 120, loaded: 0, shipDate: '2026-10-02' },
    '北-02': { farm: '西罐区', volume: 900, cars: 8, perCar: 120, loaded: 0, shipDate: '2026-10-06' },
    '北-03': { farm: '西罐区', volume: 600, cars: 6, perCar: 110, loaded: 0, shipDate: '2026-10-12' },
    '南-04': { farm: '东罐区', volume: 1600, cars: 12, perCar: 140, loaded: 0, shipDate: '2026-10-04' },
    '南-05': { farm: '东罐区', volume: 800, cars: 7, perCar: 120, loaded: 750, shipDate: '2026-09-28' },
  };
  return ponds.map((pond, index) => {
    const plan = plans[pond.code] ?? { farm: '东罐区', volume: 800, cars: 6, perCar: 120, loaded: 0, shipDate: '2026-10-01' };
    return wrap<ShippingOrder>({
      id: `so-${pond.id}`,
      orderNo: `FY-2026-${String(index + 1).padStart(3, '0')}`,
      pondId: pond.id,
      volumeM3: plan.volume,
      tankCarCount: plan.cars,
      tankCarCapacityM3: plan.perCar,
      loadedVolumeM3: plan.loaded,
      tankFarm: plan.farm,
      shipDate: plan.shipDate,
      status: '有效',
      note: plan.loaded > 0 ? `已装车 ${plan.loaded} m³，待与调度室对账` : '',
    });
  });
}
