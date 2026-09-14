import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceWorkingMinutes,
  dateKeyOf,
  parseCalendarConfig,
  serializeCalendar,
  deserializeCalendar,
  workingMinutesBetween,
} from '../src/workingCalendars.js';

// 纯算术：跨周末 / 临时停办 / 节假日 / 工作时段外顺延
describe('工作日历纯算术', () => {
  const cal = parseCalendarConfig({}).value;

  test('跨周末：周五傍晚发起，截止顺延到周一工作时段，逐段给出周末顺延原因', () => {
    // 2026-09-11 周五 17:00 +08，剩余 60 工作分钟
    const fri17 = Date.UTC(2026, 8, 11, 9, 0);
    const r = advanceWorkingMinutes(cal, fri17, 60);
    // 周五 17:00-17:30 消耗 30，周六周日跳过，周一 09:00-09:30 再消耗 30
    assert.equal(r.deadlineAt, Date.UTC(2026, 8, 14, 1, 30));
    const reasons = r.segments.filter((s) => !s.working).map((s) => s.reason);
    assert.ok(reasons.includes('周末休息'));
    const workTotal = r.segments.filter((s) => s.working)
      .reduce((sum, s) => sum + (s.to - s.from) / 60000, 0);
    assert.equal(workTotal, 60);
  });

  test('工作时段外：中午发起先顺延到午休结束，当天内完成', () => {
    // 周三 12:30 +08，120 分钟 → 13:30-15:30
    const wed1230 = Date.UTC(2026, 8, 9, 4, 30);
    const r = advanceWorkingMinutes(cal, wed1230, 120);
    assert.equal(r.deadlineAt, Date.UTC(2026, 8, 9, 7, 30));
    assert.ok(r.segments[0].reason.includes('非工作时段'));
  });

  test('临时停办日整天顺延并保留停办说明', () => {
    const cal2 = parseCalendarConfig({
      closures: [{ date: '2026-09-14', note: '系统升级，全天停办' }],
    }).value;
    // 周五 17:00 + 60 分钟：30 当天 + 周一停办跳过 → 周二 09:30
    const r = advanceWorkingMinutes(cal2, Date.UTC(2026, 8, 11, 9, 0), 60);
    assert.equal(r.deadlineAt, Date.UTC(2026, 8, 15, 1, 30));
    const closure = r.segments.find((s) => s.kind === 'closure');
    assert.ok(closure);
    assert.ok(closure.reason.includes('系统升级，全天停办'));
  });

  test('法定节假日顺延并在原因中体现节日名称', () => {
    const cal3 = parseCalendarConfig({
      holidays: [{ date: '2026-09-16', name: '中秋节' }],
    }).value;
    // 周二 17:00 + 60 → 30 周二 + 周三节日跳过 → 周四 09:30
    const r = advanceWorkingMinutes(cal3, Date.UTC(2026, 8, 15, 9, 0), 60);
    assert.equal(r.deadlineAt, Date.UTC(2026, 8, 17, 1, 30));
    assert.ok(r.segments.find((s) => s.reason.includes('中秋节')));
  });

  test('workingMinutesBetween 只计算工作时间（跨周末）', () => {
    const fri17 = Date.UTC(2026, 8, 11, 9, 0);
    const mon10 = Date.UTC(2026, 8, 14, 2, 0);
    // 周五 17:00-17:30 = 30 + 周一 09:00-10:00 = 60 → 90
    assert.equal(workingMinutesBetween(cal, fri17, mon10), 90);
  });

  test('序列化往返保留节假日与停办配置', () => {
    const cal4 = parseCalendarConfig({
      holidays: [{ date: '2026-09-16', name: '中秋' }],
      closures: [{ date: '2026-09-14', note: '停办' }],
    }).value;
    const back = deserializeCalendar(serializeCalendar(cal4));
    const r = advanceWorkingMinutes(back, Date.UTC(2026, 8, 11, 9, 0), 60);
    assert.equal(r.deadlineAt, Date.UTC(2026, 8, 15, 1, 30));
    assert.ok(r.segments.find((s) => s.kind === 'closure' && s.reason.includes('停办')));
  });

  test('节假日 + 停办日叠加时全部顺延', () => {
    const cal5 = parseCalendarConfig({
      holidays: [{ date: '2026-09-15', name: '中秋调休' }],
      closures: [{ date: '2026-09-14', note: '停办' }],
    }).value;
    // 周五 17:00 + 60 → 30 周五；周一停办、周二节假日 → 周三 09:30
    const r = advanceWorkingMinutes(cal5, Date.UTC(2026, 8, 11, 9, 0), 60);
    assert.equal(r.deadlineAt, Date.UTC(2026, 8, 16, 1, 30));
    assert.ok(r.segments.find((s) => s.reason.includes('中秋调休')));
    assert.ok(r.segments.find((s) => s.reason.includes('停办')));
  });

  test('日期键按上海时区切分：UTC 16:00 已属次日', () => {
    assert.equal(dateKeyOf('Asia/Shanghai', Date.UTC(2026, 8, 8, 16, 0)), '2026-09-09');
  });

  test('非法配置明确拒绝：空时区 / 七天全休 / 错误时段', () => {
    assert.equal(parseCalendarConfig({ timezone: 'Not/AZone' }).ok, false);
    assert.equal(parseCalendarConfig({ weeklyWindows: Array.from({ length: 7 }, () => []) }).ok, false);
    assert.equal(parseCalendarConfig({
      weeklyWindows: [
        [{ start: 1200, end: 600 }],
        ...Array.from({ length: 6 }, () => []),
      ],
    }).ok, false);
  });
});
