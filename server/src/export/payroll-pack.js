// 财务审核包导出器：以官方模板《课酬课时统计_模板包.xlsx》为底稿，
// 读入 → 填值 → 动态调整引用范围 → 写回。
// 输出 16 张表（过程表 00~11 + 审核层 12~15），保留模板的颜色/公式/合并单元格/列宽。
//
// 审核层（12 财务汇总表 / 13 课酬明细 / 14 勾稽校验 / 15 口径参数）是财务真正读取的交付物，
// 与 /financial-check 口径一致：明细逐条课酬之和 == 汇总表课酬合计。
// 过程表（01~09）按系统 lesson_instances 尽力回填，10/11 由模板 SUMIF 公式自动取数。

import ExcelJS from 'exceljs';
import { fileURLToPath } from 'url';
import path from 'path';
import { computePay } from '../context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', '课酬课时统计_模板包.xlsx');

const round1 = (v) => Math.round((Number(v) || 0) * 10) / 10;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function fmtDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function dowOf(dateStr) { const d = new Date(`${dateStr}T00:00:00`); return d.getDay() === 0 ? 7 : d.getDay(); }
function dateRange(from, to) {
  const out = [];
  const c = new Date(`${from}T00:00:00`);
  const e = new Date(`${to}T00:00:00`);
  while (c <= e) { out.push(fmtDate(c)); c.setDate(c.getDate() + 1); }
  return out;
}
function colIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
function colName(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
// Excel 日期序列号（1900 日期系统），供写入真日期单元格
function excelDateNum(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return Math.round((d.getTime() / 86400000) + 25569);
}
// 构造「该日期的 UTC 零点」Date，exceljs 序列化时 getTime() 才等于当日 00:00（避免本地时区偏移一天）
function utcDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// 12 财务汇总表列映射（模板固定 45 列：A序号 B姓名 C~AP 各类型节数/金额/折算，AQ折算合计 AR课酬合计 AS备注）
// kind: core=常规正课 / coef=折算类型(不计钱) / type=按次计酬(计钱) / term=非规时段(计钱)
const SHEET12_COLS = [
  { col: 'C', kind: 'core', field: 'count' }, { col: 'D', kind: 'core', field: 'weighted' },
  { col: 'E', kind: 'coef', name: '早自习', field: 'count' }, { col: 'F', kind: 'coef', name: '早自习', field: 'weighted' },
  { col: 'G', kind: 'coef', name: '竞赛', field: 'count' }, { col: 'H', kind: 'coef', name: '竞赛', field: 'weighted' },
  { col: 'I', kind: 'coef', name: '培优', field: 'count' }, { col: 'J', kind: 'coef', name: '培优', field: 'weighted' },
  { col: 'K', kind: 'coef', name: '监考·标准', field: 'count' }, { col: 'L', kind: 'coef', name: '监考·标准', field: 'weighted' },
  { col: 'M', kind: 'coef', name: '监考·加时', field: 'count' }, { col: 'N', kind: 'coef', name: '监考·加时', field: 'weighted' },
  { col: 'O', kind: 'coef', name: '监考·长时', field: 'count' }, { col: 'P', kind: 'coef', name: '监考·长时', field: 'weighted' },
  { col: 'Q', kind: 'type', name: '晚自习', field: 'count' }, { col: 'R', kind: 'type', name: '晚自习', field: 'pay' },
  { col: 'S', kind: 'type', name: '答疑', field: 'count' }, { col: 'T', kind: 'type', name: '答疑', field: 'pay' },
  { col: 'U', kind: 'type', name: '晚练', field: 'count' }, { col: 'V', kind: 'type', name: '晚练', field: 'pay' },
  { col: 'W', kind: 'type', name: '晚晚练', field: 'count' }, { col: 'X', kind: 'type', name: '晚晚练', field: 'pay' },
  { col: 'Y', kind: 'type', name: '一对一', field: 'count' }, { col: 'Z', kind: 'type', name: '一对一', field: 'pay' },
  { col: 'AA', kind: 'type', name: '一对二', field: 'count' }, { col: 'AB', kind: 'type', name: '一对二', field: 'pay' },
  { col: 'AC', kind: 'type', name: '一对多', field: 'count' }, { col: 'AD', kind: 'type', name: '一对多', field: 'pay' },
  { col: 'AE', kind: 'type', name: '午练', field: 'count' }, { col: 'AF', kind: 'type', name: '午练', field: 'pay' },
  { col: 'AG', kind: 'term', name: '夏令营', field: 'count' }, { col: 'AH', kind: 'term', name: '夏令营', field: 'pay' },
  { col: 'AI', kind: 'term', name: '冬令营', field: 'count' }, { col: 'AJ', kind: 'term', name: '冬令营', field: 'pay' },
  { col: 'AK', kind: 'term', name: '全员夏令营', field: 'count' }, { col: 'AL', kind: 'term', name: '全员夏令营', field: 'pay' },
  { col: 'AM', kind: 'term', name: '全员冬令营', field: 'count' }, { col: 'AN', kind: 'term', name: '全员冬令营', field: 'pay' },
  { col: 'AO', kind: 'term', name: '节假补课', field: 'count' }, { col: 'AP', kind: 'term', name: '节假补课', field: 'pay' },
];

function sheet12Value(e, col) {
  if (col.kind === 'core') return col.field === 'count' ? e.core_count : round2(e.core_weighted);
  if (col.kind === 'coef') return col.field === 'count' ? (e.coefCounts[col.name] || 0) : round2(e.coefWeighted[col.name]);
  if (col.kind === 'type') return col.field === 'count' ? (e.typeCounts[col.name] || 0) : round2(e.typePays[col.name]);
  if (col.kind === 'term') return col.field === 'count' ? (e.termCounts[col.name] || 0) : round2(e.termPays[col.name]);
  return 0;
}

// 从 rows 反推教师详情（年级 / 任教班级 / 任教学科）
function buildTeacherInfo(rows) {
  const info = new Map();
  for (const r of rows) {
    if (r.cancelled) continue;
    if (!info.has(r.teacher_id)) {
      info.set(r.teacher_id, { grades: new Set(), classes: [], classSet: new Set(), subjects: new Set() });
    }
    const t = info.get(r.teacher_id);
    if (r.class_grade) t.grades.add(r.class_grade);
    if (r.class_name && !/年级$/.test(r.class_name) && !/级部$/.test(r.class_name) && !t.classSet.has(r.class_name)) {
      t.classSet.add(r.class_name); t.classes.push(r.class_name);
    }
    if (r.subject) t.subjects.add(r.subject);
  }
  for (const t of info.values()) {
    t.grades = [...t.grades].sort(); t.subjects = [...t.subjects].sort();
  }
  return info;
}

// 主入口：返回 xlsx Buffer
export async function buildPayrollPack({ rows, allRows, ctx, fin, fromDate, toDate, term, userName }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE_PATH);

  const teacherInfo = buildTeacherInfo(rows);
  const teachers = fin.teachers; // 已按姓名排序、仅计酬教师

  fillSheet00(wb, { fromDate, toDate, term, userName });
  fillSheet01(wb, { teachers, teacherInfo });
  fillSheet02(wb, { rows, teachers, teacherInfo, ctx });
  fillSheet03(wb, { rows, teachers, teacherInfo, ctx, fromDate, toDate });
  fillSheet04(wb, { rows, teachers, teacherInfo, ctx, fromDate, toDate });
  fillSheet06(wb, { rows, teachers, teacherInfo });
  fillSheet05(wb, { rows, teachers, teacherInfo, fromDate, toDate });
  const jkLastRow = fillSheet07(wb, { rows }).lastRow; // 07 明细区最后一行（含合计）
  fillSheet08(wb, { rows, ctx });
  fillSheet09(wb, { rows, ctx });
  fillSheet10(wb, { rows, teachers, ctx, jkLastRow });
  fillSheet11(wb, { teachers });
  const sumTotRow = fillSheet12(wb, { teachers, fin });
  fillSheet13(wb, { allRows, ctx });
  fillSheet14(wb, { allRows, teachers, fin, sumTotRow });
  fillSheet15(wb, { ctx });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// 把二维数组写入某 sheet 的锚定区域
function writeRows(ws, startRow, startColLetters, dataRows) {
  const sc = colIndex(startColLetters);
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    for (let j = 0; j < row.length; j++) ws.getCell(startRow + i, sc + j).value = row[j];
  }
}

