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

// 12 财务汇总表列：由系统字典 + 本期数据动态生成，不再写死 45 列。
// 列顺序：序号, 姓名, 正课(节数/折算), 折算类型(节数/折算课时), 按次计酬类型(节数/金额), 非规时段(节数/金额), 折算合计, 课酬合计, 备注。
// 返回 { cols, colCount }：cols 为 [{ name, kind, field }]，kind: core/coef/type/term。
function buildSheet12Cols(ctx, rows) {
  const cols = [];
  // 固定：序号(A) 姓名(B)
  cols.push({ name: '序号', kind: 'seq' });
  cols.push({ name: '姓名', kind: 'name' });
  // 正课
  cols.push({ name: '正课', kind: 'core', field: 'count' });
  cols.push({ name: '正课', kind: 'core', field: 'weighted' });
  // 折算类型（不计钱）
  for (const name of ctx.periodTypeCoefs.keys()) {
    cols.push({ name, kind: 'coef', field: 'count' });
    cols.push({ name, kind: 'coef', field: 'weighted' });
  }
  // 按次计酬类型（计钱）
  for (const name of ctx.periodTypePays.keys()) {
    cols.push({ name, kind: 'type', field: 'count' });
    cols.push({ name, kind: 'type', field: 'pay' });
  }
  // 非规时段（计钱）：从本期记录收集，排除「常规」
  const terms = [...new Set(rows.filter((r) => !r.cancelled && r.term !== '常规').map((r) => r.term))].sort();
  for (const name of terms) {
    cols.push({ name, kind: 'term', field: 'count' });
    cols.push({ name, kind: 'term', field: 'pay' });
  }
  // 合计
  cols.push({ name: '折算课时合计', kind: 'weighted_total' });
  cols.push({ name: '课酬合计(元)', kind: 'pay_total' });
  cols.push({ name: '备注', kind: 'note' });
  return { cols, colCount: cols.length };
}

// 表头文字：按列 kind/field 生成中文标题（与模板格式一致）
function sheet12Header(col) {
  if (col.kind === 'seq') return '序号';
  if (col.kind === 'name') return '教师姓名';
  if (col.kind === 'weighted_total') return '折算课时合计';
  if (col.kind === 'pay_total') return '课酬合计(元)';
  if (col.kind === 'note') return '备注';
  if (col.kind === 'core') return col.field === 'count' ? '正课节数' : '正课折算课时(不计钱)';
  if (col.kind === 'coef') return col.field === 'count' ? `${col.name}节数` : `${col.name}折算课时(不计钱)`;
  if (col.kind === 'type') return col.field === 'count' ? `${col.name}节数` : `${col.name}金额(元)`;
  if (col.kind === 'term') return col.field === 'count' ? `${col.name}节数` : `${col.name}金额(元)`;
  return col.name;
}

