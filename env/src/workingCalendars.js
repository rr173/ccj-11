// ---------------------------------------------------------------------------
// 可版本化工作日历（versionable working calendar）——纯函数模块
//
// 管理员维护的日历内容：
//   timezone        日历日期归属的 IANA 时区（日期键“哪天”按此时区切分）
//   weeklyWindows   周一到周日每天的工作时段（分钟数；空数组表示该日不工作）
//   holidays        法定节假日：dateKey → 名称（整天不工作）
//   closures        临时停办日：dateKey → 停办说明（整天不工作，独立于节假日）
//
// 已发布的日历版本永不修改；异议在创建时固定（pin）一个版本，之后该版本如何
// 更新都不影响它，直到主管通过“迁移预览 → 确认迁移”显式换版本。
//
// 计时核心 advanceWorkingMinutes()：从给定时刻向后推进 N 个“工作分钟”，
// 遇到非工作时段自动顺延，并把每一段顺延（类型、起讫、原因）逐段返回。
// ---------------------------------------------------------------------------

export const CALENDAR_TIMEZONE_DEFAULT = 'Asia/Shanghai';
export const CALENDAR_WEEKDAY_COUNT = 7;
export const CALENDAR_WINDOW_MIN_MINUTES = 0;
export const CALENDAR_WINDOW_MAX_MINUTES = 24 * 60; // 允许 00:00-24:00 全天
export const CALENDAR_DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const CALENDAR_LABELS = {
  work: '工作时段',
  overnight: '非工作时段（工作时段外）',
  weekend: '周末休息',
  holiday: '法定节假日',
  closure: '临时停办日',
};

// ---------------------------------------------------------------------------
// 日期键（YYYY-MM-DD）与时区换算
// ---------------------------------------------------------------------------

// 指定 IANA 时区在某一 UTC 时刻相对 UTC 的偏移（分钟，东为正）。
// 借 Intl 的 longOffset 格式化结果解析，避免引入第三方时区库。
export function timezoneOffsetMinutes(timezone, atMs = Date.now()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(atMs)).map((p) => [p.type, p.value]));
  // 墙钟 = UTC + offset。asWall 是把墙钟数字当作 UTC 解释得到的“伪 UTC”
  // （午夜 00:00 时 Intl 可能给出 hour=24，这里归零为当天 0 点）。
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour);
  const asWall = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second),
  );
  return Math.round((asWall - atMs) / 60000);
}

// UTC 时刻 → 时区墙钟的 Date 参数（{y,m,d,h,min,s}）
function wallParts(timezone, atMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(atMs)).map((p) => [p.type, p.value]));
  // Node Intl 用 hour12:false 时会把某日 00:00 标成“当日 24:00”（day 仍是当天），
  // 按 0 点处理；Date.UTC 对 hour=24 的进位用于其他场合（这里直接归零）。
  const wallUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    Number(parts.minute), Number(parts.second),
  );
  return {
    y: new Date(wallUtc).getUTCFullYear(),
    m: new Date(wallUtc).getUTCMonth() + 1,
    d: new Date(wallUtc).getUTCDate(),
    h: new Date(wallUtc).getUTCHours(),
    min: new Date(wallUtc).getUTCMinutes(),
    s: new Date(wallUtc).getUTCSeconds(),
  };
}

