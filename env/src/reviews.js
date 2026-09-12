import { STEPS } from './workflow.js';
import { MATTER_LABELS, maskName, maskPhone } from './receipts.js';
import { maskAddressDetail, maskIdNumber } from './corrections.js';

// ---------------------------------------------------------------------------
// 回执复核协作（免登录复核人视角）
//
// 复核人不需要登录，但只能通过一次性邀请链接进入；进入后也只能看到链接绑定
// 的“这一份回执”的脱敏内容。任何输出都不允许出现证件号码、完整地址等原值。
// ---------------------------------------------------------------------------

export const REVIEW_TTL_CHOICES = [
  { minutes: 60, label: '1 小时' },
  { minutes: 24 * 60, label: '24 小时' },
  { minutes: 3 * 24 * 60, label: '3 天' },
  { minutes: 7 * 24 * 60, label: '7 天' },
];

export function isValidTtlMinutes(value, maxMinutes) {
  return Number.isInteger(value) && value >= 1 && value <= maxMinutes;
}

export function reviewFieldDef(step, field) {
  const definition = STEPS[step];
  if (!definition || !Object.prototype.hasOwnProperty.call(definition.fields, field)) return null;
  return { definition, rule: definition.fields[field] };
}

// 单字段脱敏：敏感字段在服务端遮罩后才允许出现在复核响应中
export function maskReviewFieldValue(field, raw) {
  if (field === 'agreed') return { kind: 'boolean', value: raw === true };
  const text = raw === undefined || raw === null ? '' : String(raw);
  switch (field) {
    case 'name':
      return { kind: 'text', value: maskName(text) };
    case 'phone':
      return { kind: 'text', value: maskPhone(text) };
    case 'idNumber':
      return { kind: 'text', value: maskIdNumber(text), masked: true };
    case 'detail':
      return { kind: 'text', value: maskAddressDetail(text), masked: true };
    case 'type':
      return { kind: 'text', value: text ? (MATTER_LABELS[text] || text) : '' };
    default:
      return { kind: 'text', value: text };
  }
}

// 复核视图：按步骤列出所有字段的脱敏值与字段元信息；不含任何敏感原值
export function buildReviewView(snapshot) {
  return {
    completedAt: snapshot.completedAt || null,
    sequence: snapshot.sequence,
    steps: STEPS.map((definition, step) => {
      const data = snapshot.steps?.[step]?.data || {};
      return {
        step,
        key: definition.key,
        title: definition.title,
        fields: Object.entries(definition.fields).map(([field, rule]) => {
          const display = maskReviewFieldValue(field, data[field]);
          return {
            field,
            label: rule.label,
            value: display.value,
            kind: display.kind,
            masked: Boolean(display.masked),
          };
        }),
      };
    }),
  };
}

export function reviewTextValue(field, raw) {
  const display = maskReviewFieldValue(field, raw);
  if (display.kind === 'boolean') return display.value ? '已勾选确认' : '未勾选';
  return display.value;
}

export const INVITATION_ERRORS = {
  INVITATION_NOT_FOUND: '邀请不存在或链接已失效，请向办理人确认链接是否正确',
  INVITATION_EXPIRED: '邀请已超过有效期限，链接失效，请联系办理人重新发起',
  INVITATION_ALREADY_USED: '该邀请链接只能使用一次，已完成过校验，不能再次使用',
  INVITATION_REVOKED: '邀请已被办理人撤销，链接失效',
  RECEIPT_REVOKED: '该回执已被撤销，不能再进行复核',
  REVIEW_SESSION_REQUIRED: '请先完成邀请校验',
  REVIEW_CSRF_INVALID: '复核会话校验失败，请重新打开邀请链接',
  REVIEW_RECEIPT_MISMATCH: '该邀请只能查看指定的那一份回执，不能用于其他回执',
};