// 清空区间（保样式）
function clearRange(ws, r1, c1, r2, c2) {
  const c1n = typeof c1 === 'string' ? colIndex(c1) : c1;
  const c2n = typeof c2 === 'string' ? colIndex(c2) : c2;
  for (let r = r1; r <= r2; r++) for (let c = c1n; c <= c2n; c++) ws.getCell(r, c).value = null;
}

// 从 srcRow 复制单元格级样式（边框/填充/字体/对齐/数字格式）到 dstRow 的指定列区间。
// exceljs insertRows 只复制行样式，单元格级边框/填充会丢，插入明细行后必须手动补。
function copyRowStyle(ws, srcRow, dstRow, c1, c2) {
  const c1n = typeof c1 === 'string' ? colIndex(c1) : c1;
  const c2n = typeof c2 === 'string' ? colIndex(c2) : c2;
  for (let c = c1n; c <= c2n; c++) {
    const s = ws.getCell(srcRow, c);
    const d = ws.getCell(dstRow, c);
    d.border = { ...s.border };
    d.fill = { ...s.fill };
    d.font = { ...s.font };
    d.alignment = { ...s.alignment };
    d.numFmt = s.numFmt;
  }
}

// ===== 00 填写说明 =====
function fillSheet00(wb, { fromDate, toDate, term, userName }) {
  const ws = wb.getWorksheet('00_填写说明');
  for (let r = 1; r <= ws.rowCount; r++) {
    for (let c = 1; c <= ws.columnCount; c++) {
      const v = ws.getCell(r, c).value;
      if (typeof v === 'string' && v.includes('统计区间')) {
        ws.getCell(r, c + 1).value = `${fromDate} ~ ${toDate}${term ? '（时段：' + term + '）' : ''}`;
      }
      if (typeof v === 'string' && v.trim() === '填表人') {
        ws.getCell(r, c + 1).value = userName || '';
      }
    }
  }
}

// ===== 01 基础名单与系数：A姓名 B年级 C任教班级 D任教学科（数据区 R4 起） =====
function fillSheet01(wb, { teachers, teacherInfo }) {
  const ws = wb.getWorksheet('01_基础名单与系数');
  const dataRows = teachers.map((e) => {
    const info = teacherInfo.get(e.teacher_id) || { grades: [], classes: [], subjects: [] };
    return [e.teacher_name, info.grades.join('/'), info.classes.join('/'), info.subjects.join('/')];
  });
  writeRows(ws, 4, 'A', dataRows);
}

