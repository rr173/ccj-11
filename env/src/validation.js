import { STEPS } from './workflow.js';

export function validateStepPayload(step, input) {
  const definition = STEPS[step];
  if (!definition) return { error: { code: 'UNKNOWN_STEP', message: '未知步骤' } };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: { code: 'INVALID_PAYLOAD', message: '提交内容必须是对象' } };
  }

  const payload = {};
  for (const [name, rule] of Object.entries(definition.fields)) {
    let value = input[name];

    if (rule.boolean) {
      if (value !== true) {
        return { error: { code: 'FIELD_REQUIRED', field: name, message: `请勾选：${rule.label}` } };
      }
      payload[name] = true;
      continue;
    }

    if (typeof value === 'string') value = value.trim();
    if (value === undefined || value === null || value === '') {
      if (rule.required) {
        return { error: { code: 'FIELD_REQUIRED', field: name, message: `${rule.label}为必填项` } };
      }
      payload[name] = '';
      continue;
    }

    if (typeof value !== 'string') {
      return { error: { code: 'FIELD_INVALID', field: name, message: `${rule.label}格式不正确` } };
    }
    if (rule.max && value.length > rule.max) {
      return { error: { code: 'FIELD_TOO_LONG', field: name, message: `${rule.label}不能超过 ${rule.max} 个字符` } };
    }
    if (rule.min && value.length < rule.min) {
      return { error: { code: 'FIELD_TOO_SHORT', field: name, message: `${rule.label}至少 ${rule.min} 个字符` } };
    }
    if (rule.pattern && !rule.pattern.test(value)) {
      return { error: { code: 'FIELD_INVALID', field: name, message: `${rule.label}格式不正确` } };
    }
    if (rule.enum && !rule.enum.includes(value)) {
      return { error: { code: 'FIELD_INVALID', field: name, message: `请选择有效的${rule.label}` } };
    }
    payload[name] = value;
  }

  const unexpected = Object.keys(input).filter((key) => !(key in definition.fields));
  if (unexpected.length > 0) {
    return { error: { code: 'UNEXPECTED_FIELDS', fields: unexpected, message: '包含未定义字段' } };
  }

  return { payload };
}

export function validateDraft(step, input) {
  const definition = STEPS[step];
  if (!definition) return { error: { code: 'UNKNOWN_STEP', message: '未知步骤' } };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: { code: 'INVALID_PAYLOAD', message: '草稿必须是对象' } };
  }

  const draft = {};
  for (const [name, rule] of Object.entries(definition.fields)) {
    let value = input[name];
    if (rule.boolean) {
      draft[name] = value === true;
      continue;
    }
    if (value === undefined || value === null) {
      draft[name] = '';
      continue;
    }
    if (typeof value !== 'string') {
      return { error: { code: 'FIELD_INVALID', field: name, message: `${rule.label}格式不正确` } };
    }
    value = value.trim();
    if (value.length > (rule.max || 1000)) {
      return { error: { code: 'FIELD_TOO_LONG', field: name, message: `${rule.label}不能超过 ${rule.max} 个字符` } };
    }
    draft[name] = value;
  }
  return { draft };
}
