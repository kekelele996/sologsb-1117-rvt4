import { useMemo, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Table, Tag, Typography, message } from 'antd'
import dayjs from 'dayjs'
import type { Acceptance, DropPoint, Orchard } from '@/types'
import { ACCESSIBILITIES, ACCEPTANCES, CROPS, suggestColonyBoxes } from '@/types'
import CoordPicker from '@/components/common/CoordPicker'
import FlowerWindowBar from '@/components/common/FlowerWindowBar'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { orchardStore } from '@/stores/orchardStore'
import { droppointStore } from '@/stores/droppointStore'
import { deploymentStore } from '@/stores/deploymentStore'
import { bloomDays } from '@/utils/geo'
import { uid } from '@/utils/id'

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

const ACCEPTANCE_COLOR: Record<Acceptance, string> = {
  待验收: 'gold',
  达标: 'green',
  不达标: 'red'
}

/** 果园地块管理（托管队）：地块、容量与季末验收结论；蜂群排点与撤场由技术员负责 */
export default function OrchardsPage(): JSX.Element {
  const orchards = usePersistentStore(orchardStore, (state) => state.rows)
  const dropPoints = usePersistentStore(droppointStore, (state) => state.rows)
  const deployments = usePersistentStore(deploymentStore, (state) => state.rows)

  const [orchardModal, setOrchardModal] = useState(false)
  const [editingOrchard, setEditingOrchard] = useState<Orchard | null>(null)
  const [coord, setCoord] = useState({ longitude: 107.41, latitude: 34.61 })
  const [orchardForm] = Form.useForm<OrchardFormValues>()

  const [dropModal, setDropModal] = useState(false)
  const [dropOwner, setDropOwner] = useState<Orchard | null>(null)
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

  /** 投放点箱位占用（已投放 / 排队 / 容量），由技术员的投放安排统计 */
  const pointUsage = useMemo(() => {
    const map = new Map<string, { placed: number; queued: number }>()
    deployments.forEach((dep) => {
      const prev = map.get(dep.dropPointId) ?? { placed: 0, queued: 0 }
      if (dep.status === '已投放') prev.placed += 1
      else prev.queued += 1
      map.set(dep.dropPointId, prev)
    })
    return map
  }, [deployments])

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
      bloom: [dayjs().month(3).date(8), dayjs().month(3).date(18)]
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
      bloom: [dayjs(orchard.bloomStart), dayjs(orchard.bloomEnd)]
    })
    setOrchardModal(true)
  }

  async function submitOrchard(): Promise<void> {
    const values = await orchardForm.validateFields()
    const nextBloom = [values.bloom[0].format('YYYY-MM-DD'), values.bloom[1].format('YYYY-MM-DD')]
    const bloomChanged =
      editingOrchard && (editingOrchard.bloomStart !== nextBloom[0] || editingOrchard.bloomEnd !== nextBloom[1])
    const row: Orchard = {
      id: editingOrchard?.id ?? uid('orc'),
      name: values.name.trim(),
      crop: values.crop,
      areaMu: Number(values.areaMu) || 0,
      longitude: coord.longitude,
      latitude: coord.latitude,
      bloomStart: nextBloom[0],
      bloomEnd: nextBloom[1],
      colonyIntensity: Number(values.colonyIntensity) || 0,
      ownerContact: values.ownerContact.trim(),
      accessibility: values.accessibility,
      historyYears: values.historyYears
        .split(/[、,，\s]+/)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0),
      acceptance: editingOrchard?.acceptance ?? '待验收',
      note: values.note?.trim() ?? ''
    }
    await orchardStore.getState().save(row)
    message.success(`地块「${row.name}」已保存，建议蜂群 ${suggestColonyBoxes(row)} 箱`)
    if (bloomChanged) {
      message.warning('盛花期已调整：该地块撤场安排将失效，请通知技术员在「蜂群投放与撤场」页重算')
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
    message.success('地块已删除')
  }

  async function applyAcceptance(orchard: Orchard, acceptance: Acceptance): Promise<void> {
    await orchardStore.getState().setAcceptance(orchard.id, acceptance)
    if (acceptance === '不达标') {
      message.warning(`「${orchard.name}」验收不达标：已投放的蜂群已退回待投放，可在技术员侧补投，撤场安排作废`)
    } else if (acceptance === '达标') {
      message.success(`「${orchard.name}」验收达标，技术员可安排撤场`)
    } else {
      message.info(`「${orchard.name}」已标记为待验收`)
    }
  }

  function openDrop(orchard: Orchard): void {
    setDropOwner(orchard)
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

  async function submitDrop(): Promise<void> {
    if (!dropOwner) return
    const values = await dropForm.validateFields()
    const row: DropPoint = {
      id: uid('dp'),
      orchardId: dropOwner.id,
      longitude: dropCoord.longitude,
      latitude: dropCoord.latitude,
      code: values.code.trim(),
      capacityBoxes: Number(values.capacityBoxes) || 0,
      shade: values.shade?.trim() ?? '',
      waterDistance: Number(values.waterDistance) || 0,
      dropWindow: values.dropWindow.format('YYYY-MM-DD'),
      withdrawTime: values.withdrawTime.format('YYYY-MM-DD'),
      owner: values.owner?.trim() ?? ''
    }
    await droppointStore.getState().save(row)
    await deploymentStore.getState().resyncPoint(row.id)
    message.success(`投放点 ${row.code} 已保存；容量若有调整，技术员的撤场安排需重算`)
    setDropModal(false)
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">果园地块管理 · 托管队</h2>
          <p className="page-sub">
            托管队负责地块档案、投放点容量与季末验收结论；蜂群排点、排队与撤场安排由技术员在「蜂群投放与撤场」页操作，两边各管各的。
          </p>
        </div>
        <Button type="primary" onClick={openCreate}>
          新建地块
        </Button>
      </div>

      <Alert
        type="info"
        showIcon
        message="改动盛花期或投放点容量后，该地块原有的撤场安排会自动判定失效，需由技术员按新数据重算；验收不达标的地块，已投放蜂群会退回待投放池等待补投。"
      />

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
                  <Tag color={ACCEPTANCE_COLOR[orchard.acceptance]}>验收：{orchard.acceptance}</Tag>
                </Space>
              }
              extra={
                <Space>
                  <Button size="small" onClick={() => openEdit(orchard)}>
                    编辑
                  </Button>
                  <Button size="small" onClick={() => openDrop(orchard)}>
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
              </Typography.Paragraph>
              <FlowerWindowBar orchard={orchard} others={orchards.filter((item) => item.id !== orchard.id)} width={420} />

              <Space wrap style={{ marginTop: 10 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  季末验收结论（按坐果）：
                </Typography.Text>
                {ACCEPTANCES.map((value) => (
                  <Button
                    key={value}
                    size="small"
                    type={orchard.acceptance === value ? 'primary' : 'default'}
                    danger={value === '不达标'}
                    onClick={() => {
                      if (value === '不达标') {
                        Modal.confirm({
                          title: `确认「${orchard.name}」验收不达标？`,
                          content: '该地块已投放蜂群将全部退回待投放池等待补投，撤场安排作废。',
                          okText: '确认不达标',
                          okButtonProps: { danger: true },
                          cancelText: '取消',
                          onOk: () => applyAcceptance(orchard, value)
                        })
                      } else {
                        void applyAcceptance(orchard, value)
                      }
                    }}
                  >
                    {value}
                  </Button>
                ))}
              </Space>

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
                    title: '容量/占用',
                    key: 'cap',
                    width: 120,
                    render: (_, record: DropPoint) => {
                      const usage = pointUsage.get(record.id) ?? { placed: 0, queued: 0 }
                      const over = usage.placed > record.capacityBoxes
                      return (
                        <Space size={4}>
                          <Tag color={over ? 'red' : usage.placed === record.capacityBoxes ? 'gold' : 'green'} style={{ marginInlineEnd: 0 }}>
                            {usage.placed}/{record.capacityBoxes} 箱
                          </Tag>
                          {usage.queued > 0 ? <Tag color="orange" style={{ marginInlineEnd: 0 }}>排队 {usage.queued}</Tag> : null}
                        </Space>
                      )
                    }
                  },
                  { title: '投放窗', dataIndex: 'dropWindow', key: 'win', width: 105 },
                  { title: '撤场参考', dataIndex: 'withdrawTime', key: 'with', width: 105 },
                  { title: '责任人', dataIndex: 'owner', key: 'owner', render: (value: string) => value || '—' },
                  {
                    title: '操作',
                    key: 'action',
                    width: 70,
                    render: (_, record: DropPoint) => (
                      <Popconfirm
                        title="删除投放点会把点上蜂群退回待投放，确认？"
                        onConfirm={() => droppointStore.getState().remove(record.id)}
                        okText="删除"
                        cancelText="取消"
                      >
                        <Button size="small" danger type="link">
                          删除
                        </Button>
                      </Popconfirm>
                    )
                  }
                ]}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <Modal title={editingOrchard ? '编辑地块' : '新建地块'} open={orchardModal} onCancel={() => setOrchardModal(false)} onOk={() => void submitOrchard()} width={720} okText="保存">
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
              <Form.Item name="bloom" label="盛花期区间（改动会使撤场安排失效）" rules={[{ required: true, message: '请选择盛花期区间' }]}>
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
          </Row>
          <Form.Item label="经纬度">
            <CoordPicker value={coord} onChange={setCoord} orchards={orchards} dropPoints={dropPoints} />
          </Form.Item>
          <OrchardSuggest suggest={suggestPreview} />
        </Form>
      </Modal>

      <Modal
        title={`新增投放点 · ${dropOwner?.name ?? ''}`}
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
              <Form.Item name="capacityBoxes" label="可容纳箱数（改动会使撤场安排失效）" rules={[{ required: true }]}>
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
              <Form.Item name="withdrawTime" label="撤场参考时间" rules={[{ required: true }]}>
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
            蜂群排到投放点由技术员在「蜂群投放与撤场」页操作：箱数不超容量，装不下自动排队。
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
