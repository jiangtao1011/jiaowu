import { db } from './db.js';

// 去掉分层课科目尾部的「A层/B层/…」，得到基准学科用于系数查表
export function baseSubject(subject) {
  if (!subject) return '';
  return subject.replace(/[A-Za-z0-9一二三四五六七八九十]+层$/, '').trim();
}

// 解析教师课酬标准 JSON（按原始字符串缓存）
const payStdCache = new Map();
export function parsePayStandard(raw) {
  const key = raw ?? '';
  if (payStdCache.has(key)) return payStdCache.get(key);
  let p = {};
  try { p = JSON.parse(raw || '{}') || {}; } catch { p = {}; }
  payStdCache.set(key, p);
  return p;
}

// 统一的课酬折算：根据 r 的 period_type / term / subject / class_id 计算。
// r 需含 { period_type, term, subject, class_id, pay_standard, count }；count 缺省 1。
// 返回 { weighted, pay }，已含 count 乘数。供 stats.js（按日）与 schedules.js（课表）共用。
export function computePay(ctx, r) {
  const count = r.count ?? 1;
  const subj = baseSubject(r.subject);
  const size = ctx.effSize(r.class_id);
  const subjCoef = ctx.subjCoef.get(subj) ?? 1.0;
  const sizeCoef = ctx.sizeCoefOf(size);

  if (r.period_type === '早自习') {
    // 早自习：折算课时 = 节数 × 早自习系数，无课酬
    return { weighted: count * (ctx.periodSettings.early_coefficient ?? 0.5), pay: 0 };
  }
  if (ctx.periodTypePays.has(r.period_type)) {
    // 按次计酬类型（晚自习/答疑/晚练/自定义）：折算 0，课酬 = 单价 × 节数
    return { weighted: 0, pay: count * (ctx.periodTypePays.get(r.period_type) ?? 0) };
  }
  if (r.term !== '常规') {
    // 非规时段（夏/冬令营等）：折算 = 节数，课酬 = 节数 × 教师课酬标准
    const p = parsePayStandard(r.pay_standard);
    return { weighted: count, pay: count * (Number(p[r.term]) || 0) };
  }
  // 常规正课：折算 = 节数 ×（课时系数 + 班额系数）
  return { weighted: count * (subjCoef + sizeCoef), pay: 0 };
}

// 加载班级层级 + 系数表，供课表展示与统计共用
export function loadContext() {
  const classMap = new Map(
    db.prepare('SELECT id, type, parent_id, student_count, subject FROM classes').all()
      .map((c) => [c.id, c])
  );
  const memberSize = new Map();
  for (const m of db.prepare(
    'SELECT cm.class_id, c.student_count FROM class_members cm JOIN classes c ON c.id = cm.member_class_id'
  ).all()) {
    memberSize.set(m.class_id, (memberSize.get(m.class_id) || 0) + (m.student_count || 0));
  }
  const subjCoef = new Map(
    db.prepare('SELECT subject, coefficient FROM subject_coefficients').all()
      .map((r) => [r.subject, r.coefficient])
  );
  const sizeBands = db.prepare('SELECT min_size, coefficient FROM size_bands ORDER BY min_size DESC').all();
  const periodSettings = {};
  for (const p of db.prepare('SELECT key, value FROM period_settings').all()) periodSettings[p.key] = p.value;
  // 按次计酬类型字典：类型名 -> 固定课酬单价
  const periodTypePays = new Map(
    db.prepare('SELECT name, pay FROM period_type_pays').all()
      .map((r) => [r.name, r.pay])
  );

  return {
    classMap,
    subjCoef,
    sizeBands,
    periodSettings,
    periodTypePays,
    // 统计班额：走班默认=合班成员班额之和，若手动填了人数（student_count>0）则以手动值为准；其余=自身班额
    effSize(cid) {
      const c = classMap.get(cid);
      if (!c) return 0;
      if (c.type === '走班') {
        return c.student_count > 0 ? c.student_count : (memberSize.get(cid) || 0);
      }
      return c.student_count || 0;
    },
    sizeCoefOf(size) {
      for (const b of sizeBands) if (size >= b.min_size) return b.coefficient;
      return 1.0;
    },
    // 上课形式（四种）：行政班 / 分层（行政班分层）/ 走班（合班）/ 走班分层
    formOf(cls) {
      if (!cls) return '行政班';
      if (cls.type === '走班') return '走班';
      if (cls.type === '分层') {
        const p = cls.parent_id ? classMap.get(cls.parent_id) : null;
        return p && p.type === '走班' ? '走班分层' : '分层';
      }
      return '行政班';
    },
  };
}