// ===== 02 普通课时统计：B年级 C任教班级 D任教学科；正课按「班级」拆到 E/G/I/K 四组节数，
//       F/H/J/L 填对应班级的加权系数（=该班折算课时÷该班节数），使 M=E*F+G*H+I*J+K*L = 总折算课时。
//       超过 4 个班的教师，第 5 个班起并入 K/L 组（节数累加、系数按折算÷总节数重算）。 =====
function fillSheet02(wb, { rows, teachers, teacherInfo, ctx }) {
  const ws = wb.getWorksheet('02_普通课时统计');
  // 每教师每个班级的「常规正课」节数与折算课时
  const byClass = new Map(); // teacher_id -> [{ cn, count, weighted }]
  for (const r of rows) {
    if (r.cancelled) continue;
    if (r.term !== '常规' || r.period_type !== '正课') continue;
    if (!byClass.has(r.teacher_id)) byClass.set(r.teacher_id, []);
    const arr = byClass.get(r.teacher_id);
    let c = arr.find((x) => x.cn === r.class_name);
    if (!c) { c = { cn: r.class_name, count: 0, weighted: 0 }; arr.push(c); }
    const { weighted } = computePay(ctx, { ...r, count: r.unit_count ?? 1 });
    c.count = round1(c.count + (r.unit_count ?? 1));
    c.weighted = round2(c.weighted + weighted);
  }

  for (let i = 0; i < teachers.length; i++) {
    const rowIdx = 4 + i;
    const e = teachers[i];
    const info = teacherInfo.get(e.teacher_id) || { grades: [], classes: [], subjects: [] };
    const arr = byClass.get(e.teacher_id) || [];
    // 稳定排序：按节数降序，节数相同按班名
    arr.sort((a, b) => (b.count - a.count) || a.cn.localeCompare(b.cn, 'zh'));

    ws.getCell(rowIdx, 1).value = e.teacher_name;          // A
    ws.getCell(rowIdx, 2).value = info.grades.join('/');    // B 年级
    ws.getCell(rowIdx, 3).value = info.classes.join('/');   // C 任教班级
    ws.getCell(rowIdx, 4).value = info.subjects.join('/');  // D 任教学科

    // 4 组：E/G/I/K=节数，F/H/J/L=系数
    const groups = [{ count: 0, weighted: 0 }, { count: 0, weighted: 0 }, { count: 0, weighted: 0 }, { count: 0, weighted: 0 }];
    arr.forEach((c, idx) => {
      const g = groups[Math.min(idx, 3)];
      g.count = round1(g.count + c.count);
      g.weighted = round2(g.weighted + c.weighted);
    });
    const cntCols = [5, 7, 9, 11];   // E,G,I,K
    const coefCols = [6, 8, 10, 12]; // F,H,J,L
    for (let gi = 0; gi < 4; gi++) {
      const g = groups[gi];
      if (g.count > 0) {
        ws.getCell(rowIdx, cntCols[gi]).value = g.count;
        ws.getCell(rowIdx, coefCols[gi]).value = round2(g.weighted / g.count);
      } else {
        ws.getCell(rowIdx, cntCols[gi]).value = null;
        ws.getCell(rowIdx, coefCols[gi]).value = null;
      }
    }
  }
}

// ===== 03 早午晚：逐日打点矩阵。模板每日占 4 列（早读/午练/晚读/晚晚读），28 天 = D~DK（列4~115）。
//      日期写 R2（每 4 列的第 1 列），R4 是「早读/午练/晚读/晚晚读」分组标题，数据区 R5 起。
//      有记录打点 1（unit_count 累计），汇总列 DN~EA 由模板公式自动求和。
//      早读=早自习，晚读=晚练，晚晚读=晚晚练，午练=午练（计酬类型但按次）。 =====
function fillSheet03(wb, { rows, teachers, teacherInfo, ctx, fromDate, toDate }) {
  const ws = wb.getWorksheet('03_早午晚');
  const days = dateRange(fromDate, toDate);
  // 模板预置 28 天（D 列起，每 4 列一天）。本期 ≤28 天可直接覆盖；超 28 天则超出部分无法容纳，截断并告警由调用方处理。
  const MAX_DAYS = 28;
  const PER_DAY = 4; // 早读/午练/晚读/晚晚读
  const START_COL = 4; // D

  // 1) 写星期行（R1）+ 日期行（R2）
  const DOW_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  for (let di = 0; di < days.length && di < MAX_DAYS; di++) {
    const col = START_COL + di * PER_DAY;
    const cell = ws.getCell(2, col);
    cell.value = utcDate(days[di]);
    cell.numFmt = 'yyyy-mm-dd';
    // R1 星期几（模板是「星期」占位，成品填实际星期几）
    ws.getCell(1, col).value = DOW_NAMES[dowOf(days[di])];
  }

  // 2) 按「教师 × 日期 × 时段」聚合成打点次数
  //    slot: 0=早读(早自习) 1=午练 2=晚读(晚练) 3=晚晚读(晚晚练)
  const slotOf = { '早自习': 0, '午练': 1, '晚练': 2, '晚晚练': 3 };
  const dot = new Map(); // `${tid}|${date}|${slot}` -> count
  for (const r of rows) {
    if (r.cancelled) continue;
    const slot = slotOf[r.period_type];
    if (slot == null) continue;
    const key = `${r.teacher_id}|${r.date}|${slot}`;
    dot.set(key, (dot.get(key) || 0) + (r.unit_count ?? 1));
  }

  // 3) 填教师行
  for (let i = 0; i < teachers.length; i++) {
    const rowIdx = 5 + i;
    const e = teachers[i];
    const info = teacherInfo.get(e.teacher_id) || { grades: [], subjects: [] };
    ws.getCell(rowIdx, 1).value = e.teacher_name;
    ws.getCell(rowIdx, 2).value = info.grades.join('/');
    ws.getCell(rowIdx, 3).value = info.subjects.join('/');
    // 汇总区 DM 姓名列必须与 A 列一致，否则 10/11 表 SUMIF 引用 A 列而 DM 显示旧名单，明细与汇总对不上
    ws.getCell(rowIdx, 117).value = e.teacher_name; // DM 姓名
    // 打点区
    for (let di = 0; di < days.length && di < MAX_DAYS; di++) {
      for (let s = 0; s < PER_DAY; s++) {
        const key = `${e.teacher_id}|${days[di]}|${s}`;
        const c = dot.get(key);
        if (c) ws.getCell(rowIdx, START_COL + di * PER_DAY + s).value = c;
      }
    }
  }

  // 清空超出实际教师数的预置数据行（模板预置 R5~R61 = 57 行）
  const lastDataRow = 4 + teachers.length; // 最后数据行 = R(4+n)
  const TPL_END = 61; // 模板预置最后一行
  if (lastDataRow < TPL_END) {
    for (let r = lastDataRow + 1; r <= TPL_END; r++) {
      ws.getCell(r, 1).value = null;   // A 姓名
      ws.getCell(r, 2).value = null;   // B 年级
      ws.getCell(r, 3).value = null;   // C 学科
      ws.getCell(r, 117).value = null; // DM 姓名
      ws.getCell(r, 119).value = null; // DO 早读课时数
      ws.getCell(r, 122).value = null; // DR 午练课时数
      ws.getCell(r, 126).value = null; // DV 晚练单价
      ws.getCell(r, 129).value = null; // DY 晚晚练单价
      ws.getCell(r, 131).value = null; // EA 总金额
    }
  }

  // 4) 参数列：早读课时数 DO=119，午练课时数 DR=122（午练按次计酬不计课时），晚练/晚晚练单价 DV=126/DY=129
  for (let i = 0; i < teachers.length; i++) {
    const rowIdx = 5 + i;
    ws.getCell(rowIdx, 119).value = ctx.periodTypeCoefs.get('早自习') ?? 0.5; // DO 早读课时数
    ws.getCell(rowIdx, 122).value = 0;                                          // DR 午练课时数（不计课时）
    ws.getCell(rowIdx, 126).value = ctx.periodTypePays.get('晚练') ?? 0;        // DV 晚练单价
    ws.getCell(rowIdx, 129).value = ctx.periodTypePays.get('晚晚练') ?? 0;      // DY 晚晚练单价
    // EA 总金额 = 晚练(DW) + 晚晚练(DZ) + 午练金额(DQ×午练单价)。模板原公式漏了午练，这里覆盖补上。
    const noonPay = ctx.periodTypePays.get('午练') ?? 0;
    ws.getCell(rowIdx, 131).value = { formula: `SUM(DW${rowIdx},DZ${rowIdx},DQ${rowIdx}*'15_口径参数'!$C$${14})` };
    // EA 列名补「含午练」，与 11 表 B 列「午练+晚练+晚晚练」名实相符
    ws.getCell(1, 131).value = '总金额/元(含午练)';
  }
}