function sheet12Value(e, col) {
  if (col.kind === 'seq') return null; // 序号在 fillSheet12 里按行号填
  if (col.kind === 'name') return e.teacher_name;
  if (col.kind === 'weighted_total') return round2(e.weighted_total);
  if (col.kind === 'pay_total') return round2(e.pay_total);
  if (col.kind === 'note') return '';
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
    // 任教班级：排除虚班（年级虚班/个人课务通用虚班等），只保留真实班级
    if (r.class_name && !r.class_is_virtual && !t.classSet.has(r.class_name)) {
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

  // 15 口径参数表先填，产出「项目名 → 行号」映射，供 03/04/09/10 表公式运行时定位（去硬编码）
  const rowMap = fillSheet15(wb, { ctx });

  fillSheet00(wb, { fromDate, toDate, term, userName });
  fillSheet01(wb, { teachers, teacherInfo, rows, ctx });
  fillSheet02(wb, { rows, teachers, teacherInfo, ctx, fromDate, toDate });
  fillSheet03(wb, { rows, teachers, teacherInfo, ctx, fromDate, toDate, rowMap });
  fillSheet04(wb, { rows, teachers, teacherInfo, ctx, fromDate, toDate, rowMap });
  fillSheet06(wb, { rows, teachers, teacherInfo });
  fillSheet05(wb, { rows, teachers, teacherInfo, fromDate, toDate });
  const jkLastRow = fillSheet07(wb, { rows, ctx }).lastRow; // 07 明细区最后一行（含合计）
  fillSheet08(wb, { rows, ctx });
  fillSheet09(wb, { rows, ctx, rowMap });
  fillSheet10(wb, { rows, teachers, ctx, jkLastRow, rowMap });
  fillSheet11(wb, { teachers });
  const sumRes = fillSheet12(wb, { teachers, fin, rows, ctx });
  fillSheet13(wb, { allRows, ctx });
  fillSheet14(wb, { allRows, teachers, fin, sumTotRow: sumRes.totalRow, payColLetter: sumRes.payColLetter });

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

// 确保某 sheet 从 startRow 起有 need 行「带样式」的数据行。
// 数据量超模板预置行数时，在数据区末尾插入差额行，并从模板最后一个数据行复制样式，
// 使超出的行与预置行格式统一（黄色填充 + 边框 + 对齐）。
// 参数：ws、startRow（数据区首行）、need（需要的行数）、tplCapacity（模板预置行数）、colRange（列范围字母，如 'L'）。
function ensureRows(ws, startRow, need, tplCapacity, colRange) {
  if (need <= tplCapacity) return;
  const extra = need - tplCapacity;
  const insertAt = startRow + tplCapacity; // 在最后一个预置数据行之后插入
  ws.insertRows(insertAt, Array.from({ length: extra }, () => []), 'i');
  const srcRow = insertAt - 1; // 模板最后一个数据行
  for (let k = 0; k < extra; k++) {
    copyRowStyle(ws, srcRow, insertAt + k, 'A', colRange);
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

// ===== 01 基础名单与系数：A姓名 B年级 C任教班级 D任教学科；E/G/I/K=各班人数，F/H/J/L=各班系数 =====
// 「课型人数」= 该教师各任课班级的班额；「系数」= 学科系数 + 班额系数（不计班额学科只学科系数），
// 与 02 表 F/H/J/L 口径一致。超过 4 个班时第 5 个班起并入第 4 组（人数累加、系数取折算÷人数近似）。
function fillSheet01(wb, { teachers, teacherInfo, rows, ctx }) {
  const ws = wb.getWorksheet('01_基础名单与系数');
  // 每教师各班级的「班额」与「折算系数」
  const byClass = new Map(); // teacher_id -> [{ cn, size, coef }]
  for (const r of rows) {
    if (r.cancelled) continue;
    if (r.class_is_virtual) continue; // 跳过虚班
    if (!byClass.has(r.teacher_id)) byClass.set(r.teacher_id, []);
    const arr = byClass.get(r.teacher_id);
    if (arr.find((x) => x.cn === r.class_name)) continue; // 去重
    const cls = ctx.classMap.get(r.class_id);
    const size = cls?.student_count || 0;
    const subj = String(r.subject || '').replace(/[A-Za-z0-9一二三四五六七八九十]+层$/, '').trim();
    const subjCoef = ctx.subjCoef.get(subj) ?? 1.0;
    const sizeCoef = ctx.noSizeSubjects.has(subj) ? 0 : ctx.sizeCoefOf(size);
    arr.push({ cn: r.class_name, size, coef: round2(subjCoef + sizeCoef) });
  }

  for (let i = 0; i < teachers.length; i++) {
    const rowIdx = 4 + i;
    const e = teachers[i];
    const info = teacherInfo.get(e.teacher_id) || { grades: [], classes: [], subjects: [] };
    const arr = byClass.get(e.teacher_id) || [];
    arr.sort((a, b) => (b.size - a.size) || a.cn.localeCompare(b.cn, 'zh'));

    ws.getCell(rowIdx, 1).value = e.teacher_name;
    ws.getCell(rowIdx, 2).value = info.grades.join('/');
    ws.getCell(rowIdx, 3).value = info.classes.join('/');
    ws.getCell(rowIdx, 4).value = info.subjects.join('/');

    // E/G/I/K=人数，F/H/J/L=系数（4 组，超出并入第 4 组）
    const groups = [{ size: 0, coef: 0, n: 0 }, { size: 0, coef: 0, n: 0 }, { size: 0, coef: 0, n: 0 }, { size: 0, coef: 0, n: 0 }];
    arr.forEach((c, idx) => {
      const g = groups[Math.min(idx, 3)];
      g.size += c.size; g.coef += c.coef; g.n++;
    });
    const sizeCols = [5, 7, 9, 11];   // E,G,I,K
    const coefCols = [6, 8, 10, 12]; // F,H,J,L
    for (let gi = 0; gi < 4; gi++) {
      const g = groups[gi];
      if (g.n > 0) {
        ws.getCell(rowIdx, sizeCols[gi]).value = g.size;
        ws.getCell(rowIdx, coefCols[gi]).value = round2(g.coef / g.n); // 组内多班时取平均系数
      } else {
        ws.getCell(rowIdx, sizeCols[gi]).value = null;
        ws.getCell(rowIdx, coefCols[gi]).value = null;
      }
    }
  }
}

// ===== 02 普通课时统计：B年级 C任教班级 D任教学科；正课按「班级」拆到 E/G/I/K 四组节数，
//       F/H/J/L 填对应班级的加权系数（=该班折算课时÷该班节数），使 M=E*F+G*H+I*J+K*L = 总折算课时。
//       超过 4 个班的教师，第 5 个班起并入 K/L 组（节数累加、系数按折算÷总节数重算）。
//       底部两个核对区（模板标记「手填」）由系统自动生成，取代人工核对：
//       · 「按日期核对」：每个常规正课上课日一行，B=日期、C=当日常规正课节数，最后一行合计（C=SUM 逐日）。
//       · 「分年级核对」：高一/高二/高三各一行（C=该年级常规正课节数，从 lesson_instances.class_grade 聚合），
//         最后一行合计；「实际表中数据」= 数据区全部节数（逐日汇总的分母），差异 = 实际 - 分年级合计（应为 0）。 =====
function fillSheet02(wb, { rows, teachers, teacherInfo, ctx, fromDate, toDate }) {
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

  // ===== 底部核对区自动生成（模板标记「手填」） =====
  // 模板固定行：R67 标题「按日期核对」、R73 合计（SUM(C68:C72)）、
  //             R75 标题「分年级核对」、R78 合计（SUM(C75:C77)）、R80 实际/差异。
  // 上课日超过模板预留 5 行时，在 R73 前插入差额行（复制日期行黄色样式），合计行随之下移。
  const normalRows = rows.filter((r) => !r.cancelled && r.term === '常规' && r.period_type === '正课');
  const dayCount = new Map(); // date -> 节数
  for (const r of normalRows) {
    dayCount.set(r.date, round1((dayCount.get(r.date) || 0) + (r.unit_count ?? 1)));
  }
  const days = [...dayCount.keys()].sort();

  const TPL_DAY_ROWS = 5;         // 模板预置日期行 R68~R72
  const TITLE_ROW = 67;           // 「按日期核对」标题行
  const DAY_START = TITLE_ROW + 1; // 首行日期 = R68
  const need = days.length;
  // 日期区至少占满模板预置 5 行（少于 5 天时空行留白，合计行仍固定 R73）
  const totalDateRows = Math.max(need, TPL_DAY_ROWS);
  const extra = totalDateRows - TPL_DAY_ROWS;
  if (extra > 0) {
    const insertAt = DAY_START + TPL_DAY_ROWS; // 在最后一个预置日期行之后插入 = R73
    ws.insertRows(insertAt, Array.from({ length: extra }, () => []), 'i');
    // 复制日期行的黄色填充与边框样式（exceljs insertRows 不复制单元格样式）
    const srcRow = insertAt - 1; // 模板最后一个日期行 R72
    for (let k = 0; k < extra; k++) copyRowStyle(ws, srcRow, insertAt + k, 'A', 'E');
  }

  // 1) 按日期核对：B=日期（真日期）、C=当日节数，首行 DAY_START 起共 need 行
  for (let i = 0; i < need; i++) {
    const rowIdx = DAY_START + i;
    const b = ws.getCell(rowIdx, 2);
    b.value = utcDate(days[i]);
    b.numFmt = 'yyyy-mm-dd';
    ws.getCell(rowIdx, 3).value = dayCount.get(days[i]);
  }
  const daySumRow = DAY_START + totalDateRows; // 合计行：R73（或插入 extra 后下移）
  // 合计行：B=合计（保留原样式），C=SUM 逐日，覆盖模板「SUM(C68:C72)」硬编码范围
  ws.getCell(daySumRow, 2).value = '合计';
  ws.getCell(daySumRow, 3).value = { formula: `SUM(C${DAY_START}:C${DAY_START + totalDateRows - 1})` };
  // 标题去掉「（手填）」，标注由系统自动汇总
  ws.getCell(TITLE_ROW, 1).value = '按日期核对（自动汇总）';

  // 2) 分年级核对：按 class_grade 聚合常规正课节数，只填「高一/高二/高三」三行 + 合计
  const gradeCount = new Map(); // grade -> 节数
  for (const r of normalRows) {
    const g = r.class_grade || '未分年级';
    gradeCount.set(g, round1((gradeCount.get(g) || 0) + (r.unit_count ?? 1)));
  }
  // 分年级标题行 R75 下移 daySumRow - 73 行（与插入行数一致）
  const GRADE_TITLE_ROW = 75 + (daySumRow - 73);
  // 模板「高一总节数/高二总节数/高三总节数」标签分别占 R75/R76/R77 的 B 列，
  // 「分年级核对（手填）」标题在 R75 的 A 列（与「高一」同行），故高一数据填 R75。
  const GRADE_ROWS = ['高一', '高二', '高三'];
  GRADE_ROWS.forEach((g, i) => {
    ws.getCell(GRADE_TITLE_ROW + i, 3).value = gradeCount.get(g) || 0;
  });
  const gradeSumRow = GRADE_TITLE_ROW + GRADE_ROWS.length;
  // 分年级合计：C=SUM 三行（不依赖 C75:C77 硬编码）
  ws.getCell(gradeSumRow, 2).value = '合计';
  ws.getCell(gradeSumRow, 3).value = { formula: `SUM(C${GRADE_TITLE_ROW}:C${GRADE_TITLE_ROW + GRADE_ROWS.length - 1})` };
  // 标题去掉「（手填）」，标注由系统自动汇总
  ws.getCell(GRADE_TITLE_ROW, 1).value = '分年级核对（自动汇总）';

  // 3) 实际表中数据 = 数据区全部节数（E/G/I/K + N/P 六列），差异 = 实际 - 分年级合计（应为 0）
  const diffRow = GRADE_TITLE_ROW + GRADE_ROWS.length + 2; // 模板 R80，随插入下移
  const dataLast = 3 + teachers.length; // 数据区最后一行 = R(3+教师数)
  ws.getCell(diffRow, 2).value = '实际表中数据';
  ws.getCell(diffRow, 3).value = { formula: `SUM(E4:E${dataLast},G4:G${dataLast},I4:I${dataLast},K4:K${dataLast},N4:N${dataLast},P4:P${dataLast})` };
  ws.getCell(diffRow, 4).value = '差异（应为 0）';
  ws.getCell(diffRow, 5).value = { formula: `C${diffRow}-C${gradeSumRow}` };
}

// ===== 03 早午晚：逐日打点矩阵。模板每日占 4 列（早读/午练/晚读/晚晚读），28 天 = D~DK（列4~115）。
//      日期写 R2（每 4 列的第 1 列），R4 是「早读/午练/晚读/晚晚读」分组标题，数据区 R5 起。
//      有记录打点 1（unit_count 累计），汇总列 DN~EA 由模板公式自动求和。
//      早读=早自习，晚读=晚练，晚晚读=晚晚练，午练=午练（计酬类型但按次）。 =====
function fillSheet03(wb, { rows, teachers, teacherInfo, ctx, fromDate, toDate, rowMap }) {
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
    const noonRow = rowMap.get('午练'); // 15 表「午练」行号（运行时定位，去硬编码 $C$14）
    ws.getCell(rowIdx, 131).value = { formula: `SUM(DW${rowIdx},DZ${rowIdx},DQ${rowIdx}*'15_口径参数'!$C$${noonRow})` };
    // EA 列名补「含午练」，与 11 表 B 列「午练+晚练+晚晚练」名实相符
    ws.getCell(1, 131).value = '总金额/元(含午练)';
  }
}

// ===== 04 坐班答疑：逐日档位打点。D~AE=28 天（每列一天），日期写 R1，档位 1/2/3 填数据行 R4+。
//      档位映射：答疑·高一=100→1，答疑·其他=150→2，晚自习=180→3。
//      同日第 2 场：向右加补录列 AI~AM（5 列），AF 合计公式 COUNTIF 扩到含补录区。 =====
function fillSheet04(wb, { rows, teachers, teacherInfo, ctx, fromDate, toDate, rowMap }) {
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
    // 档位单价引用 15 表 C 列：档位1/2/3 行号运行时定位（去硬编码 $C$3/C$4/C$5）
    const mainRng = `${colName(START_COL)}${rowIdx}:AE${rowIdx}`;
    const extraRng = `AI${rowIdx}:AM${rowIdx}`;
    const tierRows = [1, 2, 3].map((t) => rowMap.get(`档位${t}`));
    const parts = [1, 2, 3].map((t, idx) =>
      `COUNTIF(${mainRng},${t})*'15_口径参数'!$C$${tierRows[idx]}+COUNTIF(${extraRng},${t})*'15_口径参数'!$C$${tierRows[idx]}`
    );
    ws.getCell(rowIdx, 32).value = { formula: parts.join('+') };
  }
}

// ===== 05 值日：按「教师 × 日期」打点金额（来自 lesson_instances period_type='值日'），逐日区 D~AG（30天），AH 合计公式自动 =====
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

  // 值日记录：按「教师 × 日期」聚合金额（manual_pay 是值日档位金额）
  const duty = new Map(); // `${teacher_id}|${date}` -> 金额
  for (const r of rows) {
    if (r.cancelled) continue;
    if (r.period_type !== '值日') continue;
    const amt = r.manual_pay != null && r.manual_pay !== '' ? Number(r.manual_pay) : 0;
    const key = `${r.teacher_id}|${r.date}`;
    duty.set(key, round2((duty.get(key) || 0) + amt));
  }

  // 有值日记录的教师（按姓名排序），填到 05 表数据区（R5 起，模板预置 23 行）
  const dutyTeachers = [...new Set(rows.filter((r) => !r.cancelled && r.period_type === '值日').map((r) => r.teacher_id))]
    .map((tid) => ({ id: tid, name: rows.find((r) => r.teacher_id === tid)?.teacher_name }))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));

  dutyTeachers.forEach((t, i) => {
    const rowIdx = 5 + i;
    const info = teacherInfo.get(t.id) || { grades: [], subjects: [] };
    // A 年级 B 科目 C 姓名
    ws.getCell(rowIdx, 1).value = info.grades.join('/');
    ws.getCell(rowIdx, 2).value = info.subjects.join('/');
    ws.getCell(rowIdx, 3).value = t.name;
    // 逐日金额打点
    for (let di = 0; di < days.length && di < MAX_DAYS; di++) {
      const amt = duty.get(`${t.id}|${days[di]}`);
      if (amt) ws.getCell(rowIdx, START_COL + di).value = amt;
    }
  });

  // 清空超出值日教师数的预置名单行（R(5+n) ~ R27）
  for (let r = 5 + dutyTeachers.length; r <= 27; r++) {
    ws.getCell(r, 1).value = null;
    ws.getCell(r, 2).value = null;
    ws.getCell(r, 3).value = null;
  }
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
      // 组号按全局日期对齐：第 gi 组固定对应 dates[gi] 当天，教师当天有补课才填该组，
      // 否则留空。这样 5 组分别对应 5 个补课日，每组汇总 = 当天全体教师的补课节数（各组应接近）。
      for (let gi = 0; gi < dates.length && gi < 5; gi++) {
        const cnt = m.get(dates[gi]);
        if (cnt) {
          ws.getCell(rowIdx, colIndex(GROUP_COUNT_COL[gi])).value = cnt;
          ws.getCell(rowIdx, colIndex(GROUP_PAY_COL[gi])).value = pay;
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
function fillSheet07(wb, { rows, ctx }) {
  const ws = wb.getWorksheet('07_监考课时');
  // 修复：模板 A~C「学科时长对照区」的 B 列（监考分钟数）底层样式含日期格式，
  // exceljs 写回时会丢失 t="n" 导致数字被 Excel 解析成日期。这里把 B 列重建为文本值，彻底绕开歧义。
  // 学科时长对照（分钟 → 折算课时）：从监考折算系数反推标准时长档位。
  // 监考折算系数来自系统字典 period_type_coefficients（监考·标准/加时/长时）。
  const jkStd = ctx.periodTypeCoefs.get('监考·标准') ?? 1;
  const jkLong = ctx.periodTypeCoefs.get('监考·加时') ?? 1.25;
  const jkLongest = ctx.periodTypeCoefs.get('监考·长时') ?? 1.5;
  // 学科时长对照：语文/数学 120min(加时)、英语 120min、其余 90min(标准)；150min 对应长时(语文卷面时长)
  const subjectDurationMap = { 语文: 150, 地理: 90, 物理: 90, 英语: 120, 化学: 90, 历史: 90, 生物: 90, 政治: 90, 技术: 90, 数学: 120 };
  let di = 0;
  for (const [subject, mins] of Object.entries(subjectDurationMap)) {
    const row = 2 + di;
    ws.getCell(row, 1).value = subject;             // A 学科
    ws.getCell(row, 2).value = String(mins);        // B 监考时间（文本，避免日期歧义）
    // C 折算课时：按分钟映射到字典系数（150→长时，120→加时，90→标准）
    const coef = mins >= 150 ? jkLongest : mins >= 120 ? jkLong : jkStd;
    ws.getCell(row, 3).value = coef;
    di++;
  }
  // 监考折算系数：从系统字典读，不再写死 1/1.25/1.5
  const coefMap = {
    '监考·标准': jkStd,
    '监考·加时': jkLong,
    '监考·长时': jkLongest,
  };
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
    // J 合计课时 = SUM(G:I)——插入的行没有公式，需给每一行显式补（10 表 SUMIF 依赖 J 列）
    ws.getCell(rowIdx, 10).value = { formula: `SUM(G${rowIdx}:I${rowIdx})` };
  }
  // 合计行：E=合计, J=SUM(G2:G{last})
  const lastRow = START + recs.length - 1;
  const totRow = START + recs.length;
  const tot = ws.getRow(totRow);
  tot.getCell('E').value = '合计';
  tot.getCell('J').value = { formula: `SUM(G${START}:G${lastRow})` };
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
function fillSheet09(wb, { rows, ctx, rowMap }) {
  const ws = wb.getWorksheet('09_竞赛培优');
  const recs = rows.filter((r) => !r.cancelled && (r.period_type === '竞赛' || r.period_type === '培优')).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // 模板明细区 R2~R31（30 行），竞赛记录可能超，先扩行复制样式
  ensureRows(ws, 2, recs.length, 30, 'M');
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
  const compRow = rowMap.get('竞赛折算') ?? rowMap.get('竞赛'); // 竞赛折算系数行号（运行时定位）
  for (let i = 0; i < coaches.length; i++) {
    const rowIdx = 2 + i; // 汇总区与明细区同起始行 R2 起（模板结构如此）
    const c = coaches[i];
    ws.getCell(rowIdx, 9).value = c.name;   // I 教师
    ws.getCell(rowIdx, 10).value = c.count; // J 节数
    ws.getCell(rowIdx, 11).value = { formula: `'15_口径参数'!$C$${compRow}` }; // K 折算系数
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
function fillSheet10(wb, { rows, teachers, ctx, jkLastRow, rowMap }) {
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
    // G 竞赛课时 = SUMIF(09表 B列教练名, F列课时) * 竞赛系数（行号运行时定位）
    const compRow = rowMap.get('竞赛折算') ?? rowMap.get('竞赛');
    ws.getCell(rowIdx, 7).value = { formula: `SUMIF('09_竞赛培优'!$B$2:$B$147,${JSON.stringify(name)},'09_竞赛培优'!$F$2:$F$147)*'15_口径参数'!$C$${compRow}` };
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

// ===== 12 财务汇总表：直接填值（审核层核心），列由系统字典动态生成 =====
function fillSheet12(wb, { teachers, fin, rows, ctx }) {
  const ws = wb.getWorksheet('12_财务汇总表');
  const { cols, colCount } = buildSheet12Cols(ctx, rows);
  const TPL_CAPACITY = 56; // 模板预置 56 行（R2~R57），合计行 R58

  // 1) 表头行：动态写列标题（模板 12 表无合并单元格，直接覆盖 R1）
  const head = ws.getRow(1);
  cols.forEach((col, i) => {
    const cell = head.getCell(i + 1);
    cell.value = sheet12Header(col);
    // 表头样式：沿用模板 A1 的样式（深蓝底白字加粗）
    const tpl = ws.getCell(1, 1);
    cell.fill = { ...tpl.fill };
    cell.font = { ...tpl.font };
    cell.alignment = { ...tpl.alignment };
    cell.border = { ...tpl.border };
  });

  // 清掉模板 12 表超出动态列的残留列（表头 + 数据区 + 合计行）
  // 模板预置 45 列，动态列可能更少（非规时段无数据时不生成对应列），需清尾。
  const TPL_COLS = 45;
  if (colCount < TPL_COLS) {
    clearRange(ws, 1, colName(colCount + 1), ws.rowCount, colName(TPL_COLS));
  }

  // 2) 数据行：教师数超模板容量则先插入差额行
  if (teachers.length > TPL_CAPACITY) {
    const extra = teachers.length - TPL_CAPACITY;
    ws.insertRows(2 + TPL_CAPACITY, Array.from({ length: extra }, () => []), 'i');
    const srcRow = 2 + TPL_CAPACITY - 1;
    for (let k = 0; k < extra; k++) copyRowStyle(ws, srcRow, 2 + TPL_CAPACITY + k, 'A', colName(colCount));
  }

  teachers.forEach((e, i) => {
    const rowIdx = 2 + i;
    cols.forEach((col, j) => {
      let v = sheet12Value(e, col);
      if (col.kind === 'seq') v = i + 1;
      ws.getCell(rowIdx, j + 1).value = v;
    });
  });

  const lastDataRow = 1 + teachers.length;
  const TOTAL_ROW = lastDataRow + 1;

  // 清空超出实际教师数的预置数据行
  if (teachers.length < TPL_CAPACITY) {
    clearRange(ws, lastDataRow + 1, 'A', 2 + TPL_CAPACITY - 1, colName(colCount));
  }

  // 3) 合计行：数值列写 SUM 公式（seq/name/note 列除外）
  const tot = ws.getRow(TOTAL_ROW);
  let payColLetter = null;
  cols.forEach((col, i) => {
    const letter = colName(i + 1);
    if (col.kind === 'seq') tot.getCell(letter).value = '合计';
    else if (col.kind === 'name' || col.kind === 'note') tot.getCell(letter).value = '';
    else tot.getCell(letter).value = { formula: `SUM(${letter}2:${letter}${lastDataRow})` };
    if (col.kind === 'pay_total') payColLetter = letter; // 记录课酬合计列字母，供 14 表勾稽引用
  });

  return { totalRow: TOTAL_ROW, payColLetter };
}

// ===== 13 课酬明细：逐条一行（含停课/代课/原教师/状态），与 /export 同口径 =====
function fillSheet13(wb, { allRows, ctx }) {
  const ws = wb.getWorksheet('13_课酬明细');
  // 模板预置 31 行（R2~R31），明细通常远多于此，需先扩行并复制样式，否则超出行无边框/填充
  const START = 2;
  const TPL_CAPACITY = 30; // R2~R31
  ensureRows(ws, START, allRows.length, TPL_CAPACITY, 'L');

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
function fillSheet14(wb, { allRows, teachers, fin, sumTotRow, payColLetter }) {
  const ws = wb.getWorksheet('14_勾稽校验');
  const detailLast = 1 + allRows.length;  // 13 表最后数据行
  const set = (cell, val) => { ws.getCell(cell).value = val; };

  set('B4', { formula: `SUM('13_课酬明细'!$L$2:$L$${detailLast})` });
  // 12 表课酬合计列随动态列生成而变化，用传入的列字母（不再写死 AR）
  set('B5', { formula: `'12_财务汇总表'!${payColLetter}${sumTotRow}` });
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

// ===== 15 口径参数：从系统字典写值 + 返回「项目名 → 行号」映射 =====
// 供其它表公式运行时定位 15 表行号（去硬编码 $C$14/$C$18 等）。
function fillSheet15(wb, { ctx }) {
  const ws = wb.getWorksheet('15_口径参数');

  // 先扫模板既有行，建「项目名 → 行号」映射（B 列=项目名）
  const rowMap = new Map();
  for (let r = 1; r <= ws.rowCount; r++) {
    const b = ws.getCell(r, 2).value;
    if (typeof b === 'string' && b.trim()) rowMap.set(b.trim(), r);
  }

  // 系统字典 → 15 表「项目名」的取值（显式命名，避免碰运气）
  const assigns = new Map();
  // 按次计酬类型：项目名 = 类型名（晚自习/答疑/晚练/晚晚练/一对一/一对二/一对多/午练）
  for (const [name, pay] of ctx.periodTypePays.entries()) assigns.set(name, pay);
  // 折算类型：项目名 = 类型名（早自习/竞赛/培优/监考·标准/监考·加时/监考·长时）
  for (const [name, coef] of ctx.periodTypeCoefs.entries()) assigns.set(name, coef);
  // 折算系数区的「竞赛折算」别名（模板 B 列写「竞赛折算」，字典名是「竞赛」）
  const aliasCoef = {
    '早自习': '早自习折算',
    '竞赛': '竞赛折算',
    '培优': '培优折算',
  };
  for (const [src, dst] of Object.entries(aliasCoef)) {
    const v = ctx.periodTypeCoefs.get(src);
    if (v != null) assigns.set(dst, v);
  }
  // 档位（坐班答疑）：1/2/3 固定 100/150/180（模板预置，非字典项，这里补写保证存在）
  assigns.set('档位1', 100);
  assigns.set('档位2', 150);
  assigns.set('档位3', 180);
  // 分年级覆盖价（答疑@高一=100 等）→ 追加到 15 表（项目名 = `${type}@${grade}`）
  for (const [type, gmap] of ctx.periodTypeGradePays.entries()) {
    for (const [grade, pay] of gmap.entries()) assigns.set(`${type}@${grade}`, pay);
  }

  // 写值：已有行覆盖 C 列；缺失行追加（A=类别、B=项目名、C=取值）
  const insRow = (name, val) => {
    const r = ws.rowCount + 1;
    ws.getCell(r, 1).value = '按次计酬/折算'; // 类别（通用占位）
    ws.getCell(r, 2).value = name;
    ws.getCell(r, 3).value = val;
    rowMap.set(name, r);
    return r;
  };
  for (const [name, val] of assigns.entries()) {
    const r = rowMap.get(name);
    if (r) ws.getCell(r, 3).value = val;
    else insRow(name, val);
  }

  return rowMap;
}
