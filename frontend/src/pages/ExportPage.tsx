import { useMemo, useState } from 'react'
import { Button, Card, Col, Radio, Row, Space, Table, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import type { BeeColony, DropPoint, Orchard, TransitRoute, WithdrawalPlan } from '@/types'
import { suggestColonyBoxes } from '@/types'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { colonyStore } from '@/stores/colonyStore'
import { droppointStore } from '@/stores/droppointStore'
import { deploymentStore } from '@/stores/deploymentStore'
import { withdrawalStore } from '@/stores/withdrawalStore'
import { routeStore } from '@/stores/routeStore'
import { downloadCsv, downloadJson } from '@/utils/export'
import { bloomDays } from '@/utils/geo'
import { isPlanStale } from '@/utils/schedule'

interface ScheduleExportRow {
  orchard: string
  acceptance: string
  crop: string
  areaMu: number
  bloom: string
  days: number
  suggestBoxes: number
  dropCode: string
  colonyCode: string
  deployStatus: string
  dropWindow: string
  withdrawTime: string
  owner: string
}

/** 导出授粉安排清单与转场路线表，并提供打印视图 */
export default function ExportPage(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const colonies = usePersistentStore(colonyStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const deployments = usePersistentStore(deploymentStore, (state) => state.rows)
  const withdrawals = usePersistentStore(withdrawalStore, (state) => state.rows)
  const routes = usePersistentStore(routeStore, (state) => state.rows)
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('landscape')

  const orchardName = (id: string): string => orchards.find((item) => item.id === id)?.name ?? '未知地块'
  const colonyById = useMemo(() => new Map(colonies.map((item) => [item.id, item])), [colonies])
  const pointById = useMemo(() => new Map(dropPoints.map((item) => [item.id, item])), [dropPoints])

  /** 授粉安排清单：地块 × 投放点 × 投放/排队群号（数据源为技术员的投放安排） */
  const scheduleRows = useMemo<ScheduleExportRow[]>(() => {
    const rows: ScheduleExportRow[] = []
    orchards.forEach((orchard: Orchard) => {
      const points = dropPoints.filter((item) => item.orchardId === orchard.id)
      const base = {
        orchard: orchard.name,
        acceptance: orchard.acceptance,
        crop: orchard.crop,
        areaMu: orchard.areaMu,
        bloom: `${orchard.bloomStart} ~ ${orchard.bloomEnd}`,
        days: bloomDays(orchard),
        suggestBoxes: suggestColonyBoxes(orchard)
      }
      if (points.length === 0) {
        rows.push({ ...base, dropCode: '—', colonyCode: '—', deployStatus: '—', dropWindow: '—', withdrawTime: '—', owner: '—' })
        return
      }
      points.forEach((point: DropPoint) => {
        const deps = deployments
          .filter((item) => item.dropPointId === point.id)
          .sort((a, b) => a.queuedAt - b.queuedAt)
        if (deps.length === 0) {
          rows.push({
            ...base,
            dropCode: point.code,
            colonyCode: '待分配',
            deployStatus: '空箱位',
            dropWindow: point.dropWindow,
            withdrawTime: point.withdrawTime,
            owner: point.owner || '—'
          })
          return
        }
        deps.forEach((dep) => {
          rows.push({
            ...base,
            dropCode: point.code,
            colonyCode: colonyById.get(dep.colonyId)?.code ?? '?',
            deployStatus: dep.status,
            dropWindow: point.dropWindow,
            withdrawTime: point.withdrawTime,
            owner: point.owner || '—'
          })
        })
      })
    })
    return rows
  }, [orchards, dropPoints, deployments, colonyById])

  const routeRows = useMemo(
    () =>
      routes.map((route: TransitRoute) => {
        const from = dropPoints.find((item) => item.id === route.fromDropId)
        const to = dropPoints.find((item) => item.id === route.toDropId)
        return {
          from: from ? `${from.code}（${orchardName(from.orchardId)}）` : '—',
          to: to ? `${to.code}（${orchardName(to.orchardId)}）` : '—',
          distanceKm: route.distanceKm,
          durationH: route.durationH,
          vehicleType: route.vehicleType,
          departAt: route.departAt,
          riskNote: route.riskNote || '—',
          actualNote: route.actualNote || '—'
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routes, dropPoints, orchards]
  )

  /** 撤场安排（标注是否已因花期/容量变更失效） */
  const withdrawalRows = useMemo(
    () =>
      withdrawals.map((plan: WithdrawalPlan) => {
        const orchard = orchards.find((item) => item.id === plan.orchardId)
        const points = dropPoints.filter((item) => item.orchardId === plan.orchardId)
        const stale = orchard ? isPlanStale(plan, orchard, points) : true
        return {
          orchard: orchardName(plan.orchardId),
          acceptance: orchard?.acceptance ?? '待验收',
          withdrawAt: plan.withdrawAt.replace('T', ' '),
          vehicleType: plan.vehicleType,
          status: stale && plan.status === '待执行' ? '已失效·待重算' : plan.status,
          note: plan.note || '—'
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [withdrawals, orchards, dropPoints]
  )

  function exportSchedule(): void {
    downloadCsv('授粉安排清单.csv', scheduleRows as unknown as Record<string, unknown>[], [
      { key: 'orchard', label: '地块' },
      { key: 'acceptance', label: '验收结论' },
      { key: 'crop', label: '作物' },
      { key: 'areaMu', label: '面积(亩)' },
      { key: 'bloom', label: '盛花期' },
      { key: 'days', label: '花期天数' },
      { key: 'suggestBoxes', label: '建议箱数' },
      { key: 'dropCode', label: '投放点' },
      { key: 'colonyCode', label: '群号' },
      { key: 'deployStatus', label: '投放状态' },
      { key: 'dropWindow', label: '投放时间窗' },
      { key: 'withdrawTime', label: '撤场参考' },
      { key: 'owner', label: '责任人' }
    ])
    message.success('授粉安排清单已导出')
  }

  function exportWithdrawals(): void {
    downloadCsv('撤场安排表.csv', withdrawalRows as unknown as Record<string, unknown>[], [
      { key: 'orchard', label: '地块' },
      { key: 'acceptance', label: '验收结论' },
      { key: 'withdrawAt', label: '撤场时刻' },
      { key: 'vehicleType', label: '车辆' },
      { key: 'status', label: '状态' },
      { key: 'note', label: '备注' }
    ])
    message.success('撤场安排表已导出')
  }

  function exportRoutes(): void {
    downloadCsv('转场路线表.csv', routeRows as unknown as Record<string, unknown>[], [
      { key: 'from', label: '出发投放点' },
      { key: 'to', label: '到达投放点' },
      { key: 'distanceKm', label: '里程(km)' },
      { key: 'durationH', label: '预计耗时(h)' },
      { key: 'vehicleType', label: '车辆' },
      { key: 'departAt', label: '出发时刻' },
      { key: 'riskNote', label: '途中风险' },
      { key: 'actualNote', label: '实际记录' }
    ])
    message.success('转场路线表已导出')
  }

  function exportBackup(): void {
    downloadJson('gbbeeroute-backup.json', {
      exportedAt: new Date().toISOString(),
      orchards,
      colonies,
      dropPoints,
      deployments,
      withdrawals,
      routes
    })
    message.success('全量数据已导出为 JSON 备份')
  }

  return (
    <div className="page">
      <style>{`@page { size: A4 ${orientation}; margin: 10mm; }`}</style>
      <div className="page-head">
        <div>
          <h2 className="page-title">导出与打印</h2>
          <p className="page-sub">
            导出授粉安排清单（地块、验收、群号、投放点、排队）、撤场安排表与转场路线表，或直接使用打印视图现场交底。
          </p>
        </div>
        <Space>
          <Radio.Group value={orientation} onChange={(event) => setOrientation(event.target.value)}>
            <Radio.Button value="portrait">纵向打印</Radio.Button>
            <Radio.Button value="landscape">横向打印</Radio.Button>
          </Radio.Group>
          <Button onClick={() => window.print()}>打印视图</Button>
        </Space>
      </div>

      <Card size="small">
        <Space wrap>
          <Button type="primary" onClick={exportSchedule}>
            导出授粉安排清单（CSV）
          </Button>
          <Button onClick={exportWithdrawals}>导出撤场安排表（CSV）</Button>
          <Button onClick={exportRoutes}>导出转场路线表（CSV）</Button>
          <Button onClick={exportBackup}>导出全量 JSON 备份</Button>
          <Tag>地块 {orchards.length}</Tag>
          <Tag>蜂群 {colonies.length}</Tag>
          <Tag>投放点 {dropPoints.length}</Tag>
          <Tag>投放安排 {deployments.length}</Tag>
          <Tag>撤场安排 {withdrawals.length}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            生成时间 {dayjs().format('YYYY-MM-DD HH:mm')}
          </Typography.Text>
        </Space>
      </Card>

      <div className={orientation === 'landscape' ? 'print-landscape' : 'print-portrait'}>
        <Card size="small" title={`授粉安排清单（${scheduleRows.length} 行）`} style={{ marginBottom: 16 }}>
          <Table<ScheduleExportRow>
            dataSource={scheduleRows}
            rowKey={(record, index) => `${record.orchard}-${record.dropCode}-${record.colonyCode}-${index ?? 0}`}
            size="small"
            pagination={false}
            columns={[
              { title: '地块', dataIndex: 'orchard', key: 'orchard' },
              { title: '验收', dataIndex: 'acceptance', key: 'acceptance', width: 80 },
              { title: '作物', dataIndex: 'crop', key: 'crop', width: 70 },
              { title: '盛花期', dataIndex: 'bloom', key: 'bloom' },
              { title: '建议箱数', dataIndex: 'suggestBoxes', key: 'suggest', width: 80 },
              { title: '投放点', dataIndex: 'dropCode', key: 'drop', width: 80 },
              { title: '群号', dataIndex: 'colonyCode', key: 'colony', width: 80 },
              { title: '投放状态', dataIndex: 'deployStatus', key: 'deployStatus', width: 90 },
              { title: '投放时间窗', dataIndex: 'dropWindow', key: 'window' },
              { title: '撤场参考', dataIndex: 'withdrawTime', key: 'withdraw' },
              { title: '责任人', dataIndex: 'owner', key: 'owner' }
            ]}
          />
        </Card>

        <Card size="small" title={`撤场安排表（${withdrawalRows.length} 份）`} style={{ marginBottom: 16 }}>
          <Table
            dataSource={withdrawalRows}
            rowKey={(record, index) => `${record.orchard}-${index ?? 0}`}
            size="small"
            pagination={false}
            columns={[
              { title: '地块', dataIndex: 'orchard', key: 'orchard' },
              { title: '验收结论', dataIndex: 'acceptance', key: 'acceptance', width: 90 },
              { title: '撤场时刻', dataIndex: 'withdrawAt', key: 'withdrawAt', width: 160 },
              { title: '车辆', dataIndex: 'vehicleType', key: 'vehicle', width: 100 },
              { title: '状态', dataIndex: 'status', key: 'status', width: 120 },
              { title: '备注', dataIndex: 'note', key: 'note' }
            ]}
          />
        </Card>

        <Card size="small" title={`转场路线表（${routeRows.length} 段）`}>
          <Table
            dataSource={routeRows}
            rowKey={(record, index) => `${record.from}-${record.to}-${index ?? 0}`}
            size="small"
            pagination={false}
            columns={[
              { title: '出发投放点', dataIndex: 'from', key: 'from' },
              { title: '到达投放点', dataIndex: 'to', key: 'to' },
              { title: '里程(km)', dataIndex: 'distanceKm', key: 'km', width: 100 },
              { title: '耗时(h)', dataIndex: 'durationH', key: 'hour', width: 90 },
              { title: '车辆', dataIndex: 'vehicleType', key: 'vehicle', width: 100 },
              { title: '出发时刻', dataIndex: 'departAt', key: 'depart' },
              { title: '途中风险', dataIndex: 'riskNote', key: 'risk' }
            ]}
          />
        </Card>
      </div>

      <Row gutter={16}>
        <Col xs={24} md={12}>
          <Card size="small" title="蜂群投放一览（按群号）">
            <Space direction="vertical">
              {colonies.map((colony: BeeColony) => {
                const deps = deployments.filter((item) => item.colonyId === colony.id)
                return (
                  <Typography.Text key={colony.id}>
                    <Tag color="cyan">{colony.code}</Tag>
                    {colony.species} · {colony.strengthFrames} 足框 ·{' '}
                    {deps.length > 0
                      ? deps
                          .map((dep) => {
                            const point = pointById.get(dep.dropPointId)
                            return `${point?.code ?? '?'}@${orchardName(dep.orchardId)}（${dep.status}）`
                          })
                          .join('、')
                      : '尚未安排投放点'}
                  </Typography.Text>
                )
              })}
            </Space>
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card size="small" title="导出说明">
            <Typography.Paragraph style={{ fontSize: 13, marginBottom: 6 }}>
              1. 授粉安排清单按「地块 × 投放点 × 群号」展开，标注已投放/排队状态与托管队验收结论，可直接给技术员与园主核对；
            </Typography.Paragraph>
            <Typography.Paragraph style={{ fontSize: 13, marginBottom: 6 }}>
              2. 撤场安排表中的「已失效·待重算」表示托管队改过花期或容量，技术员需在投放与撤场页重算；
            </Typography.Paragraph>
            <Typography.Paragraph style={{ fontSize: 13, marginBottom: 0 }}>
              3. 点击「打印视图」后再选择打印机或另存 PDF；数据全部来自浏览器本地 IndexedDB。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>
    </div>
  )
}
