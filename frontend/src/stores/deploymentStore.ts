import { create } from 'zustand'
import type { BeeColony, Deployment } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { uid } from '@/utils/id'

export interface DeploymentState {
  rows: Deployment[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 技术员把一群蜂排到投放点：箱位未满即已投放，装不下则排队 */
  assignToPoint: (colonyId: string, dropPointId: string) => Promise<void>
  /** 撤下投放（已投放撤下后同队排头自动补位） */
  cancel: (deploymentId: string) => Promise<void>
  /** 排队中群前移一位 */
  moveEarlier: (deploymentId: string) => Promise<void>
  /** 排队中群后移一位 */
  moveLater: (deploymentId: string) => Promise<void>
  /** 验收不达标：退回该地块所有群为待投放，安排清空 */
  releaseByOrchard: (orchardId: string) => Promise<void>
  /** 删除投放点：点上安排整体退回 */
  releaseByDropPoint: (dropPointId: string) => Promise<void>
  /** 投放点容量被调整后按新容量重算落箱/排队（容量缩小时多出的群回到排队） */
  resyncPoint: (dropPointId: string) => Promise<void>
  /** 撤场执行：地块上所有群回场，安排清空 */
  withdrawOrchard: (orchardId: string) => Promise<void>
}

/** 该投放点下一个排队序号 */
function nextQueuedAt(rows: Deployment[], dropPointId: string): number {
  const values = rows.filter((item) => item.dropPointId === dropPointId).map((item) => item.queuedAt)
  return values.length > 0 ? Math.max(...values) + 1 : 1
}

/**
 * 按投放点容量重算状态：queuedAt 靠前的优先占用箱位（已投放保留、排队中补位），
 * 被顶下的群回到排队；蜂群状态随结果同步（已投放→在园，排队中/退回→待投放）。
 */
async function reconcilePoint(rows: Deployment[], dropPointId: string, capacity: number): Promise<Deployment[]> {
  const samePoint = rows
    .filter((item) => item.dropPointId === dropPointId)
    .sort((a, b) => a.queuedAt - b.queuedAt)
  let placed = 0
  const settled = new Map<string, Deployment>()
  for (const dep of samePoint) {
    const status = placed < capacity ? '已投放' : '排队中'
    if (status === '已投放') placed += 1
    settled.set(dep.id, { ...dep, status })
  }
  const others = rows.filter((item) => item.dropPointId !== dropPointId)
  const next = [...others, ...settled.values()]

  const colonies = await loadAll<BeeColony>(db.colonies)
  const colonyMap = new Map(colonies.map((item) => [item.id, item]))
  const colonyStatusById = new Map<string, BeeColony['status']>()
  const colonyOrchardById = new Map<string, string>()
  // 先按其他点的安排决定每群归属（每群至多一条有效安排，迁移数据多条时取首个已投放）
  for (const dep of others) {
    if (dep.status === '已投放' && !colonyStatusById.has(dep.colonyId)) {
      colonyStatusById.set(dep.colonyId, '在园')
      colonyOrchardById.set(dep.colonyId, dep.orchardId)
    }
  }
  for (const dep of settled.values()) {
    if (dep.status === '已投放' && !colonyStatusById.has(dep.colonyId)) {
      colonyStatusById.set(dep.colonyId, '在园')
      colonyOrchardById.set(dep.colonyId, dep.orchardId)
    }
  }
  await Promise.all(
    Array.from(settled.values()).map(async (dep) => {
      await putRow<Deployment>(db.deployments, dep)
      const colony = colonyMap.get(dep.colonyId)
      if (!colony) return
      const status = colonyStatusById.get(dep.colonyId) ?? '待投放'
      const orchardId = colonyOrchardById.get(dep.colonyId) ?? ''
      await putRow<BeeColony>(db.colonies, { ...colony, status, currentOrchardId: orchardId })
    })
  )
  return next
}

export const deploymentStore = create<DeploymentState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<Deployment>(db.deployments)
    rows.sort((a, b) => a.queuedAt - b.queuedAt)
    set({ rows, loaded: true })
  },
  assignToPoint: async (colonyId, dropPointId) => {
    const rows = get().rows
    const colony = (await loadAll<BeeColony>(db.colonies)).find((item) => item.id === colonyId)
    if (!colony) throw new Error('蜂群不存在')
    if (colony.status === '在园' || colony.status === '转场中') {
      throw new Error(`蜂群 ${colony.code} 当前为「${colony.status}」，不能再排入投放点`)
    }
    if (rows.some((item) => item.colonyId === colonyId)) {
      throw new Error(`蜂群 ${colony.code} 已在投放安排中，请先撤下原安排`)
    }
    const point = (await loadAll<{ id: string; capacityBoxes: number }>(db.dropPoints)).find((item) => item.id === dropPointId)
    if (!point) throw new Error('投放点不存在')
    const dep: Deployment = {
      id: uid('dep'),
      colonyId,
      dropPointId,
      orchardId: (await db.dropPoints.get(dropPointId))?.orchardId ?? '',
      status: '排队中',
      queuedAt: nextQueuedAt(rows, dropPointId)
    }
    await putRow<Deployment>(db.deployments, dep)
    await reconcilePoint([...rows, dep], dropPointId, point.capacityBoxes)
    await get().hydrate()
  },
  cancel: async (deploymentId) => {
    const dep = get().rows.find((item) => item.id === deploymentId)
    if (!dep) return
    const point = await db.dropPoints.get(dep.dropPointId)
    await deleteRow<Deployment>(db.deployments, dep.id)
    // 蜂群回到待投放
    const colony = await db.colonies.get(dep.colonyId)
    if (colony) {
      await putRow<BeeColony>(db.colonies, { ...colony, status: '待投放', currentOrchardId: '' })
    }
    if (point) {
      const remain = get().rows.filter((item) => item.id !== dep.id)
      await reconcilePoint(remain, dep.dropPointId, point.capacityBoxes)
    }
    await get().hydrate()
  },
  moveEarlier: async (deploymentId) => {
    const rows = get().rows
    const dep = rows.find((item) => item.id === deploymentId)
    if (!dep || dep.status !== '排队中') return
    const queue = rows
      .filter((item) => item.dropPointId === dep.dropPointId && item.status === '排队中')
      .sort((a, b) => a.queuedAt - b.queuedAt)
    const index = queue.findIndex((item) => item.id === dep.id)
    if (index <= 0) return
    const prev = queue[index - 1]
    const depSeq = dep.queuedAt
    await putRow<Deployment>(db.deployments, { ...dep, queuedAt: prev.queuedAt })
    await putRow<Deployment>(db.deployments, { ...prev, queuedAt: depSeq })
    const point = await db.dropPoints.get(dep.dropPointId)
    if (point) {
      await reconcilePoint(await loadAll<Deployment>(db.deployments), dep.dropPointId, point.capacityBoxes)
    }
    await get().hydrate()
  },
  moveLater: async (deploymentId) => {
    const rows = get().rows
    const dep = rows.find((item) => item.id === deploymentId)
    if (!dep || dep.status !== '排队中') return
    const queue = rows
      .filter((item) => item.dropPointId === dep.dropPointId && item.status === '排队中')
      .sort((a, b) => a.queuedAt - b.queuedAt)
    const index = queue.findIndex((item) => item.id === dep.id)
    if (index < 0 || index >= queue.length - 1) return
    const nextDep = queue[index + 1]
    const depSeq = dep.queuedAt
    await putRow<Deployment>(db.deployments, { ...dep, queuedAt: nextDep.queuedAt })
    await putRow<Deployment>(db.deployments, { ...nextDep, queuedAt: depSeq })
    const point = await db.dropPoints.get(dep.dropPointId)
    if (point) {
      await reconcilePoint(await loadAll<Deployment>(db.deployments), dep.dropPointId, point.capacityBoxes)
    }
    await get().hydrate()
  },
  releaseByOrchard: async (orchardId) => {
    const rows = get().rows
    const targets = rows.filter((item) => item.orchardId === orchardId)
    const colonyIds = Array.from(new Set(targets.map((item) => item.colonyId)))
    const colonies = await loadAll<BeeColony>(db.colonies)
    await Promise.all(
      targets.map((item) => deleteRow<Deployment>(db.deployments, item.id))
    )
    await Promise.all(
      colonyIds.map(async (id) => {
        const colony = colonies.find((item) => item.id === id)
        if (!colony) return
        await putRow<BeeColony>(db.colonies, { ...colony, status: '待投放', currentOrchardId: '' })
      })
    )
    await get().hydrate()
  },
  releaseByDropPoint: async (dropPointId) => {
    const rows = get().rows
    const targets = rows.filter((item) => item.dropPointId === dropPointId)
    const colonyIds = Array.from(new Set(targets.map((item) => item.colonyId)))
    const colonies = await loadAll<BeeColony>(db.colonies)
    await Promise.all(targets.map((item) => deleteRow<Deployment>(db.deployments, item.id)))
    await Promise.all(
      colonyIds.map(async (id) => {
        const colony = colonies.find((item) => item.id === id)
        if (!colony) return
        await putRow<BeeColony>(db.colonies, { ...colony, status: '待投放', currentOrchardId: '' })
      })
    )
    await get().hydrate()
  },
  resyncPoint: async (dropPointId) => {
    const point = await db.dropPoints.get(dropPointId)
    if (!point) return
    await reconcilePoint(await loadAll<Deployment>(db.deployments), dropPointId, point.capacityBoxes)
    await get().hydrate()
  },
  withdrawOrchard: async (orchardId) => {
    const rows = get().rows
    const targets = rows.filter((item) => item.orchardId === orchardId)
    const colonyIds = Array.from(new Set(targets.map((item) => item.colonyId)))
    const colonies = await loadAll<BeeColony>(db.colonies)
    await Promise.all(targets.map((item) => deleteRow<Deployment>(db.deployments, item.id)))
    await Promise.all(
      colonyIds.map(async (id) => {
        const colony = colonies.find((item) => item.id === id)
        if (!colony) return
        await putRow<BeeColony>(db.colonies, { ...colony, status: '回场', currentOrchardId: '' })
      })
    )
    await get().hydrate()
  }
}))