export function dateKeyOf(timezone, atMs) {
  const p = wallParts(timezone, atMs);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

// 某时区下 dateKey 对应自然日 00:00 的 UTC 时刻
export function startOfDayUtc(timezone, dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  // 墙钟午夜 = UTC + offset → UTC = wallMidnight - offset。
  // 用当天中午先探一次偏移（避开 DST 切换日午夜的歧义），再按午夜时刻复核一次。
  const noon = Date.UTC(y, m - 1, d, 12, 0, 0);
  const offsetAtNoon = timezoneOffsetMinutes(timezone, noon);
  const midnightGuess = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetAtNoon * 60000;
  const offsetAtMidnight = timezoneOffsetMinutes(timezone, midnightGuess);
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offsetAtMidnight * 60000;
}

export function isValidDateKey(value) {
  if (!CALENDAR_DATE_KEY_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y
    && probe.getUTCMonth() === m - 1
    && probe.getUTCDate() === d;
}

// JS getDay()：0=周日 … 6=周六；转为数组下标 0=周一 … 6=周日
export function jsDayToWeekdayIndex(jsDay) {
  return (jsDay + 6) % 7;
}

// ---------------------------------------------------------------------------
// 配置校验与规范化
// ---------------------------------------------------------------------------

function parseMinuteValue(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return n;
}

// 校验单日工作时段；返回 { ok, value: [[startMin,endMin],...] 已排序去重叠 }
export function normalizeDayWindows(input) {
  if (input === undefined || input === null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, code: 'CALENDAR_WINDOWS_INVALID', message: '每日工作时段必须是时段数组' };
  const windows = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, code: 'CALENDAR_WINDOW_INVALID', message: '每个工作时段需包含开始与结束分钟数' };
    }
    const start = parseMinuteValue(raw.start ?? raw.startMinute ?? raw.from);
    const end = parseMinuteValue(raw.end ?? raw.endMinute ?? raw.to);
    if (start === null || end === null) {
      return { ok: false, code: 'CALENDAR_WINDOW_INVALID', message: '工作时段的开始、结束必须是整数分钟' };
    }
    if (start < CALENDAR_WINDOW_MIN_MINUTES || end > CALENDAR_WINDOW_MAX_MINUTES || start >= end) {
      return { ok: false, code: 'CALENDAR_WINDOW_INVALID', message: '工作时段需满足 0 ≤ 开始 < 结束 ≤ 1440' };
    }
    windows.push([start, end]);
  }
  windows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // 合并重叠/相接时段
  const merged = [];
  for (const [start, end] of windows) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return { ok: true, value: merged };
}

function parseDayMap(input, { field }) {
  const out = new Map();
  if (input === undefined || input === null) return { ok: true, value: out };
  if (Array.isArray(input)) {
    for (const item of input) {
      const date = String(item?.date || item?.dateKey || '').trim();
      if (!isValidDateKey(date)) {
        return { ok: false, code: 'CALENDAR_DATE_INVALID', message: `${field}中的日期必须是 YYYY-MM-DD` };
      }
      const label = field === '节假日'
        ? String(item?.name ?? item?.note ?? '').trim()
        : String(item?.note ?? item?.name ?? '').trim();
      out.set(date, label.slice(0, 100));
    }
    return { ok: true, value: out };
  }
  if (typeof input !== 'object') {
    return { ok: false, code: 'CALENDAR_DATE_INVALID', message: `${field}必须是日期清单` };
  }
  for (const [date, name] of Object.entries(input)) {
    if (!isValidDateKey(date)) {
      return { ok: false, code: 'CALENDAR_DATE_INVALID', message: `${field}中的日期必须是 YYYY-MM-DD` };
    }
    out.set(date, String(name || '').trim().slice(0, 100));
  }
  return { ok: true, value: out };
}

// 校验整份日历配置。input 形如：
// { timezone?, weeklyWindows?: [[{start,end}], x7], holidays?: [{date,name}],
//   closures?: [{date,note}] }
export function parseCalendarConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'CALENDAR_CONFIG_INVALID', message: '日历配置格式不正确' };
  }
  const timezone = String(input.timezone || CALENDAR_TIMEZONE_DEFAULT).trim();
  try {
    // 构造一个该时区的格式化器以提前暴露非法时区
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    return { ok: false, code: 'CALENDAR_TIMEZONE_INVALID', message: `不支持的时区：${timezone}` };
  }

  let weeklyInput = input.weeklyWindows;
  if (weeklyInput === undefined || weeklyInput === null) {
    // 默认：周一至周五 09:00-12:00、13:30-17:30，周末休息
    weeklyInput = DEFAULT_WEEKLY_WINDOWS;
  }
  if (!Array.isArray(weeklyInput) || weeklyInput.length !== CALENDAR_WEEKDAY_COUNT) {
    return { ok: false, code: 'CALENDAR_WINDOWS_INVALID', message: 'weeklyWindows 必须恰好包含 7 天（周一至周日）' };
  }
  const weeklyWindows = [];
  for (const dayInput of weeklyInput) {
    const parsed = normalizeDayWindows(dayInput);
    if (!parsed.ok) return parsed;
    weeklyWindows.push(parsed.value);
  }
  if (weeklyWindows.every((windows) => windows.length === 0)) {
    return { ok: false, code: 'CALENDAR_WINDOWS_EMPTY', message: '每周至少需要一个工作时段，否则任何异议都无法办结' };
  }

  const holidaysParsed = parseDayMap(input.holidays, { field: '节假日' });
  if (!holidaysParsed.ok) return holidaysParsed;
  const closuresParsed = parseDayMap(input.closures, { field: '临时停办日' });
  if (!closuresParsed.ok) return closuresParsed;

  return {
    ok: true,
    value: buildCalendar({ timezone, weeklyWindows, holidays: holidaysParsed.value, closures: closuresParsed.value }),
  };
}