// ===== 04 坐班答疑：逐日档位打点。D~AE=28 天（每列一天），日期写 R1，档位 1/2/3 填数据行 R4+。
//      档位映射：答疑·高一=100→1，答疑·其他=150→2，晚自习=180→3。
//      同日第 2 场：向右加补录列 AI~AM（5 列），AF 合计公式 COUNTIF 扩到含补录区。 =====
function fillSheet04(wb, { rows, teachers, teacherInfo, ctx, fromDate, toDate }) {
  const ws = wb.getWorksheet('04_坐班答疑');
  const days = dateRange(fromDate, toDate);
  const MAX_DAYS = 28;
  const START_COL = 4; // D

  // 档位：单价 → 档位
  const tierOf = (pay) => (pay === 100 ? 1 : pay === 150 ? 2 : pay === 180 ? 3 : 2);

  // 1) 日期行 R1
  for (let di = 0; di < days.length && di < MAX_DAYS; di++) {
    const cell = ws.getCell(1, START_COL + di);
    cell.value = utcDate(days[di]);
    cell.numFmt = 'yyyy-mm-dd';
  }

  // 2) 按「教师 × 日期」收集答疑/晚自习场次（含档位）
  const per = new Map(); // teacher_id -> [{ date, tier }]
  for (const r of rows) {
    if (r.cancelled) continue;
    if (r.period_type !== '答疑' && r.period_type !== '晚自习') continue;
    const pay = ctx.gradePayOf(r.period_type, r.class_grade) ?? ctx.periodTypePays.get(r.period_type) ?? 0;
    const tier = tierOf(pay);
    const unit = r.unit_count ?? 1;
    if (!per.has(r.teacher_id)) per.set(r.teacher_id, []);
    for (let u = 0; u < unit; u++) per.get(r.teacher_id).push({ date: r.date, tier });
  }

  // 3) 填数据行
  for (let i = 0; i < teachers.length; i++) {
    const rowIdx = 4 + i;
    const e = teachers[i];
    const info = teacherInfo.get(e.teacher_id) || { grades: [], subjects: [] };
    ws.getCell(rowIdx, 1).value = e.teacher_name;
    ws.getCell(rowIdx, 2).value = info.grades.join('/');
    ws.getCell(rowIdx, 3).value = info.subjects.join('/');

    const list = per.get(e.teacher_id) || [];
    const dayIdx = {}; // date -> 该日期已用场次
    const extras = []; // 同日第 2 场起的档位
    for (const it of list) {
      const di = days.indexOf(it.date);
      if (di < 0 || di >= MAX_DAYS) continue;
      const used = dayIdx[it.date] || 0;
      if (used === 0) {
        ws.getCell(rowIdx, START_COL + di).value = it.tier; // 主列
        dayIdx[it.date] = 1;
      } else {
        extras.push(it.tier); // 同日第 2 场 → 补录区
      }
    }
    // 补录区 AI~AM（列 35~39）
    const EXTRA_COLS = 5;
    for (let k = 0; k < extras.length && k < EXTRA_COLS; k++) {
      ws.getCell(rowIdx, 35 + k).value = extras[k];
    }

    // AF 合计公式：主区 D~AE + 补录区 AI~AM（按档位 COUNTIF）
    // 档位单价引用 15 表 C 列：1→C3(100), 2→C4(150), 3→C5(180)，与模板原公式一致
    const mainRng = `${colName(START_COL)}${rowIdx}:AE${rowIdx}`;
    const extraRng = `AI${rowIdx}:AM${rowIdx}`;
    const parts = [1, 2, 3].map((t) =>
      `COUNTIF(${mainRng},${t})*'15_口径参数'!$C$${2 + t}+COUNTIF(${extraRng},${t})*'15_口径参数'!$C$${2 + t}`
    );
    ws.getCell(rowIdx, 32).value = { formula: parts.join('+') };
  }
}

// ===== 05 值日：系统无值日数据，但日期行 R1/R2 应覆盖区间（D~AG=30 天，超出向右扩展 AI+），保持骨架一致 =====
function fillSheet05(wb, { rows, teachers, teacherInfo, fromDate, toDate }) {
  const ws = wb.getWorksheet('05_值日');
  const days = dateRange(fromDate, toDate);
  const MAX_DAYS = 30;
  const START_COL = 4; // D

  // R1 星期 + R2 日期（每列一天）
  for (let di = 0; di < days.length && di < MAX_DAYS; di++) {
    const col = START_COL + di;
    // R1 星期
    const dowNames = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const wd = ws.getCell(1, col);
    wd.value = dowNames[dowOf(days[di])];
    // R2 日期
    const cell = ws.getCell(2, col);
    cell.value = utcDate(days[di]);
    cell.numFmt = 'yyyy-mm-dd';
  }
  void rows; void teachers; void teacherInfo;
}

