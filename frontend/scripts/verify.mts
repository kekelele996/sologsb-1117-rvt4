import 'fake-indexeddb/auto'
import Dexie from 'dexie'

// 1) 先建一个 v2 结构的旧库，写入旧数据（无 acceptance、投放点带 colonyCodes）
const legacy = new Dexie('gbbeeroute')
legacy.version(1).stores({
  orchards: 'id, name, crop',
  colonies: 'id, code, status',
  dropPoints: 'id, orchardId, code',
  routes: 'id, fromDropId, toDropId',
  meta: 'key'
})
legacy.version(2).stores({
  orchards: 'id, name, crop, bloomStart',
  colonies: 'id, code, status, currentOrchardId',
  dropPoints: 'id, orchardId, code, dropWindow',
  routes: 'id, fromDropId, toDropId, departAt',
  meta: 'key'
})

await legacy.table('orchards').bulkPut([
  {
    id: 'orc_1', name: '旧苹果园', crop: '苹果', areaMu: 100, longitude: 107, latitude: 34,
    bloomStart: '2026-04-08', bloomEnd: '2026-04-18', colonyIntensity: 0.1,
    ownerContact: '', accessibility: '大车可达', historyYears: [], note: ''
    // 注意：没有 acceptance 字段
  }
])
await legacy.table('colonies').bulkPut([
  { id: 'c1', code: 'Q-01', species: '意蜂', strengthFrames: 8, boxType: '标准继箱', currentOrchardId: '', status: '待投放', lastCheckDate: '', healthNote: '' },
  { id: 'c2', code: 'Q-02', species: '意蜂', strengthFrames: 6, boxType: '标准继箱', currentOrchardId: '', status: '待投放', lastCheckDate: '', healthNote: '' },
  { id: 'c3', code: 'Q-03', species: '中蜂', strengthFrames: 4, boxType: '平箱', currentOrchardId: '', status: '待投放', lastCheckDate: '', healthNote: '' }
])
await legacy.table('dropPoints').bulkPut([
  // 容量 2，安排了 3 群 → 前 2 已投放、第 3 群应排队
  { id: 'dp1', orchardId: 'orc_1', longitude: 107, latitude: 34, code: 'A-01', capacityBoxes: 2, shade: '', waterDistance: 100, dropWindow: '2026-04-07', withdrawTime: '2026-04-19', owner: '', colonyCodes: ['Q-01', 'Q-02', 'Q-03'] }
])
await legacy.close()

// 2) 用应用的 schema 打开 → 触发 v3 迁移
const { db } = await import('../src/hooks/usePersistentStore.ts')

const orchards = await db.orchards.toArray()
const drops = await db.dropPoints.toArray()
const deps = await db.deployments.toArray()
const colonies = await db.colonies.toArray()

let failures = 0
function check(name, cond, extra = '') {
  if (cond) console.log(`PASS ${name}`)
  else { failures++; console.log(`FAIL ${name} ${extra}`) }
}

check('旧地块补「待验收」', orchards[0].acceptance === '待验收', `got ${orchards[0].acceptance}`)
check('投放点 colonyCodes 已移除', !('colonyCodes' in drops[0]))
check('迁移生成 3 条投放安排', deps.length === 3, `got ${deps.length}`)
const placed = deps.filter((d) => d.status === '已投放')
const queued = deps.filter((d) => d.status === '排队中')
check('按容量 2 群已投放', placed.length === 2, `got ${placed.length}`)
check('1 群排队', queued.length === 1 && queued[0].colonyId === 'c3', JSON.stringify(queued))
const c1 = colonies.find((c) => c.id === 'c1')
const c3 = colonies.find((c) => c.id === 'c3')
check('已投放在园且归属地块', c1.status === '在园' && c1.currentOrchardId === 'orc_1', JSON.stringify(c1))
check('排队群仍待投放无归属', c3.status === '待投放' && c3.currentOrchardId === '', JSON.stringify(c3))

// 3) 验证容量约束 + FIFO 补位（走真实 store）
const { deploymentStore: ds } = await import('../src/stores/deploymentStore.ts')
await ds.getState().hydrate()

