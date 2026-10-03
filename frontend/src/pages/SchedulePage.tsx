import { useMemo, useState } from 'react'
import { Alert, Card, Col, Row, Segmented, Space, Table, Tag, Typography } from 'antd'
import type { Acceptance, BeeColony, Deployment, DropPoint, Orchard } from '@/types'
import FlowerWindowBar from '@/components/common/FlowerWindowBar'
import RouteMap from '@/components/common/RouteMap'
import StatusTag from '@/components/common/StatusTag'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { deploymentStore } from '@/stores/deploymentStore'
import { routeStore } from '@/stores/routeStore'
import { bloomDays, flowerWindowOverlap } from '@/utils/geo'
import { suggestColonyBoxes } from '@/types'

interface Placement {
  colonyCode: string
  orchardId: string
  dropCode: string
  start: string
  end: string
}

interface ConflictItem {
  colonyCode: string
  a: Placement
  b: Placement
  days: number
  range: string
}

interface ScheduleRow {
  key: string
  orchard: Orchard
  days: number
  suggest: number
  placedCodes: string[]
  queuedCodes: string[]
  dropCodes: string[]
  conflicted: boolean
}

const ACCEPTANCE_COLOR: Record<Acceptance, string> = {
  待验收: 'gold',
  达标: 'green',
  不达标: 'red'
}