// ===== 06 周末补课：节假补课按「教师 × 周日」分布到 5 组，每组填节数1 槽 + 单价 =====
function fillSheet06(wb, { rows, teachers, teacherInfo }) {
  const ws = wb.getWorksheet('06_周末补课');
  // 组结构：E/L/S/Z/AG=各组节数1，J/Q/X/AE/AL=各组单价，I/P/W/AD/AK=总节数，K/R/Y/AF/AM=合计，AN=总计
  const GROUP_COUNT_COL = ['E', 'L', 'S', 'Z', 'AG'];
  const GROUP_PAY_COL = ['J', 'Q', 'X', 'AE', 'AL'];

  // 教师 → 节假补课单价（取第一条该教师的节假补课记录 pay_standard 档）
  const payStd = new Map();
  const perDate = new Map(); // teacher_id -> Map<date, count>
  for (const r of rows) {
    if (r.cancelled || r.term !== '节假补课') continue;
    if (!payStd.has(r.teacher_id)) {
      let p = {};
      try { p = JSON.parse(r.pay_standard || '{}') || {}; } catch { p = {}; }
      payStd.set(r.teacher_id, Number(p['节假补课']) || 0);
    }
    if (!perDate.has(r.teacher_id)) perDate.set(r.teacher_id, new Map());
    const m = perDate.get(r.teacher_id);
    m.set(r.date, (m.get(r.date) || 0) + (r.unit_count ?? 1));
  }
  const dates = [...new Set(rows.filter((r) => !r.cancelled && r.term === '节假补课').map((r) => r.date))].sort();

  for (let i = 0; i < teachers.length; i++) {
    const rowIdx = 4 + i;
    const e = teachers[i];
    const info = teacherInfo.get(e.teacher_id) || { grades: [], classes: [], subjects: [] };
    ws.getCell(rowIdx, 1).value = e.teacher_name;
    ws.getCell(rowIdx, 2).value = info.grades.join('/');
    ws.getCell(rowIdx, 3).value = info.classes.join('/');
    ws.getCell(rowIdx, 4).value = info.subjects.join('/');

    const m = perDate.get(e.teacher_id);
    const pay = payStd.get(e.teacher_id) || 0;
    if (m) {
      let gi = 0;
      for (const d of dates) {
        if (gi >= 5) break;
        const cnt = m.get(d);
        if (cnt) {
          ws.getCell(rowIdx, colIndex(GROUP_COUNT_COL[gi])).value = cnt;
          ws.getCell(rowIdx, colIndex(GROUP_PAY_COL[gi])).value = pay;
          gi++;
        }
      }
    }
  }

  // 底部核对区：R79~R83 的 B 列填对应各组日期（组1~组5），合计行 R84 不动
  for (let gi = 0; gi < 5; gi++) {
    const rowIdx = 79 + gi; // R79~R83
    const cell = ws.getCell(rowIdx, 2); // B
    cell.value = dates[gi] ? utcDate(dates[gi]) : null;
    if (dates[gi]) cell.numFmt = 'yyyy-mm-dd';
  }
}

// ===== 07 监考课时：E~J 明细区逐条（E日期 F教师 G折算课时），超出模板 40 行容量时扩行，合计行下移 =====
function fillSheet07(wb, { rows }) {
  const ws = wb.getWorksheet('07_监考课时');
  const coefMap = { '监考·标准': 1, '监考·加时': 1.25, '监考·长时': 1.5 };
  const recs = rows.filter((r) => !r.cancelled && coefMap[r.period_type]).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.teacher_name < b.teacher_name ? -1 : 1)));
  // 模板明细区 R2 起（共 40 行至 R41），合计行 R42
  const START = 2;
  const TPL_CAPACITY = 40;
  const need = recs.length;
  // 若超容量，在合计行(R42)前插入差额行（复制上一行样式 'i'，合计行自动下移）
  if (need > TPL_CAPACITY) {
    const extra = need - TPL_CAPACITY;
    ws.insertRows(START + TPL_CAPACITY, Array.from({ length: extra }, () => []), 'i');
    // 手动补单元格级样式（exceljs insertRows 不复制边框/填充）
    const srcRow = START + TPL_CAPACITY - 1; // 最后一个模板数据行 R41
    for (let k = 0; k < extra; k++) {
      copyRowStyle(ws, srcRow, START + TPL_CAPACITY + k, 'A', 'L');
    }
  }
  // 写明细
  for (let i = 0; i < recs.length; i++) {
    const rowIdx = START + i;
    const r = recs[i];
    ws.getCell(rowIdx, 5).value = utcDate(r.date); // E 日期
    ws.getCell(rowIdx, 5).numFmt = 'yyyy-mm-dd';
    ws.getCell(rowIdx, 6).value = r.teacher_name;  // F 教师
    ws.getCell(rowIdx, 7).value = round2((r.unit_count ?? 1) * coefMap[r.period_type]); // G 监考1
  }
  // 合计行：E=合计, J=SUM(G2:G{last})
  const lastRow = START + recs.length - 1;
  const totRow = START + recs.length;
  const tot = ws.getRow(totRow);
  tot.getCell('E').value = '合计';
  tot.getCell('J').value = { formula: `SUM(G${START}:G${lastRow})` };
  // 清空模板原合计行(R42)残留（若已下移则 R42 现在是明细区边界，无需处理；但保险起见清掉旧合计行内容）
  const oldTotRow = START + TPL_CAPACITY;
  if (oldTotRow !== totRow) {
    const old = ws.getRow(oldTotRow);
    old.getCell('E').value = null;
    old.getCell('J').value = null;
  }
  return { lastRow }; // 明细区最后一行（供 10 表更新 SUMIF 引用范围）
}

