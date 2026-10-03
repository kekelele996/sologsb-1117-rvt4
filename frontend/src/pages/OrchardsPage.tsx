import { useMemo, useState } from 'react'
import { Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import type { AcceptanceResult, DropPoint, Orchard } from '@/types'
import { ACCESSIBILITIES, ACCEPTANCE_RESULTS, CROPS, suggestColonyBoxes } from '@/types'
import CoordPicker from '@/components/common/CoordPicker'
import FlowerWindowBar from '@/components/common/FlowerWindowBar'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { droppointStore } from '@/stores/droppointStore'
import { withdrawPlanStore } from '@/stores/withdrawPlanStore'
import { bloomDays } from '@/utils/geo'
import { uid } from '@/utils/id'

const ACCEPTANCE_COLORS: Record<AcceptanceResult, string> = {
  待验收: 'default',
  达标: 'green',
  不达标: 'red'
}

interface OrchardFormValues {
  name: string
  crop: Orchard['crop']
  areaMu: number
  colonyIntensity: number
  ownerContact: string
  accessibility: Orchard['accessibility']
  historyYears: string
  note: string
  bloom: [dayjs.Dayjs, dayjs.Dayjs]
  acceptance: AcceptanceResult
  fruitSetNote: string
}

interface DropFormValues {
  code: string
  capacityBoxes: number
  shade: string
  waterDistance: number
  dropWindow: dayjs.Dayjs
  withdrawTime: dayjs.Dayjs
  owner: string
}

/** 果园地块管理（托管队）：地块、花期、投放点容量与验收结论；不负责蜂群排布 */
export default function OrchardsPage(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)

  const [orchardModal, setOrchardModal] = useState(false)
  const [editingOrchard, setEditingOrchard] = useState<Orchard | null>(null)
  const [coord, setCoord] = useState({ longitude: 107.41, latitude: 34.61 })
  const [orchardForm] = Form.useForm<OrchardFormValues>()

  const [dropModal, setDropModal] = useState(false)
  const [dropOwner, setDropOwner] = useState<Orchard | null>(null)
  const [editingDrop, setEditingDrop] = useState<DropPoint | null>(null)
  const [dropCoord, setDropCoord] = useState({ longitude: 107.41, latitude: 34.61 })
  const [dropForm] = Form.useForm<DropFormValues>()

  const watchedArea = Form.useWatch('areaMu', orchardForm) ?? 0
  const watchedIntensity = Form.useWatch('colonyIntensity', orchardForm) ?? 0
  const suggestPreview = suggestColonyBoxes({
    areaMu: Number(watchedArea) || 0,
    colonyIntensity: Number(watchedIntensity) || 0
  })

  const dropsOf = useMemo(
    () => (orchardId: string): DropPoint[] => dropPoints.filter((item) => item.orchardId === orchardId),
    [dropPoints]
  )

  function openCreate(): void {
    setEditingOrchard(null)
    setCoord({ longitude: 107.41, latitude: 34.61 })
    orchardForm.setFieldsValue({
      name: '',
      crop: '苹果',
      areaMu: 100,
      colonyIntensity: 0.1,
      ownerContact: '',
      accessibility: '大车可达',
      historyYears: '2025',
      note: '',
      bloom: [dayjs().month(3).date(8), dayjs().month(3).date(18)],
      acceptance: '待验收',
      fruitSetNote: ''
    })
    setOrchardModal(true)
  }

  function openEdit(orchard: Orchard): void {
    setEditingOrchard(orchard)
    setCoord({ longitude: orchard.longitude, latitude: orchard.latitude })
    orchardForm.setFieldsValue({
      name: orchard.name,
      crop: orchard.crop,
      areaMu: orchard.areaMu,
      colonyIntensity: orchard.colonyIntensity,
      ownerContact: orchard.ownerContact,
      accessibility: orchard.accessibility,
      historyYears: orchard.historyYears.join('、'),
      note: orchard.note,
      bloom: [dayjs(orchard.bloomStart), dayjs(orchard.bloomEnd)],
      acceptance: orchard.acceptance ?? '待验收',
      fruitSetNote: orchard.fruitSetNote ?? ''
    })
    setOrchardModal(true)
  }

  async function submitOrchard(): Promise<void> {
    const values = await orchardForm.validateFields()
    const row: Orchard = {
      id: editingOrchard?.id ?? uid('orc'),
      name: values.name.trim(),
      crop: values.crop,
      areaMu: Number(values.areaMu) || 0,
      longitude: coord.longitude,
      latitude: coord.latitude,
      bloomStart: values.bloom[0].format('YYYY-MM-DD'),
      bloomEnd: values.bloom[1].format('YYYY-MM-DD'),
      colonyIntensity: Number(values.colonyIntensity) || 0,
      ownerContact: values.ownerContact.trim(),
      accessibility: values.accessibility,
      historyYears: values.historyYears
        .split(/[、,，\s]+/)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0),
      note: values.note?.trim() ?? '',
      acceptance: values.acceptance,
      fruitSetNote: values.fruitSetNote?.trim() ?? ''
    }
    const { rejectedCodes } = await orchardStore.getState().save(row)
    await withdrawPlanStore.getState().refresh()
    message.success(`地块「${row.name}」已保存，建议蜂群 ${suggestColonyBoxes(row)} 箱`)
    if (rejectedCodes.length > 0) {
      message.warning(`验收不达标：${rejectedCodes.join('、')} 已退回「待投放」，等待补投`)
    }
    setOrchardModal(false)
  }

  async function removeOrchard(orchard: Orchard): Promise<void> {
    const drops = dropsOf(orchard.id)
    if (drops.length > 0) {
      message.error(`「${orchard.name}」下仍有 ${drops.length} 个投放点，请先清理投放点`)
      return
    }
    await orchardStore.getState().remove(orchard.id)
    await withdrawPlanStore.getState().refresh()
    message.success('地块已删除')
  }

  function openDropCreate(orchard: Orchard): void {
    setDropOwner(orchard)
    setEditingDrop(null)
    setDropCoord({ longitude: orchard.longitude, latitude: orchard.latitude })
    const index = dropPoints.filter((item) => item.orchardId === orchard.id).length + 1
    dropForm.setFieldsValue({
      code: `${orchard.crop.slice(0, 1)}-${String(index).padStart(2, '0')}`,
      capacityBoxes: suggestColonyBoxes(orchard),
      shade: '',
      waterDistance: 300,
      dropWindow: dayjs(orchard.bloomStart).subtract(1, 'day'),
      withdrawTime: dayjs(orchard.bloomEnd).add(1, 'day'),
      owner: ''
    })
    setDropModal(true)
  }

  function openDropEdit(point: DropPoint, orchard: Orchard): void {
    setDropOwner(orchard)
    setEditingDrop(point)
    setDropCoord({ longitude: point.longitude, latitude: point.latitude })
    dropForm.setFieldsValue({
      code: point.code,
      capacityBoxes: point.capacityBoxes,
      shade: point.shade,
      waterDistance: point.waterDistance,
      dropWindow: dayjs(point.dropWindow),
      withdrawTime: dayjs(point.withdrawTime),
      owner: point.owner
    })
    setDropModal(true)
  }

  async function submitDrop(): Promise<void> {
    if (!dropOwner) return
    const values = await dropForm.validateFields()
    const row: DropPoint = {
      id: editingDrop?.id ?? uid('dp'),
      orchardId: dropOwner.id,
      longitude: dropCoord.longitude,
      latitude: dropCoord.latitude,
      code: values.code.trim(),
      capacityBoxes: Number(values.capacityBoxes) || 0,
      shade: values.shade?.trim() ?? '',
      waterDistance: Number(values.waterDistance) || 0,
      dropWindow: values.dropWindow.format('YYYY-MM-DD'),
      withdrawTime: values.withdrawTime.format('YYYY-MM-DD'),
      owner: values.owner?.trim() ?? '',
      // 蜂群排布归技术员：编辑容量时保留既有在点 / 排队队列
      colonyCodes: editingDrop?.colonyCodes ?? [],
      waitingColonyCodes: editingDrop?.waitingColonyCodes ?? []
    }
    const { rebalanced } = await droppointStore.getState().save(row)
    await withdrawPlanStore.getState().refresh()
    if (editingDrop) {
      message.success(`投放点 ${row.code} 已更新，撤场安排已失效需重算`)
      if (rebalanced > 0) message.info(`容量变化已联动：${rebalanced} 群在「在点 / 排队」间调整`)
    } else {
      message.success(`投放点 ${row.code} 已保存`)
    }
    setDropModal(false)
  }

  async function removeDrop(point: DropPoint): Promise<void> {
    await droppointStore.getState().remove(point.id)
    await withdrawPlanStore.getState().refresh()
    message.success('投放点已删除')
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">果园地块管理 · 托管队</h2>
          <p className="page-sub">
            托管队负责地块、花期、投放点容量与季末验收结论（待验收 / 达标 / 不达标）；蜂群往投放点的排布与撤场由技术员负责。
            改动花期或容量后，技术员已生成的撤场安排自动失效需重算。
          </p>
        </div>
        <Button type="primary" onClick={openCreate}>
          新建地块
        </Button>
      </div>

      <Row gutter={[16, 16]}>
        {orchards.map((orchard) => (
          <Col key={orchard.id} xs={24} xl={12}>
            <Card
              size="small"
              title={
                <Space wrap>
                  <span>{orchard.name}</span>
                  <Tag color="blue">{orchard.crop}</Tag>
                  <Tag color={orchard.accessibility === '大车可达' ? 'green' : orchard.accessibility === '仅小车' ? 'gold' : 'red'}>
                    {orchard.accessibility}
                  </Tag>
                  <Tag color="orange">建议 {suggestColonyBoxes(orchard)} 箱</Tag>
                  <Tag color={ACCEPTANCE_COLORS[orchard.acceptance ?? '待验收']}>
                    验收·{orchard.acceptance ?? '待验收'}
                  </Tag>
                </Space>
              }
              extra={
                <Space>
                  <Button size="small" onClick={() => openEdit(orchard)}>
                    编辑 / 验收
                  </Button>
                  <Button size="small" onClick={() => openDropCreate(orchard)}>
                    新增投放点
                  </Button>
                  <Button size="small" danger onClick={() => void removeOrchard(orchard)}>
                    删除
                  </Button>
                </Space>
              }
            >
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                {orchard.areaMu} 亩 · 需蜂 {orchard.colonyIntensity} 箱/亩 · 园主 {orchard.ownerContact || '—'} · 历史授粉{' '}
                {orchard.historyYears.length > 0 ? orchard.historyYears.join('、') : '—'} 年 · 花期 {bloomDays(orchard)} 天
                {orchard.fruitSetNote ? ` · 坐果：${orchard.fruitSetNote}` : ''}
              </Typography.Paragraph>
              <FlowerWindowBar orchard={orchard} others={orchards.filter((item) => item.id !== orchard.id)} width={420} />
              <Table<DropPoint>
                style={{ marginTop: 10 }}
                size="small"
                pagination={false}
                dataSource={dropsOf(orchard.id)}
                rowKey="id"
                locale={{ emptyText: '暂无投放点' }}
                columns={[
                  { title: '编号', dataIndex: 'code', key: 'code', width: 80 },
                  {
                    title: '容量',
                    dataIndex: 'capacityBoxes',
                    key: 'cap',
                    width: 90,
                    render: (value: number) => `${value} 箱`
                  },
                  { title: '投放窗', dataIndex: 'dropWindow', key: 'win', width: 105 },
                  { title: '撤场', dataIndex: 'withdrawTime', key: 'with', width: 105 },
                  {
                    title: '在点 / 排队',
                    key: 'load',
                    render: (_, record: DropPoint) => (
                      <Tag color={record.colonyCodes.length >= record.capacityBoxes ? 'orange' : 'green'}>
                        {record.colonyCodes.length}/{record.capacityBoxes}
                        {record.waitingColonyCodes.length > 0 ? ` · 排队 ${record.waitingColonyCodes.length}` : ''}
                      </Tag>
                    )
                  },
                  {
                    title: '操作',
                    key: 'action',
                    width: 110,
                    render: (_, record: DropPoint) => (
                      <Space size={0}>
                        <Button size="small" type="link" onClick={() => openDropEdit(record, orchard)}>
                          编辑
                        </Button>
                        <Button size="small" danger type="link" onClick={() => void removeDrop(record)}>
                          删除
                        </Button>
                      </Space>
                    )
                  }
                ]}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <Modal title={editingOrchard ? '编辑地块 / 出具验收结论' : '新建地块'} open={orchardModal} onCancel={() => setOrchardModal(false)} onOk={() => void submitOrchard()} width={720} okText="保存">
        <Form form={orchardForm} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="name" label="地块名" rules={[{ required: true, message: '请填写地块名' }]}>
                <Input placeholder="如 北岭苹果园" />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="crop" label="作物" rules={[{ required: true }]}>
                <Select options={CROPS.map((item) => ({ value: item, label: item }))} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item name="areaMu" label="面积（亩）" rules={[{ required: true }]}>
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="colonyIntensity" label="需蜂强度（箱/亩）" rules={[{ required: true }]}>
                <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="accessibility" label="道路可达性" rules={[{ required: true }]}>
                <Select options={ACCESSIBILITIES.map((item) => ({ value: item, label: item }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="ownerContact" label="园主联系方式">
                <Input placeholder="如 135****2043（周园主）" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="bloom" label="盛花期区间（改动后撤场安排失效）" rules={[{ required: true, message: '请选择盛花期区间' }]}>
                <DatePicker.RangePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="historyYears" label="历史授粉年份（顿号分隔）">
                <Input placeholder="如 2024、2025" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="note" label="备注">
                <Input placeholder="行距、坡向等" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="acceptance" label="季末验收结论（按坐果）" rules={[{ required: true }]}>
                <Select
                  options={ACCEPTANCE_RESULTS.map((item) => ({
                    value: item,
                    label: item === '不达标' ? '不达标（在点群退回待投放补投）' : item
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={16}>
              <Form.Item name="fruitSetNote" label="坐果 / 验收备注">
                <Input placeholder="如 坐果均匀，边行略稀" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="经纬度">
            <CoordPicker value={coord} onChange={setCoord} orchards={orchards} dropPoints={dropPoints} />
          </Form.Item>
          <OrchardSuggest suggest={suggestPreview} />
        </Form>
      </Modal>

      <Modal
        title={editingDrop ? `编辑投放点 ${editingDrop.code} · ${dropOwner?.name ?? ''}` : `新增投放点 · ${dropOwner?.name ?? ''}`}
        open={dropModal}
        onCancel={() => setDropModal(false)}
        onOk={() => void submitDrop()}
        width={720}
        okText="保存"
      >
        <Form form={dropForm} layout="vertical">
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="code" label="编号" rules={[{ required: true, message: '请填写投放点编号' }]}>
                <Input placeholder="如 A-03" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="capacityBoxes" label="可容纳箱数（改动后撤场安排失效）" rules={[{ required: true }]}>
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="waterDistance" label="水源距离（米）">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="dropWindow" label="投放时间窗" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="withdrawTime" label="撤场时间" rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="owner" label="责任人">
                <Input />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="shade" label="遮阴条件">
                <Input placeholder="如 北侧有防风林，午后半阴" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="经纬度">
            <CoordPicker value={dropCoord} onChange={setDropCoord} orchards={orchards} dropPoints={dropPoints} />
          </Form.Item>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            投放点的蜂群排布（在点 / 排队）由技术员在「撤场安排」页操作；此处只能维护容量与场地信息。
          </Typography.Text>
        </Form>
      </Modal>
    </div>
  )
}

/** 建议箱数提示条（面积 × 需蜂强度向上取整，最少 1 箱） */
function OrchardSuggest({ suggest }: { suggest: number }): JSX.Element {
  return (
    <Typography.Text type="secondary">
      系统建议投放 {suggest} 箱；按每个投放点 8 箱估算，约需 {Math.max(1, Math.ceil(suggest / 8))} 个投放点。
    </Typography.Text>
  )
}
