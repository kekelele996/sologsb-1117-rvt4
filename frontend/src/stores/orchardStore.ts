import { create } from 'zustand'
import type { Orchard } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { invalidateWithdrawPlan } from '@/services/withdrawPlan'
import { rejectOrchardPlacement } from '@/services/placement'
import { colonyStore } from './colonyStore'
import { droppointStore } from './droppointStore'
import { routeStore } from './routeStore'

export interface OrchardState {
  rows: Orchard[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: Orchard) => Promise<{ rejectedCodes: string[] }>
  remove: (id: string) => Promise<void>
}

export const orchardStore = create<OrchardState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<Orchard>(db.orchards)
    rows.sort((a, b) => a.bloomStart.localeCompare(b.bloomStart))
    set({ rows, loaded: true })
  },
  save: async (row) => {
    const prev = await db.orchards.get(row.id)

    // 托管队改过花期 → 技术员的撤场安排失效，需重算
    const bloomChanged =
      prev !== undefined && (prev.bloomStart !== row.bloomStart || prev.bloomEnd !== row.bloomEnd)
    if (bloomChanged) {
      await invalidateWithdrawPlan()
    }

    // 验收结论出具为「不达标」：在点群与排队群退回「待投放」补投
    let rejectedCodes: string[] = []
    if (row.acceptance === '不达标' && prev?.acceptance !== '不达标') {
      rejectedCodes = await rejectOrchardPlacement(row.id)
    }

    await putRow<Orchard>(db.orchards, row)
    await Promise.all([get().hydrate(), colonyStore.getState().hydrate(), droppointStore.getState().hydrate(), routeStore.getState().hydrate()])
    return { rejectedCodes }
  },
  remove: async (id) => {
    await deleteRow<Orchard>(db.orchards, id)
    // 地块被删，撤场输入变化，安排失效
    await invalidateWithdrawPlan()
    await get().hydrate()
  }
}))
