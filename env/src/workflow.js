export const STEPS = [
  {
    key: 'applicant',
    title: '申请人信息',
    fields: {
      name: { label: '姓名', required: true, max: 50 },
      idNumber: { label: '证件号码', required: true, pattern: /^[A-Z0-9a-z-]{6,30}$/ },
      phone: { label: '手机号', required: true, pattern: /^1[3-9]\d{9}$/ },
    },
  },
  {
    key: 'address',
    title: '联系地址',
    fields: {
      province: { label: '省份', required: true, max: 30 },
      city: { label: '城市', required: true, max: 30 },
      detail: { label: '详细地址', required: true, min: 5, max: 200 },
    },
  },
  {
    key: 'matter',
    title: '办理事项',
    fields: {
      type: { label: '事项类型', required: true, enum: ['new', 'renew', 'change'] },
      description: { label: '事项说明', required: false, max: 500 },
    },
  },
  {
    key: 'declaration',
    title: '确认声明',
    fields: {
      agreed: { label: '我确认所填信息真实有效', required: true, boolean: true },
      contactTime: { label: '方便联系的时间', required: false, max: 100 },
    },
  },
];

export const FINAL_STEP = STEPS.length;
export const STEP_KEYS = new Set(STEPS.map((step) => step.key));

export function getStep(step) {
  return STEPS[step] || null;
}
