import { create } from 'zustand'
import type { DropPoint, Orchard, TransitRoute } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { distanceKm, estimateDurationH } from '@/utils/geo'
import { stampWithdrawPlan } from '@/services/withdrawPlan'

export interface WithdrawPlanSummary {
  /** 纳入撤场计划的投放点数 */
  included: number
  /** 因地块未验收达标而跳过的投放点数 */
  skipped: number
  /** 生成的转场段数 */
  legs: number
  generatedAt: string
}

export interface RouteState {
  rows: TransitRoute[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: TransitRoute) => Promise<void>
  remove: (id: string) => Promise<void>
  /** 按选点顺序重排并重算里程 / 耗时，生成连续转场段（技术员手工规划，同样校验当前输入） */
  rebuildFromOrder: (
    orderedDropIds: string[],
    meta: { vehicleType: TransitRoute['vehicleType']; departAt: string; riskNote: string }
  ) => Promise<void>
  /**
   * 重算撤场安排：按撤场时间先后，把「达标」地块上仍有在点蜂群的投放点串成转场路线；
   * 未达标 / 待验收地块的投放点不纳入（不能撤早，等验收与补投）。
   * 生成后写入当前花期/容量输入指纹，标记安排有效。
   */
  rebuildWithdrawPlan: () => Promise<WithdrawPlanSummary>
}

async function writeLegs(
  ordered: DropPoint[],
  meta: { vehicleType: TransitRoute['vehicleType']; departAt: string; riskNote: string; actualNote: string }
): Promise<number> {
  const existing = await loadAll<TransitRoute>(db.routes)
  await Promise.all(existing.map((row) => deleteRow<TransitRoute>(db.routes, row.id)))
  let legs = 0
  for (let i = 1; i < ordered.length; i += 1) {
    const from = ordered[i - 1]
    const to = ordered[i]
    const km = distanceKm(from, to)
    await putRow<TransitRoute>(db.routes, {
      id: `rt_${Date.now().toString(36)}_${i}`,
      fromDropId: from.id,
      toDropId: to.id,
      distanceKm: km,
      durationH: estimateDurationH(km),
      vehicleType: meta.vehicleType,
      departAt: meta.departAt,
      riskNote: meta.riskNote,
      actualNote: meta.actualNote
    })
    legs += 1
  }
  return legs
}

export const routeStore = create<RouteState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<TransitRoute>(db.routes)
    rows.sort((a, b) => a.departAt.localeCompare(b.departAt))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    await putRow<TransitRoute>(db.routes, row)
    await get().hydrate()
  },
  remove: async (id) => {
    await deleteRow<TransitRoute>(db.routes, id)
    await get().hydrate()
  },
  rebuildFromOrder: async (orderedDropIds, meta) => {
    const points = await loadAll<DropPoint>(db.dropPoints)
    const lookup = new Map(points.map((item) => [item.id, item]))
    const ordered = orderedDropIds
      .map((id) => lookup.get(id))
      .filter((item): item is DropPoint => Boolean(item))
    await writeLegs(ordered, { ...meta, actualNote: '待执行' })
    await stampWithdrawPlan()
    await get().hydrate()
  },
  rebuildWithdrawPlan: async () => {
    const [orchards, points] = await Promise.all([
      loadAll<Orchard>(db.orchards),
      loadAll<DropPoint>(db.dropPoints)
    ])
    const accepted = new Map(
      orchards.filter((item) => item.acceptance === '达标').map((item) => [item.id, item])
    )
    const eligible = points.filter(
      (item) => accepted.has(item.orchardId) && item.colonyCodes.length > 0
    )
    const skipped = points.filter((item) => !accepted.has(item.orchardId)).length
    eligible.sort((a, b) => a.withdrawTime.localeCompare(b.withdrawTime) || a.code.localeCompare(b.code))

    // 每段出发时刻取前一投放点撤场日的清晨 06:30
    const departAtFor = (index: number): string =>
      `${eligible[index - 1]?.withdrawTime ?? ''}T06:30`
    const ordered = eligible
    const existing = await loadAll<TransitRoute>(db.routes)
    await Promise.all(existing.map((row) => deleteRow<TransitRoute>(db.routes, row.id)))
    let legs = 0
    for (let i = 1; i < ordered.length; i += 1) {
      const from = ordered[i - 1]
      const to = ordered[i]
      const km = distanceKm(from, to)
      await putRow<TransitRoute>(db.routes, {
        id: `rt_wd_${Date.now().toString(36)}_${i}`,
        fromDropId: from.id,
        toDropId: to.id,
        distanceKm: km,
        durationH: estimateDurationH(km),
        vehicleType: '厢式货车',
        departAt: departAtFor(i),
        riskNote: '撤场安排按验收达标地块的撤场时间自动排序',
        actualNote: '待执行'
      })
      legs += 1
    }
    const generatedAt = new Date().toISOString()
    await stampWithdrawPlan(generatedAt)
    await get().hydrate()
    return { included: eligible.length, skipped, legs, generatedAt }
  }
}))
