import { STEPS } from './workflow.js';
import { MATTER_LABELS } from './receipts.js';

// ---------------------------------------------------------------------------
// 更正预览：原回执快照 vs 当前更正草稿的字段级差异。
// 证件号码与详细地址属于敏感字段，任何预览输出只允许出现遮罩内容，
// 遮罩在服务端完成，原始值不下发。
// ---------------------------------------------------------------------------

export const MASKED_FIELDS = new Set(['idNumber', 'detail']);

// 证件号码：保留首尾各 2 位（过短则只留首字符），其余遮罩
export function maskIdNumber(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (v.length <= 3) return `${v.slice(0, 1)}${'*'.repeat(Math.max(3, v.length - 1))}`;
  return `${v.slice(0, 2)}${'*'.repeat(Math.max(4, v.length - 4))}${v.slice(-2)}`;
}

// 详细地址：只保留前两个字，其余遮罩
export function maskAddressDetail(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  return `${v.slice(0, 2)}${'*'.repeat(6)}`;
}

function isEmptyValue(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false; // 布尔等其他类型不算“空”
}

function normalize(value) {
  return typeof value === 'string' ? value.trim() : value;
}

// 展示值：敏感字段一律遮罩；事项类型转中文标签；布尔转文案
function displayValue(field, value) {
  if (value === true) return '已勾选确认';
  if (value === false) return '未勾选';
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (field === 'idNumber') return maskIdNumber(text);
  if (field === 'detail') return maskAddressDetail(text);
  if (field === 'type') return MATTER_LABELS[text] || text;
  return text;
}

function classify(before, after) {
  const beforeEmpty = isEmptyValue(before);
  const afterEmpty = isEmptyValue(after);
  if (beforeEmpty && afterEmpty) return 'unchanged';
  if (beforeEmpty) return 'added';
  if (afterEmpty) return 'deleted';
  return normalize(before) === normalize(after) ? 'unchanged' : 'modified';
}

// sourceSnapshot：原回执冻结快照；drafts：更正办理当前各步草稿（数组，按步骤顺序）
export function buildCorrectionDiff(sourceSnapshot, drafts) {
  const fields = [];
  const summary = { added: 0, modified: 0, deleted: 0, unchanged: 0 };
  STEPS.forEach((definition, step) => {
    const before = sourceSnapshot?.steps?.[step]?.data || {};
    const after = drafts?.[step] || {};
    for (const [field, rule] of Object.entries(definition.fields)) {
      const change = classify(before[field], after[field]);
      summary[change] += 1;
      fields.push({
        step,
        stepKey: definition.key,
        stepTitle: definition.title,
        field,
        label: rule.label,
        change,
        masked: MASKED_FIELDS.has(field),
        before: displayValue(field, before[field]),
        after: displayValue(field, after[field]),
      });
    }
  });
  return { summary, fields };
}