// 撤下一个已投放 → c3 自动补位
const depC1 = deps.find((d) => d.colonyId === 'c1')
await ds.getState().cancel(depC1.id)
const after = await db.deployments.toArray()
const c3dep = after.find((d) => d.colonyId === 'c3')
check('撤下后排队排头自动补位为已投放', c3dep.status === '已投放', JSON.stringify(c3dep))
const c3col = await db.colonies.get('c3')
check('补位蜂群状态同步为在园', c3col.status === '在园' && c3col.currentOrchardId === 'orc_1', JSON.stringify(c3col))
const c1col = await db.colonies.get('c1')
check('撤下蜂群回到待投放', c1col.status === '待投放' && c1col.currentOrchardId === '', JSON.stringify(c1col))

// 再排 c1 回该点（容量 2，现有 c2、c3 已投放）→ 应排队
await ds.getState().assignToPoint('c1', 'dp1')
let again = await db.deployments.toArray()
const c1dep2 = again.find((d) => d.colonyId === 'c1')
check('箱位装满后新排入自动排队', c1dep2.status === '排队中', JSON.stringify(c1dep2))

// 在园群重复投放应被拒绝
let rejected = false
try { await ds.getState().assignToPoint('c2', 'dp1') } catch { rejected = true }
check('在园群拒绝重复投放', rejected)

// 前移/后移排队队列（只有一条排队，无操作）——改测：再排不了（c1 已排队），跳过
// 4) 验收不达标 → 退回补投 + 撤场安排作废
const { orchardStore: os } = await import('../src/stores/orchardStore.ts')
const { withdrawalStore: ws } = await import('../src/stores/withdrawalStore.ts')
await os.getState().hydrate()
await ws.getState().hydrate()
const plan = await ws.getState().createForOrchard('orc_1')
check('撤场安排生成且带快照', !!plan.id && plan.basisBloomStart === '2026-04-08' && plan.basisCapacityDigest === 'A-01:2', JSON.stringify(plan))
await os.getState().setAcceptance('orc_1', '不达标')
const depsAfterReject = await db.deployments.where('orchardId').equals('orc_1').toArray()
const plansAfterReject = await db.withdrawals.toArray()
check('不达标后投放安排清空', depsAfterReject.length === 0, `got ${depsAfterReject.length}`)
check('不达标后撤场安排作废', plansAfterReject.length === 0, `got ${plansAfterReject.length}`)
const c2after = await db.colonies.get('c2')
check('不达标后蜂群退回待投放', c2after.status === '待投放' && c2after.currentOrchardId === '', JSON.stringify(c2after))
const orcAfter = await db.orchards.get('orc_1')
check('地块验收结论为不达标', orcAfter.acceptance === '不达标')

// 5) 花期/容量改动 → 撤场安排失效重算
await os.getState().setAcceptance('orc_1', '达标')
await db.orchards.put({ ...orcAfter, acceptance: '达标' })
await ws.getState().createForOrchard('orc_1')
await os.getState().hydrate()
const storedOrchard = await db.orchards.get('orc_1')
await db.orchards.put({ ...storedOrchard, bloomEnd: '2026-04-20' })
await os.getState().hydrate()
await ws.getState().hydrate()
const plan2 = (await db.withdrawals.toArray())[0]
const { isPlanStale } = await import('../src/utils/schedule.ts')
const pointRows = await db.dropPoints.toArray()
const staleNow = isPlanStale(plan2, { bloomStart: '2026-04-08', bloomEnd: '2026-04-20' }, pointRows)
check('改花期后撤场判定失效', staleNow === true, JSON.stringify(plan2))
let executeBlocked = false
try { await ws.getState().execute(plan2.id) } catch { executeBlocked = true }
check('失效安排拒绝执行', executeBlocked)
await ws.getState().regenerate(plan2.id)
const plan3 = (await db.withdrawals.toArray())[0]
const staleAfter = isPlanStale(plan3, { bloomStart: '2026-04-08', bloomEnd: '2026-04-20' }, pointRows)
check('重算后不再失效且建议撤场时间更新', staleAfter === false && plan3.withdrawAt === '2026-04-21T07:00', JSON.stringify(plan3))

// 容量改动也应失效
await db.dropPoints.put({ ...pointRows[0], capacityBoxes: 5 })
const capStale = isPlanStale(plan3, { bloomStart: '2026-04-08', bloomEnd: '2026-04-20' }, [{ code: 'A-01', capacityBoxes: 5 }])
check('改容量后撤场判定失效', capStale === true)

console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
