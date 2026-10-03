import { useStore } from 'zustand'
import type { StoreApi, UseBoundStore } from 'zustand'
import Dexie, { type Table } from 'dexie'
import type { Acceptance, BeeColony, Deployment, DropPoint, Orchard, TransitRoute, WithdrawalPlan } from '@/types'

/** IndexedDB 数据结构版本号 */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/** Dexie 封装：果园 / 蜂群 / 投放点 / 投放安排 / 撤场安排 / 转场路线 六张表 + 元数据表 */
class BeeRouteDb extends Dexie {
  orchards!: Table<Orchard, string>
  colonies!: Table<BeeColony, string>
  dropPoints!: Table<DropPoint, string>
  deployments!: Table<Deployment, string>
  withdrawals!: Table<WithdrawalPlan, string>
  routes!: Table<TransitRoute, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('gbbeeroute')
    this.version(1).stores({
      orchards: 'id, name, crop',
      colonies: 'id, code, status',
      dropPoints: 'id, orchardId, code',
      routes: 'id, fromDropId, toDropId',
      meta: 'key'
    })
    // v2：投放点新增「可容纳箱数」字段，迁移时为历史投放点补齐（按 8 箱兜底）
    this.version(2).stores({
      orchards: 'id, name, crop, bloomStart',
      colonies: 'id, code, status, currentOrchardId',
      dropPoints: 'id, orchardId, code, dropWindow',
      routes: 'id, fromDropId, toDropId, departAt',
      meta: 'key'
    })
    // v3：验收结论（地块）+ 投放安排 / 撤场安排（技术员），旧群号安排迁移为投放记录
    this.version(SCHEMA_VERSION)
      .stores({
        orchards: 'id, name, crop, bloomStart, acceptance',
        colonies: 'id, code, status, currentOrchardId',
        dropPoints: 'id, orchardId, code, dropWindow',
        deployments: 'id, colonyId, dropPointId, orchardId, status',
        withdrawals: 'id, orchardId, status',
        routes: 'id, fromDropId, toDropId, departAt',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        // 旧数据没有验收结论，统一按「待验收」补上
        await tx
          .table<Orchard, string>('orchards')
          .toCollection()
          .modify((orchard) => {
            if (!orchard.acceptance) {
              orchard.acceptance = '待验收' as Acceptance
            }
          })

        const colonies = await tx.table<BeeColony, string>('colonies').toArray()
        const colonyByCode = new Map(colonies.map((item) => [item.code, item]))
        const colonyUpdates = new Map<string, { status: BeeColony['status']; orchardId: string }>()

        // 旧投放点的「安排群号」迁移为投放安排：按容量落箱，装不下排队
        const points = await tx.table<DropPoint & { colonyCodes?: string[] }, string>('dropPoints').toArray()
        let seq = 0
        for (const point of points) {
          let placed = 0
          const capacity = point.capacityBoxes || 0
          for (const code of point.colonyCodes ?? []) {
            const colony = colonyByCode.get(code)
            if (!colony) continue
            const status: Deployment['status'] = placed < capacity ? '已投放' : '排队中'
            seq += 1
            if (status === '已投放') {
              placed += 1
              colonyUpdates.set(colony.id, { status: '在园', orchardId: point.orchardId })
            } else if (!colonyUpdates.has(colony.id)) {
              colonyUpdates.set(colony.id, { status: '待投放', orchardId: '' })
            }
            await tx.table<Deployment, string>('deployments').put({
              id: `dep_mig_${seq}`,
              colonyId: colony.id,
              dropPointId: point.id,
              orchardId: point.orchardId,
              status,
              queuedAt: seq
            })
          }
        }
        for (const [colonyId, update] of colonyUpdates) {
          await tx.table<BeeColony, string>('colonies').update(colonyId, {
            status: update.status,
            currentOrchardId: update.orchardId
          })
        }

        // 群号安排改由技术员的投放安排承载，投放点不再持有
        await tx
          .table<DropPoint & { colonyCodes?: string[] }, string>('dropPoints')
          .toCollection()
          .modify((point) => {
            delete point.colonyCodes
          })
      })
  }
}

export const db = new BeeRouteDb()

/** 写入当前数据结构版本号 */
export async function stampDbVersion(): Promise<void> {
  await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
}

/** 读取整表 */
export async function loadAll<T extends object>(table: Table<T, string>): Promise<T[]> {
  return table.toArray()
}

/** 写入一条记录 */
export async function putRow<T extends object>(table: Table<T, string>, row: T): Promise<void> {
  await table.put(row)
}

/** 删除一条记录 */
export async function deleteRow<T extends object>(table: Table<T, string>, id: string): Promise<void> {
  await table.delete(id)
}

/** Zustand store ↔ Dexie 表 的读写桥接（页面统一通过它读取 store） */
export function usePersistentStore<T extends object>(store: UseBoundStore<StoreApi<T>>): T
export function usePersistentStore<T extends object, S>(
  store: UseBoundStore<StoreApi<T>>,
  selector: (state: T) => S
): S
export function usePersistentStore<T extends object, S>(
  store: UseBoundStore<StoreApi<T>>,
  selector?: (state: T) => S
): T | S {
  return useStore(store, selector ?? ((state: T) => state as unknown as S))
}

