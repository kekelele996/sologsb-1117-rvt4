import { create } from 'zustand'
import type { DropPoint } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { deploymentStore } from '@/stores/deploymentStore'

export interface DropPointState {
  rows: DropPoint[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (row: DropPoint) => Promise<void>
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
    await putRow<DropPoint>(db.dropPoints, row)
    await get().hydrate()
  },
  remove: async (id) => {
    // 删除投放点前，先把点上的蜂群退回待投放（容量变化后技术员重新排布）
    await deploymentStore.getState().releaseByDropPoint(id)
    await deleteRow<DropPoint>(db.dropPoints, id)
    await get().hydrate()
  },
  removeByOrchard: async (orchardId) => {
    const targets = get().rows.filter((row) => row.orchardId === orchardId)
    await Promise.all(targets.map((row) => deploymentStore.getState().releaseByDropPoint(row.id)))
    await Promise.all(targets.map((row) => deleteRow<DropPoint>(db.dropPoints, row.id)))
    await get().hydrate()
  }
}))