// ===== 08 私人定制：A~I 明细区逐条（A教师 B类型 D人数 E开始时间 H学科 I补贴）+ K~L 按教师汇总区 =====
function fillSheet08(wb, { rows, ctx }) {
  const ws = wb.getWorksheet('08_私人定制');
  const recs = rows.filter((r) => !r.cancelled && (r.period_type === '一对一' || r.period_type === '一对二')).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (let i = 0; i < recs.length; i++) {
    const rowIdx = 2 + i;
    const r = recs[i];
    const pay = (r.unit_count ?? 1) * (ctx.periodTypePays.get(r.period_type) ?? 0);
    // 学生姓名：来自 applications.form_data.student_name（一对二为两个名字空格分隔）
    let studentName = '';
    if (r.form_data) {
      try {
        const fd = typeof r.form_data === 'string' ? JSON.parse(r.form_data) : r.form_data;
        studentName = String(fd.student_name || '').trim();
      } catch { /* 解析失败留空 */ }
    }
    ws.getCell(rowIdx, 1).value = r.teacher_name; // A 授课教师
    ws.getCell(rowIdx, 2).value = r.period_type;  // B 课程类型
    ws.getCell(rowIdx, 3).value = studentName;    // C 学生姓名
    ws.getCell(rowIdx, 4).value = r.unit_count ?? 1; // D 学生人数(用课时数近似)
    ws.getCell(rowIdx, 5).value = utcDate(r.date); // E 开始时间
    ws.getCell(rowIdx, 5).numFmt = 'yyyy-mm-dd';
    ws.getCell(rowIdx, 8).value = r.subject || ''; // H 学科
    ws.getCell(rowIdx, 9).value = round2(pay);    // I 补贴
  }

  // 右侧 K~L 按教师汇总区：K 教师名（去重），L=SUMIF(A列, K, I列)，模板预置 R4~R14（11 行），R15 合计
  const teachers = [...new Set(recs.map((r) => r.teacher_name))].sort((a, b) => a.localeCompare(b, 'zh'));
  const detailLast = 1 + recs.length; // 明细最后一行（A 列范围 2~detailLast）
  for (let i = 0; i < teachers.length; i++) {
    const rowIdx = 4 + i; // R4 起
    ws.getCell(rowIdx, 11).value = teachers[i]; // K 教师
    ws.getCell(rowIdx, 12).value = { formula: `SUMIF($A$2:$A$${detailLast},K${rowIdx},$I$2:$I$${detailLast})` }; // L
  }
  // 清空超出实际教师数的预置汇总行（R(4+n)~R14）
  for (let r = 4 + teachers.length; r <= 14; r++) {
    ws.getCell(r, 11).value = null;
    ws.getCell(r, 12).value = null;
  }
  // 合计行 R15 引用范围按实际教师数收缩
  ws.getCell(15, 12).value = { formula: `SUM(L4:L${3 + teachers.length})` };
}