/** 首次打开写入示例数据 */
export async function seedDemoData(): Promise<void> {
  const count = await db.orchards.count()
  if (count > 0) return

  const year = new Date().getFullYear()

  await db.orchards.bulkPut([
    {
      id: 'orc_ap',
      name: '北岭苹果园',
      crop: '苹果',
      areaMu: 120,
      longitude: 107.4132,
      latitude: 34.6128,
      bloomStart: `${year}-04-08`,
      bloomEnd: `${year}-04-18`,
      colonyIntensity: 0.1,
      ownerContact: '135****2043（周园主）',
      accessibility: '大车可达',
      historyYears: [year - 2, year - 1],
      acceptance: '达标',
      note: '主栽富士，行距 4 m，南坡'
    },
    {
      id: 'orc_cherry',
      name: '西沟樱桃坡',
      crop: '樱桃',
      areaMu: 46,
      longitude: 107.3755,
      latitude: 34.5891,
      bloomStart: `${year}-04-12`,
      bloomEnd: `${year}-04-21`,
      colonyIntensity: 0.2,
      ownerContact: '138****7712（李园主）',
      accessibility: '仅小车',
      historyYears: [year - 1],
      acceptance: '待验收',
      note: '坡地梯田，需小车倒运蜂箱'
    },
    {
      id: 'orc_rape',
      name: '东滩油菜田',
      crop: '油菜',
      areaMu: 220,
      longitude: 107.4621,
      latitude: 34.6435,
      bloomStart: `${year}-03-28`,
      bloomEnd: `${year}-04-12`,
      colonyIntensity: 0.05,
      ownerContact: '137****9981（合作社）',
      accessibility: '大车可达',
      historyYears: [year - 1],
      acceptance: '不达标',
      note: '连片油菜，与苹果花期部分重叠；坐果不足需补投'
    }
  ])

  await db.colonies.bulkPut([
    {
      id: 'col_001',
      code: 'Q-01',
      species: '意蜂',
      strengthFrames: 8,
      boxType: '标准继箱',
      currentOrchardId: 'orc_ap',
      status: '在园',
      lastCheckDate: `${year}-04-09`,
      healthNote: '群势稳定，子脾整齐'
    },
    {
      id: 'col_002',
      code: 'Q-02',
      species: '意蜂',
      strengthFrames: 6,
      boxType: '标准继箱',
      currentOrchardId: '',
      status: '待投放',
      lastCheckDate: `${year}-04-05`,
      healthNote: '轻微螨害，转场后需治螨'
    },
    {
      id: 'col_003',
      code: 'Q-03',
      species: '中蜂',
      strengthFrames: 4,
      boxType: '平箱',
      currentOrchardId: '',
      status: '待投放',
      lastCheckDate: `${year}-04-02`,
      healthNote: '新分群，群势偏弱'
    },
    {
      id: 'col_004',
      code: 'Q-04',
      species: '意蜂',
      strengthFrames: 7,
      boxType: '标准继箱',
      currentOrchardId: '',
      status: '待投放',
      lastCheckDate: `${year}-04-08`,
      healthNote: '群势良好，可补投油菜田'
    }
  ])

  await db.dropPoints.bulkPut([
    {
      id: 'dp_a01',
      orchardId: 'orc_ap',
      longitude: 107.4108,
      latitude: 34.6142,
      code: 'A-01',
      capacityBoxes: 8,
      shade: '北侧有防风林，午后半阴',
      waterDistance: 220,
      dropWindow: `${year}-04-07`,
      withdrawTime: `${year}-04-19`,
      owner: '周园主'
    },
    {
      id: 'dp_b01',
      orchardId: 'orc_rape',
      longitude: 107.4598,
      latitude: 34.6411,
      code: 'B-01',
      capacityBoxes: 12,
      shade: '无遮阴，需临时搭棚',
      waterDistance: 480,
      dropWindow: `${year}-03-27`,
      withdrawTime: `${year}-04-13`,
      owner: '合作社'
    },
    {
      id: 'dp_c01',
      orchardId: 'orc_cherry',
      longitude: 107.3741,
      latitude: 34.5902,
      code: 'C-01',
      capacityBoxes: 6,
      shade: '坡顶两株核桃树遮阴',
      waterDistance: 350,
      dropWindow: `${year}-04-11`,
      withdrawTime: `${year}-04-22`,
      owner: '李园主'
    }
  ])

  await db.deployments.bulkPut([
    { id: 'dep_d1', colonyId: 'col_001', dropPointId: 'dp_a01', orchardId: 'orc_ap', status: '已投放', queuedAt: 1 },
    { id: 'dep_d2', colonyId: 'col_002', dropPointId: 'dp_c01', orchardId: 'orc_cherry', status: '已投放', queuedAt: 1 },
    { id: 'dep_d3', colonyId: 'col_003', dropPointId: 'dp_c01', orchardId: 'orc_cherry', status: '已投放', queuedAt: 2 },
    // C-01 容量 6 箱，目前只用了 2 箱；Q-04 在待投放池可继续排
  ])

  await db.withdrawals.put({
    id: 'wd_ap',
    orchardId: 'orc_ap',
    withdrawAt: `${year}-04-19T07:00`,
    vehicleType: '厢式货车',
    note: '验收达标后按时撤场，顺路转运下个果园',
    status: '待执行',
    basisBloomStart: `${year}-04-08`,
    basisBloomEnd: `${year}-04-18`,
    basisCapacityDigest: 'A-01:8',
    executedAt: ''
  })

  await db.routes.bulkPut([
    {
      id: 'rt_001',
      fromDropId: 'dp_b01',
      toDropId: 'dp_c01',
      distanceKm: 9.4,
      durationH: 0.54,
      vehicleType: '农用三轮',
      departAt: `${year}-04-13T06:30`,
      riskNote: '西沟坡道窄，雨天泥泞，需小车倒运',
      actualNote: '待执行'
    }
  ])
}