/** 季内授粉安排总表：日期条带展示花期与已投放群体，冲突处标红 */
export default function SchedulePage(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const deployments = usePersistentStore(deploymentStore, (state) => state.rows)
  const routes = usePersistentStore(routeStore, (state) => state.rows)
  const [scope, setScope] = useState<'all' | 'conflict'>('all')

  const colonyById = useMemo(() => new Map(colonies.map((item) => [item.id, item])), [colonies])
  const pointById = useMemo(() => new Map(dropPoints.map((item) => [item.id, item])), [dropPoints])

  /** 由技术员的投放安排汇总「某群在某地块」的时间占用（排队中不计入占用） */
  const placements = useMemo<Placement[]>(() => {
    const list: Placement[] = []
    deployments.forEach((dep: Deployment) => {
      if (dep.status !== '已投放') return
      const point = pointById.get(dep.dropPointId)
      const colony = colonyById.get(dep.colonyId)
      if (!point || !colony) return
      list.push({
        colonyCode: colony.code,
        orchardId: dep.orchardId,
        dropCode: point.code,
        start: point.dropWindow,
        end: point.withdrawTime
      })
    })
    // 兼容蜂群台账中直接登记了所在地块、但尚未建立投放安排的情况
    colonies.forEach((colony: BeeColony) => {
      if (!colony.currentOrchardId || colony.status !== '在园') return
      const orchard = orchards.find((item) => item.id === colony.currentOrchardId)
      if (!orchard) return
      const already = list.some((item) => item.colonyCode === colony.code && item.orchardId === colony.currentOrchardId)
      if (already) return
      list.push({
        colonyCode: colony.code,
        orchardId: colony.currentOrchardId,
        dropCode: '（当前所在）',
        start: orchard.bloomStart,
        end: orchard.bloomEnd
      })
    })
    return list
  }, [deployments, colonies, orchards, pointById, colonyById])

  /** 同一蜂群同一天被排入两个地块 → 冲突列表 */
  const conflicts = useMemo<ConflictItem[]>(() => {
    const result: ConflictItem[] = []
    const codes = Array.from(new Set(placements.map((item) => item.colonyCode)))
    codes.forEach((code) => {
      const list = placements.filter((item) => item.colonyCode === code)
      for (let i = 0; i < list.length; i += 1) {
        for (let j = i + 1; j < list.length; j += 1) {
          if (list[i].orchardId === list[j].orchardId) continue
          const overlap = flowerWindowOverlap(list[i].start, list[i].end, list[j].start, list[j].end)
          if (overlap.overlap) {
            result.push({ colonyCode: code, a: list[i], b: list[j], days: overlap.days, range: overlap.range })
          }
        }
      }
    })
    return result
  }, [placements])

  const rows = useMemo<ScheduleRow[]>(
    () =>
      orchards.map((orchard) => {
        const related = placements.filter((item) => item.orchardId === orchard.id)
        const pointIds = new Set(dropPoints.filter((item: DropPoint) => item.orchardId === orchard.id).map((item) => item.id))
        const queued = deployments
          .filter((dep) => pointIds.has(dep.dropPointId) && dep.status === '排队中')
          .map((dep) => colonyById.get(dep.colonyId)?.code)
          .filter((code): code is string => Boolean(code))
        return {
          key: orchard.id,
          orchard,
          days: bloomDays(orchard),
          suggest: suggestColonyBoxes(orchard),
          placedCodes: Array.from(new Set(related.map((item) => item.colonyCode))),
          queuedCodes: Array.from(new Set(queued)),
          dropCodes: Array.from(new Set(related.map((item) => item.dropCode))),
          conflicted: conflicts.some((item) => item.a.orchardId === orchard.id || item.b.orchardId === orchard.id)
        }
      }),
    [orchards, placements, conflicts, dropPoints, deployments, colonyById]
  )

  const visibleRows = scope === 'conflict' ? rows.filter((row) => row.conflicted) : rows
  const totalSuggest = rows.reduce((sum, row) => sum + row.suggest, 0)
  const pendingAcceptance = rows.filter((row) => row.orchard.acceptance === '待验收').length
  const failedAcceptance = rows.filter((row) => row.orchard.acceptance === '不达标').length
  const totalQueued = rows.reduce((sum, row) => sum + row.queuedCodes.length, 0)

  function orchardName(id: string): string {
    return orchards.find((item) => item.id === id)?.name ?? '未知地块'
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">季内授粉安排总表</h2>
          <p className="page-sub">
            按日期条带展示各地块盛花期与已投放群体；容量装满后的排队群与季末验收结论一并汇总，供托管队与技术员各自核对。
          </p>
        </div>
        <Segmented
          value={scope}
          onChange={(value) => setScope(value as 'all' | 'conflict')}
          options={[
            { label: `全部地块（${rows.length}）`, value: 'all' },
            { label: `仅冲突地块（${rows.filter((row) => row.conflicted).length}）`, value: 'conflict' }
          ]}
        />
      </div>

      {conflicts.length > 0 ? (
        <Alert
          type="error"
          showIcon
          message={`发现 ${conflicts.length} 处蜂群排程冲突：同一群体被排入花期重叠的不同地块`}
          description={
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {conflicts.map((item) => (
                <li key={`${item.colonyCode}-${item.a.dropCode}-${item.b.dropCode}`}>
                  蜂群 <b>{item.colonyCode}</b>：{orchardName(item.a.orchardId)}（{item.a.dropCode} {item.a.start}~{item.a.end}）与{' '}
                  {orchardName(item.b.orchardId)}（{item.b.dropCode} {item.b.start}~{item.b.end}）重叠 {item.days} 天（{item.range}）
                </li>
              ))}
            </ul>
          }
        />
      ) : (
        <Alert
          type="success"
          showIcon
          message={`当前排程无蜂群冲突；另有 ${totalQueued} 群在排队等箱位，${pendingAcceptance} 个地块待验收${failedAcceptance > 0 ? `，${failedAcceptance} 个地块验收不达标待补投` : ''}`}
        />
      )}

      <Row gutter={16}>
        <Col xs={24} xl={14}>
          <Card size="small" title="花期条带与已投放群体" styles={{ body: { display: 'flex', flexDirection: 'column', gap: 12 } }}>
            {visibleRows.map((row) => (
              <div key={row.key} className={row.conflicted ? 'conflict-row' : ''} style={{ padding: 8, borderRadius: 8 }}>
                <FlowerWindowBar orchard={row.orchard} others={orchards.filter((item) => item.id !== row.orchard.id)} width={420} />
                <Space wrap size={4} style={{ marginTop: 6 }}>
                  <Tag>建议 {row.suggest} 箱</Tag>
                  <Tag color="blue">花期 {row.days} 天</Tag>
                  <Tag color={row.orchard.accessibility === '大车可达' ? 'green' : row.orchard.accessibility === '仅小车' ? 'gold' : 'red'}>
                    {row.orchard.accessibility}
                  </Tag>
                  <Tag color={ACCEPTANCE_COLOR[row.orchard.acceptance]}>验收：{row.orchard.acceptance}</Tag>
                  {row.placedCodes.length > 0 ? (
                    row.placedCodes.map((code) => <Tag key={code} color="cyan">已投放 {code}</Tag>)
                  ) : (
                    <Tag>尚未安排群体</Tag>
                  )}
                  {row.queuedCodes.length > 0 ? (
                    row.queuedCodes.map((code) => <Tag key={`q-${code}`} color="orange">排队 {code}</Tag>)
                  ) : null}
                  {row.conflicted ? <Tag color="red">存在冲突</Tag> : null}
                </Space>
              </div>
            ))}
            {visibleRows.length === 0 ? <Typography.Text type="secondary">没有符合条件的地块</Typography.Text> : null}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card size="small" title="地图总览（地块 / 投放点 / 转场折线）">
            <RouteMap orchards={orchards} dropPoints={dropPoints} routes={routes} height={360} title="季内投放分布" />
          </Card>
        </Col>
      </Row>

      <Card size="small" title={`各地块排程明细（建议箱数合计 ${totalSuggest} 箱）`}>
        <Table<ScheduleRow>
          dataSource={rows}
          rowKey="key"
          pagination={false}
          rowClassName={(record) => (record.conflicted ? 'conflict-row' : '')}
          columns={[
            { title: '地块', dataIndex: ['orchard', 'name'], key: 'name' },
            { title: '作物', dataIndex: ['orchard', 'crop'], key: 'crop', width: 90 },
            {
              title: '盛花期',
              key: 'bloom',
              render: (_, record: ScheduleRow) => `${record.orchard.bloomStart} ~ ${record.orchard.bloomEnd}`
            },
            { title: '建议箱数', dataIndex: 'suggest', key: 'suggest', width: 90 },
            {
              title: '验收结论',
              key: 'acceptance',
              width: 100,
              render: (_, record: ScheduleRow) => <Tag color={ACCEPTANCE_COLOR[record.orchard.acceptance]}>{record.orchard.acceptance}</Tag>
            },
            {
              title: '投放点',
              key: 'drops',
              render: (_, record: ScheduleRow) => (record.dropCodes.length > 0 ? record.dropCodes.join('、') : '—')
            },
            {
              title: '已投放群体',
              key: 'colonies',
              render: (_, record: ScheduleRow) => (
                <Space wrap size={4}>
                  {record.placedCodes.length > 0 ? record.placedCodes.map((code) => <Tag key={code} color="cyan">{code}</Tag>) : <span>—</span>}
                </Space>
              )
            },
            {
              title: '排队中',
              key: 'queued',
              width: 110,
              render: (_, record: ScheduleRow) =>
                record.queuedCodes.length > 0 ? (
                  <Space wrap size={4}>{record.queuedCodes.map((code) => <Tag key={code} color="orange">{code}</Tag>)}</Space>
                ) : (
                  '—'
                )
            },
            {
              title: '状态',
              key: 'status',
              width: 120,
              render: (_, record: ScheduleRow) =>
                record.conflicted ? <Tag color="red">冲突</Tag> : <Tag color="green">正常</Tag>
            }
          ]}
        />
      </Card>

      <Card size="small" title="蜂群当前状态">
        <Space wrap>
          {colonies.map((colony) => (
            <StatusTag
              key={colony.id}
              status={colony.status}
              hint={colony.currentOrchardId ? orchardName(colony.currentOrchardId) : '未分配地块'}
            />
          ))}
        </Space>
      </Card>
    </div>
  )
}