// ===== 09 竞赛培优：A~G 明细区逐条 + I~M 按教练汇总区（I教师 J节数 K系数 L总课时 M补贴） =====
function fillSheet09(wb, { rows, ctx }) {
  const ws = wb.getWorksheet('09_竞赛培优');
  const recs = rows.filter((r) => !r.cancelled && (r.period_type === '竞赛' || r.period_type === '培优')).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // 明细区 A~G
  for (let i = 0; i < recs.length; i++) {
    const rowIdx = 2 + i;
    const r = recs[i];
    ws.getCell(rowIdx, 1).value = r.period_type;   // A 项目
    ws.getCell(rowIdx, 2).value = r.teacher_name;  // B 教练
    ws.getCell(rowIdx, 3).value = utcDate(r.date); // C 日期
    ws.getCell(rowIdx, 3).numFmt = 'yyyy-mm-dd';
    ws.getCell(rowIdx, 4).value = r.term;          // D 时段
    ws.getCell(rowIdx, 5).value = r.source;        // E 学生(用来源近似)
    ws.getCell(rowIdx, 6).value = r.unit_count ?? 1; // F 课时
    // G 收费/元 = 学生缴费（applications.charge_amount，经 source_id 回链）；无则为 0
    ws.getCell(rowIdx, 7).value = (r.charge_amount != null && r.charge_amount !== '') ? Number(r.charge_amount) : 0;
  }

  // 汇总区 I~M：按教练聚合节数与补贴（I教师名 J节数 K=竞赛系数 L=J*K M=补贴）
  const byTeacher = new Map(); // teacher_id -> { name, count, pay }
  for (const r of recs) {
    if (!byTeacher.has(r.teacher_id)) byTeacher.set(r.teacher_id, { name: r.teacher_name, count: 0, pay: 0 });
    const t = byTeacher.get(r.teacher_id);
    t.count = round1(t.count + (r.unit_count ?? 1));
    // 收费课补贴 = manual_pay × unit_count（manual_pay 非空才计；不收费课为 0）
    const mp = r.manual_pay != null && r.manual_pay !== '' ? Number(r.manual_pay) : 0;
    t.pay = round2(t.pay + mp * (r.unit_count ?? 1));
  }
  const coaches = [...byTeacher.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const coef = ctx.periodTypeCoefs.get('竞赛') ?? 2; // 竞赛折算系数
  for (let i = 0; i < coaches.length; i++) {
    const rowIdx = 2 + i; // 汇总区与明细区同起始行 R2 起（模板结构如此）
    const c = coaches[i];
    ws.getCell(rowIdx, 9).value = c.name;   // I 教师
    ws.getCell(rowIdx, 10).value = c.count; // J 节数
    ws.getCell(rowIdx, 11).value = { formula: `'15_口径参数'!$C$18` }; // K 折算系数
    ws.getCell(rowIdx, 12).value = { formula: `J${rowIdx}*K${rowIdx}` }; // L 总课时
    ws.getCell(rowIdx, 13).value = c.pay;   // M 补贴（收费课金额汇总）
  }
  // 合计行：教练数超过模板 10 行(R2~R11)时，把合计行下移；否则清掉多余预置行
  const TPL_SUMMARY_ROWS = 10;
  const sumRow = 2 + Math.max(coaches.length, 0);
  const tot = ws.getRow(12); // 模板合计行 R12
  if (coaches.length <= TPL_SUMMARY_ROWS) {
    // 清空 R(2+n)~R11 的预置汇总行
    for (let r = 2 + coaches.length; r <= 11; r++) {
      ws.getCell(r, 9).value = null;
      ws.getCell(r, 10).value = null;
      ws.getCell(r, 11).value = null;
      ws.getCell(r, 12).value = null;
      ws.getCell(r, 13).value = null;
    }
  }
  // 合计行始终在 R12（教练 ≤10 时够用；>10 时本实现截断，够用）
  tot.getCell('I').value = '合计';
  tot.getCell('J').value = { formula: `SUM(J2:J${Math.max(11, 1 + coaches.length)})` };
  tot.getCell('L').value = { formula: `SUM(L2:L${Math.max(11, 1 + coaches.length)})` };
  tot.getCell('M').value = { formula: `SUM(M2:M${Math.max(11, 1 + coaches.length)})` };
  void sumRow;

  // ===== 右侧「按学生收费」区（N/O 列）：每个学生一行，金额 = 各次收费课 charge_amount 按学生人数均摊后累计 =====
  // 数据源：applications.form_data.students（学生名单）+ charge_amount（该次总收费）。
  const studentFee = new Map(); // 学生名 -> 累计均摊金额
  for (const r of recs) {
    const fee = r.charge_amount != null && r.charge_amount !== '' ? Number(r.charge_amount) : 0;
    if (!fee) continue;
    let names = [];
    if (r.form_data) {
      try {
        const fd = typeof r.form_data === 'string' ? JSON.parse(r.form_data) : r.form_data;
        if (Array.isArray(fd.students)) names = fd.students.map((s) => String(s).trim()).filter(Boolean);
      } catch { /* form_data 解析失败则跳过该条学生明细 */ }
    }
    if (!names.length) continue;
    const per = round2(fee / names.length);
    for (const n of names) studentFee.set(n, round2((studentFee.get(n) || 0) + per));
  }
  const feeStudents = [...studentFee.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'));
  const N_COL = 14, O_COL = 15;
  // 标题 + 表头（占用 R1/R2 右侧，避开 I~M 汇总区的表头区）
  ws.getCell(1, N_COL).value = '按学生收费（均摊）';
  ws.getCell(2, N_COL).value = '学生';
  ws.getCell(2, O_COL).value = '收费/元';
  for (let i = 0; i < feeStudents.length; i++) {
    const rowIdx = 3 + i;
    ws.getCell(rowIdx, N_COL).value = feeStudents[i][0];
    ws.getCell(rowIdx, O_COL).value = feeStudents[i][1];
  }
  // 合计行
  const feeTotRow = 3 + feeStudents.length;
  ws.getCell(feeTotRow, N_COL).value = '合计';
  ws.getCell(feeTotRow, O_COL).value = { formula: `SUM(O3:O${2 + feeStudents.length})` };
}

// ===== 10 课时汇总：B~E=统计周期按自然周（周一~周日）拆分的常规正课折算课时（不含节假补课），
//      F=早读午练 G=竞赛 H=监考，L 合计自动 =====
function fillSheet10(wb, { rows, teachers, ctx, jkLastRow }) {
  const ws = wb.getWorksheet('10_课时汇总');
  const START = 3; // 数据区 R3 起
  const TPL_CAPACITY = 66; // 模板预置 66 行（R3~R68），合计行 R69
  writeRows(ws, START, 'A', teachers.map((e) => [e.teacher_name]));

  // 每周起始周一（自然周）——分段边界
  const mondayOf = (dateStr) => {
    const d = new Date(`${dateStr}T00:00:00`);
    const diff = (d.getDay() + 6) % 7; // 周一=0
    d.setDate(d.getDate() - diff);
    return fmtDate(d);
  };
  // 常规正课按教师 × 周聚合折算课时（不含节假补课）
  const segByTeacher = new Map(); // teacher_id -> Map<weekMonday, weighted>
  for (const r of rows) {
    if (r.cancelled) continue;
    if (r.term !== '常规' || r.period_type !== '正课') continue;
    const wk = mondayOf(r.date);
    const { weighted } = computePay(ctx, { ...r, count: r.unit_count ?? 1 });
    if (!segByTeacher.has(r.teacher_id)) segByTeacher.set(r.teacher_id, new Map());
    const m = segByTeacher.get(r.teacher_id);
    m.set(wk, round2((m.get(wk) || 0) + weighted));
  }
  // 全部周（按时间排序）
  const weeks = [...new Set([...segByTeacher.values()].flatMap((m) => [...m.keys()]))].sort();

  for (let i = 0; i < teachers.length; i++) {
    const rowIdx = START + i;
    const e = teachers[i];
    const name = e.teacher_name;
    const m = segByTeacher.get(e.teacher_id) || new Map();
    // B~E = 分段1~4（按周顺序填折算课时）
    for (let s = 0; s < 4; s++) {
      const wk = weeks[s];
      ws.getCell(rowIdx, 2 + s).value = wk ? round2(m.get(wk) || 0) : null;
    }
    // G 竞赛课时 = SUMIF(09表 B列教练名, F列课时) * 竞赛系数
    ws.getCell(rowIdx, 7).value = { formula: `SUMIF('09_竞赛培优'!$B$2:$B$147,${JSON.stringify(name)},'09_竞赛培优'!$F$2:$F$147)*'15_口径参数'!$C$18` };
    // H 监考课时 = SUMIF(07表 F列教师, J列合计)
    ws.getCell(rowIdx, 8).value = { formula: `SUMIF('07_监考课时'!$F$2:$F$${jkLastRow},${JSON.stringify(name)},'07_监考课时'!$J$2:$J$${jkLastRow})` };
  }

  // 清空超出实际教师数的预置数据行（R(3+n) ~ R68）
  const lastDataRow = START + teachers.length - 1;
  clearRange(ws, lastDataRow + 1, 'A', START + TPL_CAPACITY - 1, 'L');

  // 合计行 R69 引用范围收缩到实际数据行
  const totRow = START + TPL_CAPACITY; // R69
  const tot = ws.getRow(totRow);
  for (const col of ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']) {
    tot.getCell(col).value = { formula: `SUM(${col}${START}:${col}${lastDataRow})` };
  }
}
function fillSheet11(wb, { teachers }) {
  const ws = wb.getWorksheet('11_金额汇总');
  const START = 2; // 数据区 R2 起
  const TPL_CAPACITY = 66; // 模板预置 66 行（R2~R67），合计行 R68
  writeRows(ws, START, 'A', teachers.map((e) => [e.teacher_name]));
  // B 列名：EA 金额实际含「午练 + 晚练 + 晚晚练」，模板列名只写了晚练+晚晚练，名实不符，这里修正
  ws.getCell(1, 2).value = '午练+晚练+晚晚练补贴';
  ws.getCell(2, 12).value = 'B ← 03_早午晚 EA 列（午练 + 晚练 + 晚晚练金额）';
  // 清空超出实际教师数的预置数据行
  const lastDataRow = START + teachers.length - 1;
  clearRange(ws, lastDataRow + 1, 'A', START + TPL_CAPACITY - 1, 'L');
  // 合计行 R68 引用范围收缩
  const totRow = START + TPL_CAPACITY; // R68
  const tot = ws.getRow(totRow);
  for (const col of ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
    tot.getCell(col).value = { formula: `SUM(${col}${START}:${col}${lastDataRow})` };
  }
}

// ===== 12 财务汇总表：直接填值（审核层核心） =====
function fillSheet12(wb, { teachers, fin }) {
  const ws = wb.getWorksheet('12_财务汇总表');
  // 数据区 R2 起，模板预置 56 行（R2~R57），合计行 R58。
  const TPL_CAPACITY = 56;
  const dataRows = teachers.map((e, i) => {
    const row = [i + 1, e.teacher_name];
    for (const col of SHEET12_COLS) row.push(sheet12Value(e, col));
    row.push(round2(e.weighted_total), round2(e.pay_total), ''); // AQ/AR/AS
    return row;
  });

  // 教师数超模板容量：在合计行(R58)前插入差额行（复制上一行样式 'i'，合计行自动下移）
  if (teachers.length > TPL_CAPACITY) {
    const extra = teachers.length - TPL_CAPACITY;
    ws.insertRows(2 + TPL_CAPACITY, Array.from({ length: extra }, () => []), 'i');
    // 手动补单元格级样式
    const srcRow = 2 + TPL_CAPACITY - 1; // 最后一个模板数据行 R57
    for (let k = 0; k < extra; k++) {
      copyRowStyle(ws, srcRow, 2 + TPL_CAPACITY + k, 'A', 'AS');
    }
  }
  writeRows(ws, 2, 'A', dataRows);

  const lastDataRow = 1 + teachers.length;
  const TOTAL_ROW = lastDataRow + 1; // 合计行紧跟数据行

  // 清空超出实际教师数的预置数据行（若有）
  if (teachers.length < TPL_CAPACITY) {
    clearRange(ws, lastDataRow + 1, 'A', 2 + TPL_CAPACITY - 1, 'AS');
  }

  // 合计行公式：引用范围 = R2~R{lastDataRow}
  const tot = ws.getRow(TOTAL_ROW);
  tot.getCell('A').value = '合计';
  for (const col of SHEET12_COLS.map((c) => c.col).concat(['AQ', 'AR'])) {
    tot.getCell(col).value = { formula: `SUM(${col}2:${col}${lastDataRow})` };
  }
  tot.getCell('AS').value = '';
  return TOTAL_ROW;
}

// ===== 13 课酬明细：逐条一行（含停课/代课/原教师/状态），与 /export 同口径 =====
function fillSheet13(wb, { allRows, ctx }) {
  const ws = wb.getWorksheet('13_课酬明细');
  const srcLabel = { schedule: '课表', adjust: '代课/调课', extra: '加课', qna: '申报', course: '个人课务' };
  allRows.forEach((r, i) => {
    const rowIdx = 2 + i;
    let weighted = 0, pay = 0;
    if (!r.cancelled) {
      const w = computePay(ctx, { ...r, count: r.unit_count ?? 1 });
      weighted = w.weighted; pay = w.pay;
    }
    const vals = [
      r.date, r.teacher_name, r.class_name, r.subject ?? '', r.period_no > 0 ? r.period_no : '—',
      r.period_type, r.term, srcLabel[r.source] || r.source,
      (r.source === 'adjust' ? r.parent_teacher_name : '') || '',
      r.cancelled ? '已停课' : '', round2(weighted), round2(pay),
    ];
    for (let j = 0; j < vals.length; j++) ws.getCell(rowIdx, j + 1).value = vals[j];
  });
}

// ===== 14 勾稽校验：按实际行数重写引用范围 =====
function fillSheet14(wb, { allRows, teachers, fin, sumTotRow }) {
  const ws = wb.getWorksheet('14_勾稽校验');
  const detailLast = 1 + allRows.length;  // 13 表最后数据行
  const set = (cell, val) => { ws.getCell(cell).value = val; };

  set('B4', { formula: `SUM('13_课酬明细'!$L$2:$L$${detailLast})` });
  set('B5', { formula: `'12_财务汇总表'!AR${sumTotRow}` });
  set('B6', { formula: 'IF(B4=B5,"✓ 一致","✗ 不一致")' });

  // 二、按类型金额小计（逐行找「按类型·X」标题，覆盖公式）
  for (let r = 1; r <= ws.rowCount; r++) {
    const v = ws.getCell(r, 1).value;
    if (typeof v === 'string' && v.startsWith('按类型·')) {
      const t = v.replace('按类型·', '').replace('(元)', '');
      set(`B${r}`, { formula: `SUMIF('13_课酬明细'!$F$2:$F$${detailLast},"${t}",'13_课酬明细'!$L$2:$L$${detailLast})` });
    }
    if (typeof v === 'string' && (v === '高一' || v === '高二' || v === '高三')) {
      set(`B${r}`, { formula: `SUMIF('13_课酬明细'!$C$2:$C$${detailLast},"*${v}*",'13_课酬明细'!$L$2:$L$${detailLast})` });
    }
  }
  void teachers; void fin;
}

// ===== 15 口径参数：从系统字典覆盖 C 列取值 =====
function fillSheet15(wb, { ctx }) {
  const ws = wb.getWorksheet('15_口径参数');
  const map = new Map();
  for (const [name, pay] of ctx.periodTypePays.entries()) map.set(name, pay);
  for (const [name, coef] of ctx.periodTypeCoefs.entries()) map.set(name, coef);
  for (let r = 1; r <= ws.rowCount; r++) {
    const b = ws.getCell(r, 2).value; // B 项目名
    if (typeof b === 'string' && map.has(b.trim())) ws.getCell(r, 3).value = map.get(b.trim());
  }
}
