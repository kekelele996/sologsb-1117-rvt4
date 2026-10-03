import { create } from 'zustand'
import type { Orchard, VehicleType, WithdrawalPlan } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { uid } from '@/utils/id'
import { capacityDigest, isPlanStale, suggestWithdrawAt } from '@/utils/schedule'
import { deploymentStore } from '@/stores/deploymentStore'

export interface WithdrawalState {
  rows: WithdrawalPlan[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: WithdrawalPlan) => Promise<void>
  remove: (id: string) => Promise<void>
  /** 技术员为地块生成撤场安排：按当前花期与容量固化依据快照 */
  createForOrchard: (
    orchardId: string,
    meta?: { withdrawAt?: string; vehicleType?: VehicleType; note?: string }
  ) => Promise<WithdrawalPlan>
  /** 托管队改过花期或容量后，撤场安排按最新数据失效重算 */
  regenerate: (planId: string) => Promise<void>
  /** 执行撤场：地块上所有蜂群回场，安排标记为已撤场 */
  execute: (planId: string) => Promise<void>
}

export const withdrawalStore = create<WithdrawalState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<WithdrawalPlan>(db.withdrawals)
    rows.sort((a, b) => a.withdrawAt.localeCompare(b.withdrawAt))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    await putRow<WithdrawalPlan>(db.withdrawals, row)
    await get().hydrate()
  },
  remove: async (id) => {
    await deleteRow<WithdrawalPlan>(db.withdrawals, id)
    await get().hydrate()
  },
  createForOrchard: async (orchardId, meta) => {
    const orchard = await db.orchards.get(orchardId)
    if (!orchard) throw new Error('地块不存在')
    const points = (await loadAll(db.dropPoints)).filter((item) => item.orchardId === orchardId)
    const row: WithdrawalPlan = {
      id: uid('wd'),
      orchardId,
      withdrawAt: meta?.withdrawAt || suggestWithdrawAt(orchard),
      vehicleType: meta?.vehicleType ?? '厢式货车',
      note: meta?.note ?? '',
      status: '待执行',
      basisBloomStart: orchard.bloomStart,
      basisBloomEnd: orchard.bloomEnd,
      basisCapacityDigest: capacityDigest(points),
      executedAt: ''
    }
    await putRow<WithdrawalPlan>(db.withdrawals, row)
    await get().hydrate()
    return row
  },
  regenerate: async (planId) => {
    const plan = get().rows.find((item) => item.id === planId)
    if (!plan) return
    const orchard = await db.orchards.get(plan.orchardId)
    if (!orchard) throw new Error('地块不存在')
    const points = (await loadAll(db.dropPoints)).filter((item) => item.orchardId === plan.orchardId)
    await putRow<WithdrawalPlan>(db.withdrawals, {
      ...plan,
      withdrawAt: suggestWithdrawAt(orchard),
      status: '待执行',
      basisBloomStart: orchard.bloomStart,
      basisBloomEnd: orchard.bloomEnd,
      basisCapacityDigest: capacityDigest(points),
      executedAt: ''
    })
    await get().hydrate()
  },
  execute: async (planId) => {
    const plan = get().rows.find((item) => item.id === planId)
    if (!plan) return
    const orchard = await db.orchards.get(plan.orchardId)
    const points = orchard
      ? (await loadAll(db.dropPoints)).filter((item) => item.orchardId === plan.orchardId)
      : []
    if (orchard && isPlanStale(plan, orchard, points)) {
      throw new Error('撤场安排已因花期或容量调整失效，请先重算再执行')
    }
    await deploymentStore.getState().withdrawOrchard(plan.orchardId)
    await putRow<WithdrawalPlan>(db.withdrawals, {
      ...plan,
      status: '已撤场',
      executedAt: new Date().toISOString()
    })
    await get().hydrate()
  }
}))

/** 供页面判断某地块撤场安排是否失效 */
export function planStaleFor(plan: WithdrawalPlan, orchards: Orchard[], points: { orchardId: string; code: string; capacityBoxes: number }[]): boolean {
  const orchard = orchards.find((item) => item.id === plan.orchardId)
  if (!orchard) return true
  return isPlanStale(plan, orchard, points.filter((item) => item.orchardId === plan.orchardId))
}
