import { create } from 'zustand'
import type { DropPoint } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { invalidateWithdrawPlan } from '@/services/withdrawPlan'
import { reconcilePointForCapacity } from '@/services/placement'
import { colonyStore } from './colonyStore'

export interface DropPointState {
  rows: DropPoint[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: DropPoint) => Promise<{ rebalanced: number }>
  remove: (id: string) => Promise<void>
  removeByOrchard: (orchardId: string) => Promise<void>
}

export const droppointStore = create<DropPointState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<DropPoint>(db.dropPoints)
    rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    const prev = await db.dropPoints.get(row.id)

    // 托管队改过容量 → 技术员的撤场安排失效，需重算；并按新容量再平衡在点/排队队列
    let rebalanced = 0
    let balanced: DropPoint | null = null
    if (prev && prev.capacityBoxes !== row.capacityBoxes) {
      await invalidateWithdrawPlan()
      const result = await reconcilePointForCapacity(row)
      rebalanced = result.changed
      balanced = result.point
    }

    // 容量变化时，再平衡已在事务内写入平衡后的队列；其余字段用传入行兜底
    await putRow<DropPoint>(db.dropPoints, balanced ?? row)
    await Promise.all([get().hydrate(), colonyStore.getState().hydrate()])
    return { rebalanced }
  },  remove: async (id) => {
    await deleteRow<DropPoint>(db.dropPoints, id)
    // 投放点被删，撤场输入变化，安排失效
    await invalidateWithdrawPlan()
    await get().hydrate()
  },
  removeByOrchard: async (orchardId) => {
    const targets = get().rows.filter((row) => row.orchardId === orchardId)
    await Promise.all(targets.map((row) => deleteRow<DropPoint>(db.dropPoints, row.id)))
    if (targets.length > 0) {
      await invalidateWithdrawPlan()
    }
    await get().hydrate()
  }
}))
