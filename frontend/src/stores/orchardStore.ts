import { create } from 'zustand'
import type { Acceptance, Orchard } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { deploymentStore } from '@/stores/deploymentStore'
import type { WithdrawalPlan } from '@/types'

export interface OrchardState {
  rows: Orchard[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: Orchard) => Promise<void>
  remove: (id: string) => Promise<void>
  /** 托管队按坐果出验收结论；不达标则该地块蜂群退回待投放补投、撤场安排作废 */
  setAcceptance: (id: string, acceptance: Acceptance) => Promise<void>
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
    await putRow<Orchard>(db.orchards, row)
    await get().hydrate()
  },
  remove: async (id) => {
    await deleteRow<Orchard>(db.orchards, id)
    await get().hydrate()
  },
  setAcceptance: async (id, acceptance) => {
    const orchard = await db.orchards.get(id)
    if (!orchard) return
    await putRow<Orchard>(db.orchards, { ...orchard, acceptance })
    if (acceptance === '不达标') {
      // 验收不达标：地块上的群退回待投放，等待补投；撤场安排一并作废
      await deploymentStore.getState().releaseByOrchard(id)
      const plans = await loadAll<WithdrawalPlan>(db.withdrawals)
      await Promise.all(
        plans.filter((item) => item.orchardId === id).map((item) => deleteRow<WithdrawalPlan>(db.withdrawals, item.id))
      )
    }
    await get().hydrate()
  }
}))