const DEFAULT_WEEKLY_WINDOWS = [
  [{ start: 9 * 60, end: 12 * 60 }, { start: 13 * 60 + 30, end: 17 * 60 + 30 }], // 周一
  [{ start: 9 * 60, end: 12 * 60 }, { start: 13 * 60 + 30, end: 17 * 60 + 30 }],
  [{ start: 9 * 60, end: 12 * 60 }, { start: 13 * 60 + 30, end: 17 * 60 + 30 }],
  [{ start: 9 * 60, end: 12 * 60 }, { start: 13 * 60 + 30, end: 17 * 60 + 30 }],
  [{ start: 9 * 60, end: 12 * 60 }, { start: 13 * 60 + 30, end: 17 * 60 + 30 }], // 周五
  [], // 周六
  [], // 周日
];

// 构造规范化日历对象（内部使用；调用方应经 parseCalendarConfig 校验）
export function buildCalendar({ timezone, weeklyWindows, holidays, closures }) {
  const holidayMap = new Map(holidays instanceof Map ? holidays : Object.entries(holidays || {}));
  const closureMap = new Map(closures instanceof Map ? closures : Object.entries(closures || {}));
  return {
    timezone,
    weeklyWindows,
    holidays: holidayMap,
    closures: closureMap,
  };
}

// ---------------------------------------------------------------------------
// 当日日程解析：返回 [{startUtc,endUtc,kind}] —— 工作段与非工作段交替
// ---------------------------------------------------------------------------

// 某一自然日的类型与说明
function dayKind(calendar, dateKey, weekdayIndex) {
  if (calendar.closures.has(dateKey)) {
    return { kind: 'closure', reason: calendar.closures.get(dateKey) };
  }
  if (calendar.holidays.has(dateKey)) {
    return { kind: 'holiday', reason: calendar.holidays.get(dateKey) };
  }
  if (calendar.weeklyWindows[weekdayIndex].length === 0) {
    return { kind: 'weekend', reason: '' };
  }
  return { kind: 'work', reason: '' };
}

// 某天 00:00 起的时间轴分段（按墙钟分钟），每段标注 work / 非工作原因。
// weekday 由墙钟日期本身决定（不要用 UTC 的 getDay）。
function daySegments(calendar, dateKey, dayStartUtc) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const weekdayIndex = jsDayToWeekdayIndex(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  const meta = dayKind(calendar, dateKey, weekdayIndex);
  if (meta.kind !== 'work') {
    return [{
      startMin: 0, endMin: 24 * 60, working: false, kind: meta.kind, reason: meta.reason,
    }];
  }
  const segments = [];
  let cursor = 0;
  for (const [start, end] of calendar.weeklyWindows[weekdayIndex]) {
    if (start > cursor) {
      segments.push({ startMin: cursor, endMin: start, working: false, kind: 'overnight', reason: '' });
    }
    segments.push({ startMin: start, endMin: end, working: true, kind: 'work', reason: '' });
    cursor = end;
  }
  if (cursor < 24 * 60) {
    segments.push({ startMin: cursor, endMin: 24 * 60, working: false, kind: 'overnight', reason: '' });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// 核心：从 startAtMs 开始消耗 workingMinutes 个工作分钟
//
// 返回 { deadlineAt, segments: [{from,to,kind,reason}], consumedMinutes }
// startAtMs 落在非工作段时，该段（自 startAtMs 起）计入顺延；落在工作段时
// 从该时刻立即开始计时。连续同类型段会被合并，便于在详情中逐段说明。
// ---------------------------------------------------------------------------
export function advanceWorkingMinutes(calendar, startAtMs, workingMinutes, { maxDays = 3660 } = {}) {
  if (!Number.isFinite(workingMinutes) || workingMinutes < 0) {
    throw new Error('workingMinutes 必须是非负数字');
  }
  let remaining = Math.round(workingMinutes);
  let cursor = startAtMs;
  const rawSegments = [];

  // 落在段中间开始：把当前段拆成“cursor 起”的部分
  const pushSegment = (from, to, segment) => {
    if (to <= from) return;
    rawSegments.push({ from, to, kind: segment.kind, reason: segment.reason, working: segment.working });
  };

  // 从 cursor 当天起逐日扫描；当天用游标在分段中的位置裁剪
  let dateKey = dateKeyOf(calendar.timezone, cursor);
  let dayStart = startOfDayUtc(calendar.timezone, dateKey);

  for (let daysScanned = 0; daysScanned <= maxDays; daysScanned += 1) {
    const segments = daySegments(calendar, dateKey, dayStart);
    for (const seg of segments) {
      const segStart = dayStart + seg.startMin * 60000;
      const segEnd = dayStart + seg.endMin * 60000;
      if (segEnd <= cursor) continue;   // 当天早于游标的段（含整段已过）
      const enterAt = Math.max(cursor, segStart);
      if (remaining === 0) break;

      if (seg.working) {
        const available = (segEnd - enterAt) / 60000;
        const take = Math.min(available, remaining);
        pushSegment(enterAt, enterAt + take * 60000, seg);
        cursor = enterAt + take * 60000;
        remaining -= take;
      } else {
        pushSegment(enterAt, segEnd, seg);
        cursor = segEnd;
      }
    }
    if (remaining === 0) break;
    if (daysScanned === maxDays) {
      throw new Error('在限定天数内找不到足够的工作时间，请检查日历配置');
    }
    const nextDayStart = dayStart + 24 * 3600000;
    dateKey = dateKeyOf(calendar.timezone, nextDayStart);
    dayStart = startOfDayUtc(calendar.timezone, dateKey);
  }

  const segmentsOut = mergeSegments(rawSegments).map((seg) => ({
    from: seg.from,
    to: seg.to,
    kind: seg.kind,
    working: seg.working,
    reason: describeSegment(seg),
  }));
  return {
    deadlineAt: cursor,
    consumedMinutes: Math.round(workingMinutes),
    segments: segmentsOut,
  };
}

function mergeSegments(raw) {
  const out = [];
  for (const seg of raw) {
    const last = out[out.length - 1];
    if (last && last.to === seg.from && last.kind === seg.kind && last.reason === seg.reason) {
      last.to = seg.to;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

// 每段顺延的人类可读原因（详情页逐段展示）
function describeSegment(seg) {
  if (seg.kind === 'work') return CALENDAR_LABELS.work;
  if (seg.kind === 'closure') {
    return `${CALENDAR_LABELS.closure}${seg.reason ? `：${seg.reason}` : ''}`;
  }
  if (seg.kind === 'holiday') {
    return `${CALENDAR_LABELS.holiday}${seg.reason ? `（${seg.reason}）` : ''}`;
  }
  if (seg.kind === 'weekend') return CALENDAR_LABELS.weekend;
  return CALENDAR_LABELS.overnight;
}

// 计算 [from,to] 在指定日历内包含的工作分钟（用于暂停时计算已耗时长）
export function workingMinutesBetween(calendar, fromMs, toMs) {
  if (toMs <= fromMs) return 0;
  let total = 0;
  let dateKey = dateKeyOf(calendar.timezone, fromMs);
  const endDateKey = dateKeyOf(calendar.timezone, toMs);
  let guard = 0;
  for (;;) {
    guard += 1;
    if (guard > 3660) throw new Error('时间跨度过大');
    const dayStart = startOfDayUtc(calendar.timezone, dateKey);
    const segments = daySegments(calendar, dateKey, dayStart);
    for (const seg of segments) {
      if (!seg.working) continue;
      const segStart = dayStart + seg.startMin * 60000;
      const segEnd = dayStart + seg.endMin * 60000;
      const overlapStart = Math.max(fromMs, segStart);
      const overlapEnd = Math.min(toMs, segEnd);
      if (overlapEnd > overlapStart) total += (overlapEnd - overlapStart) / 60000;
    }
    if (dateKey === endDateKey) break;
    const nextDayStart = dayStart + 24 * 3600000;
    dateKey = dateKeyOf(calendar.timezone, nextDayStart);
  }
  return Math.round(total);
}

// ---------------------------------------------------------------------------
// 序列化 / 反序列化（供持久化层保存 content_json 与读取时还原 Map）
// ---------------------------------------------------------------------------
export function serializeCalendar(calendar) {
  return JSON.stringify({
    timezone: calendar.timezone,
    weeklyWindows: calendar.weeklyWindows,
    holidays: [...calendar.holidays.entries()].map(([date, name]) => ({ date, name })),
    closures: [...calendar.closures.entries()].map(([date, note]) => ({ date, note })),
  });
}

export function deserializeCalendar(jsonText) {
  const raw = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
  return buildCalendar({
    timezone: raw.timezone,
    weeklyWindows: raw.weeklyWindows,
    holidays: new Map((raw.holidays || []).map((item) => [item.date, item.name || ''])),
    closures: new Map((raw.closures || []).map((item) => [item.date, item.note || ''])),
  });
}
