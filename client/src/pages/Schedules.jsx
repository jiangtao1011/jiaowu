import React, { useEffect, useState } from 'react';
import api, { errMsg } from '../api.js';
import { useToast } from '../components/feedback.jsx';

const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const TERMS = ['常规', '夏令营', '冬令营', '全员夏令营', '全员冬令营', '节假补课'];
const FORM_LABEL = { 行政班: '行政班', 分层: '分层', 走班: '走班', 走班分层: '走班分层' };

// 科目简称对照表（格子内容过多时用简称）
const ABBR = {
  政治: '政', 生物: '生', 通用技术: '通', 通用: '通', 技术: '技', 地理: '地', 历史: '史',
  物理: '物', 化学: '化', 数学: '数', 语文: '语', 英语: '英', 信息技术: '信',
  体育: '体', 音乐: '音', 美术: '美', 心理: '心',
};
const abbr = (s) => (s && ABBR[s]) || s;

// 科目 → 颜色（缩略图色块用，柔和区分）
const SUBJECT_COLORS = {
  语文: '#c0392b', 数学: '#3b5bdb', 英语: '#7a4fb0', 物理: '#167d6f', 化学: '#2e8b57',
  生物: '#e8590c', 政治: '#b0731f', 历史: '#8a5a00', 地理: '#0f5f54', 体育: '#6b7280',
  音乐: '#5b55c0', 美术: '#e67700', 信息技术: '#2c46b0', 信息: '#2c46b0', 通用技术: '#5f3dc4', 通用: '#5f3dc4', 技术: '#5f3dc4', 心理: '#c0392b',
};
const subjectColor = (s) => SUBJECT_COLORS[s] || '#8894a3';

// 从班级名中提取层标识（如 '高一(1)班数学A层' -> 'A层'）
const layerToken = (name) => {
  const m = /([A-Za-z0-9一二三四五六七八九十]+层)/.exec(name || '');
  return m ? m[1] : '';
};
// 去掉科目尾部的层标识
const baseSubject = (s) => (s || '').replace(/[A-Za-z0-9一二三四五六七八九十]+层$/, '').trim();

// 通知单打印版式（仅打印时可见）
function PrintSheet({ c, rangeLabel }) {
  const timeLabel = c.source === 'instance'
    ? `${c.date || ''} ${c.period_no ? `第 ${c.period_no} 节` : ''}`.trim()
    : `${c.day_of_week ? `星期${'一二三四五六日'[c.day_of_week - 1]}` : ''} ${c.period_no ? `第 ${c.period_no} 节` : ''}`.trim();
  const range = rangeLabel(c);
  return (
    <div className="print-sheet">
      <h1 className="ps-title">{c.change_type}通知单</h1>
      <div className="ps-meta">编号：{String(c.id).padStart(4, '0')} · 签发日期：{String(c.created_at || '').slice(0, 10)}</div>
      <table className="ps-table">
        <tbody>
          <tr><th>班级</th><td>{c.class_grade ? `${c.class_grade} · ` : ''}{c.class_name || '—'}</td><th>课程</th><td>{c.subject || '—'}</td></tr>
          <tr><th>时间</th><td>{timeLabel || '—'}</td><th>类型</th><td>{c.change_type}</td></tr>
          <tr><th>原教师</th><td>{c.from_teacher_name || '—'}</td><th>{c.change_type === '停课' ? '状态' : '新教师'}</th><td>{c.change_type === '停课' ? '停课' : c.to_teacher_name || '—'}</td></tr>
          <tr><th>生效日期</th><td>{range}</td><th>原因</th><td>{c.reason || '—'}</td></tr>
        </tbody>
      </table>
      <div className="ps-foot">
        <div>签发人：{c.operator_name || '教务主任'}</div>
        <div>（本通知单一式一份，交相关教师留存）</div>
      </div>
    </div>
  );
}

export default function Schedules() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [classes, setClasses] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [error, setError] = useState('');
  const [classId, setClassId] = useState('');
  const [grade, setGrade] = useState('');
  const [term, setTerm] = useState('');
  const [file, setFile] = useState(null);
  const [drag, setDrag] = useState(null);
  const [detail, setDetail] = useState(null); // { title, day, period, rows: [...] }
  const [effFrom, setEffFrom] = useState('');   // 生效日期（留空=追加）
  const [effTo, setEffTo] = useState('');       // 结束日期（留空=不设终点）
  const [scope, setScope] = useState('append'); // append | all | grade | term
  const [scopeGrade, setScopeGrade] = useState('');
  const [scopeTerm, setScopeTerm] = useState('');
  const [makeupSet, setMakeupSet] = useState(''); // 补课课表套号（1/2/3…，导入节假补课时标记第几套）
  const [view, setView] = useState('grid'); // 'grid' 课表视图 | 'makeup' 补课课表列表
  const [makeupRows, setMakeupRows] = useState([]); // 补课课表（term=节假补课）明细
  const [showImport, setShowImport] = useState(false); // 导入课表弹窗
  const [changes, setChanges] = useState([]); // 课务调整记录
  const [printChange, setPrintChange] = useState(null); // 打印通知单对象
  const [focusClass, setFocusClass] = useState(''); // 下钻的单班 id（空=总览缩略图）
  const [makeupTab, setMakeupTab] = useState(null); // 补课课表当前套号（null=未选，选第一个）

  const load = async () => {
    try {
      const [c, t] = await Promise.all([api.get('/classes'), api.get('/teachers')]);
      setClasses(c.data.data); setTeachers(t.data.data);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const loadChanges = async () => {
    try {
      setChanges((await api.get('/schedules/changes')).data.data);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { if (view === 'changes') loadChanges(); }, [view]);

  const revertChange = async (c) => {
    if (!(await toast.confirm(`确定撤回这条「${c.change_type}」调整？撤销后课表恢复原状。`, { danger: true }))) return;
    try {
      await api.post(`/schedules/changes/${c.id}/revert`);
      toast.success('已撤回该调整');
      loadChanges();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const loadMakeup = async () => {
    try {
      const r = await api.get('/schedules', { params: { term: '节假补课', include_inactive: '1' } });
      setMakeupRows(r.data.data);
      // 默认选中第一套（含 null）
      const sets = [...new Set(r.data.data.map((x) => x.makeup_set)).values()].filter((s) => s != null).sort((a, b) => a - b);
      const hasUnmarked = r.data.data.some((x) => x.makeup_set == null);
      const first = hasUnmarked ? null : (sets[0] ?? null);
      setMakeupTab(first);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { if (view === 'makeup') loadMakeup(); }, [view]);

  // 删除补课课表：按套号（+可选年级）删除整套
  const deleteMakeupSet = async (set) => {
    if (!(await toast.confirm(
      `确定删除第 ${set} 套补课课表？将同时删除其已展开的上课记录，不可撤销。`,
      { danger: true }
    ))) return;
    try {
      const r = await api.delete('/schedules/makeup', { data: { makeup_set: set } });
      toast.success(`已删除第 ${set} 套补课课表（${r.data.data.deleted} 条课表、${r.data.data.instances} 条上课记录）`);
      loadMakeup();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const loadSchedules = async () => {
    try {
      const params = {};
      if (classId) params.class_id = classId;
      if (grade) params.grade = grade;
      if (term) params.term = term;
      setRows((await api.get('/schedules', { params })).data.data);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { loadSchedules(); }, [classId, grade, term]);

  const grades = [...new Set(classes.map((c) => c.grade).filter(Boolean))].sort();
  const classById = new Map(classes.map((c) => [c.id, c]));

  // 一条课表记录映射到的「行政班」集合：
  //   行政班自身 -> 自己；分层 -> 其父行政班；走班/走班分层 -> 其合班的各个行政班
  const adminIdsOf = (r) => {
    const cls = classById.get(r.class_id);
    if (!cls) return [];
    if (cls.type === '行政班') return [cls.id];
    if (cls.type === '分层') {
      const p = cls.parent_id ? classById.get(cls.parent_id) : null;
      if (!p) return [];
      if (p.type === '走班') return (p.members || []).map((m) => m.id);
      return [p.id];
    }
    if (cls.type === '走班') return (cls.members || []).map((m) => m.id);
    return [];
  };

  const downloadTemplate = async () => {
    try {
      const token = localStorage.getItem('edu_token');
      const r = await fetch('/api/schedules/template', { headers: { Authorization: `Bearer ${token}` } });
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '课表导入模板.xlsx';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(errMsg(e)); }
  };

  const importFile = async () => {
    if (!file) return toast.error('请先选择课表文件（.xlsx / .csv）');
    if (scope !== 'append' && !effFrom) return toast.error('替换导入需指定生效日期');
    if (effFrom && effTo && effFrom > effTo) return toast.error('生效日期不能晚于结束日期');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('scope', scope);
    if (effFrom) fd.append('effective_from', effFrom);
    if (effTo) fd.append('effective_to', effTo);
    if (scope === 'grade') fd.append('grade', scopeGrade);
    if (scope === 'term') fd.append('scope_term', scopeTerm);
    if (makeupSet !== '') fd.append('makeup_set', makeupSet);
    try {
      const res = await api.post('/schedules/import', fd);
      const { inserted, errors } = res.data.data;
      const range = effFrom ? `${effFrom}${effTo ? '~' + effTo : ' 起'}` : '';
      const mode = scope === 'append' ? `追加${range ? '（' + range + '）' : ''}` : `替换（${scope === 'all' ? '全校' : scope === 'grade' ? '年级 ' + scopeGrade : '时段 ' + scopeTerm}，${range}）`;
      if (errors.length) toast.warn(`导入成功 ${inserted} 条（${mode}），${errors.length} 条未导入`);
      else toast.success(`导入成功 ${inserted} 条（${mode}）`);
      setFile(null);
      setShowImport(false);
      loadSchedules();
    } catch (e) { toast.error(errMsg(e)); }
  };

  const onDrop = async (targetScheduleId) => {
    if (drag == null || drag === targetScheduleId) { setDrag(null); return; }
    try {
      const src = rows.find((r) => r.id === drag);
      const dst = rows.find((r) => r.id === targetScheduleId);
      if (!src || !dst) { setDrag(null); return; }
      await api.post('/schedules/adjust', { schedule_id: drag, change_type: '调课', from_teacher_id: src.teacher_id, to_teacher_id: dst.teacher_id, reason: '拖拽调课' });
      await api.post('/schedules/adjust', { schedule_id: targetScheduleId, change_type: '调课', from_teacher_id: dst.teacher_id, to_teacher_id: src.teacher_id, reason: '拖拽调课' });
      toast.success('调课成功');
      setDrag(null);
      loadSchedules();
    } catch (e) { toast.error(errMsg(e)); setDrag(null); }
  };

  const substitute = async (scheduleId, teacherId, fromDate, toDate) => {
    if (!(await toast.confirm('确定代课？', { danger: true }))) return;
    try {
      await api.post('/schedules/adjust', {
        schedule_id: scheduleId, change_type: '代课', from_teacher_id: null, to_teacher_id: teacherId,
        from_date: fromDate || null, to_date: toDate || null, reason: '代课',
      });
      toast.success(toDate ? `代课成功（至 ${toDate}，之后自动换回）` : fromDate ? `代课成功（${fromDate} 起）` : '代课成功');
      loadSchedules();
    } catch (e) { toast.error(errMsg(e)); }
  };

  // 日期字符串 +1 天，用于把「结束日」转成左闭右开区间的「次日」
  const addDay = (dateStr) => {
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  // 课务调整的生效区间显示（课表级用 from_date/to_date 左闭右开；按日级用 date）
  const rangeLabel = (c) => {
    if (c.source === 'instance') return c.date || '-';
    if (!c.from_date) return '-';
    if (!c.to_date) return `${c.from_date} 起`;
    return `${c.from_date} ~ ${dayBefore(c.to_date)}`;
  };
  const dayBefore = (dateStr) => {
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() - 1);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  const stopClass = async (scheduleId) => {
    if (!(await toast.confirm('确定停课？', { danger: true }))) return;
    try {
      await api.post('/schedules/adjust', { schedule_id: scheduleId, change_type: '停课', reason: '停课' });
      toast.success('停课成功');
      loadSchedules();
    } catch (e) { toast.error(errMsg(e)); }
  };

  // 格子里一门课的紧凑显示标签
  const cellLabel = (s) => {
    const tok = layerToken(s.class_name);
    const layer = tok.replace('层', '');
    const subjAbbr = abbr(baseSubject(s.subject));
    if (s.form === '分层') return `${subjAbbr}${layer}`;
    if (s.form === '走班分层') return `${subjAbbr}${layer}`;
    if (s.form === '走班') return subjAbbr;
    return s.subject || subjAbbr; // 行政班显示完整科目
  };

  // 走班课块（简称色块）
  const renderWalk = (s) => (
    <span key={s.id} className="abbr-chip" title={`${s.class_name} · ${s.subject} · ${s.teacher_name}`}>
      {cellLabel(s)}
    </span>
  );

  // 常规/分层课块（可拖拽调课）
  const renderRegular = (s, stacked) => (
    <div
      key={s.id}
      className={`sch pt-${s.period_type}`}
      draggable
      onDragStart={() => setDrag(s.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDrop(s.id)}
      title={`${s.class_name} · ${s.subject} · ${s.teacher_name}${s.term && s.term !== '常规' ? ' · ' + s.term : ''}`}
      style={drag === s.id ? { opacity: 0.5 } : undefined}
    >
      <span className="sub">{cellLabel(s)}</span>
      {!stacked && <span className="teacher">{s.teacher_name}</span>}
      {s.term && s.term !== '常规' && <span className="term-tag">{s.term}</span>}
    </div>
  );

  // 某个 (day, period) 格子的内容
  const isWalk = (r) => r.form === '走班' || r.form === '走班分层';
  const renderCell = (cellRows) => {
    const walk = cellRows.filter(isWalk);
    const regular = cellRows.filter((r) => !isWalk(r));
    return (
      <React.Fragment>
        {regular.length === 1
          ? renderRegular(regular[0], false)
          : regular.length > 1
            ? <div className="sch-stack">{regular.map((r) => renderRegular(r, true))}</div>
            : null}
        {walk.length > 0 && <div className="abbr-chips">{walk.map(renderWalk)}</div>}
      </React.Fragment>
    );
  };

  // 计算某班课表中「有课的天」（1-7），整天没课的天不显示这一列
  const activeDays = (gridRows) => {
    const days = new Set(gridRows.filter((r) => r.day_of_week >= 1 && r.day_of_week <= 7).map((r) => r.day_of_week));
    return [1, 2, 3, 4, 5, 6, 7].filter((d) => days.has(d));
  };

  // 渲染一张完整网格
  const renderGrid = (gridRows, title, readonly = false) => {
    const maxPeriod = Math.max(1, ...gridRows.map((r) => r.period_no));
    const periods = Array.from({ length: maxPeriod }, (_, i) => i + 1);
    const days = activeDays(gridRows);
    return (
      <div>
        <div className="grid-title">{title}</div>
        <div className="schedule-grid" style={{ gridTemplateColumns: `52px repeat(${days.length}, 1fr)` }}>
          <div className="cell head">节次</div>
          {days.map((d) => <div key={d} className="cell head">{DAYS[d - 1]}</div>)}
          {periods.map((p) => (
            <React.Fragment key={p}>
              <div className="cell head">第{p}节</div>
              {days.map((d) => {
                const cellRows = gridRows.filter((r) => r.period_no === p && r.day_of_week === d);
                if (!cellRows.length) return <div key={d} className="cell"><span className="muted">空</span></div>;
                return (
                  <div key={d} className={`cell ${readonly ? '' : 'clickable'}`}
                    onClick={() => !readonly && setDetail({ title, day: d - 1, period: p, rows: cellRows })}>
                    {renderCell(cellRows)}
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  };

  // 缩略图：某班迷你周课表（只显示科目色块，不显示教师）
  const renderThumbnail = (ac) => {
    const gridRows = rows.filter((r) => adminIdsOf(r).includes(ac.id));
    const maxPeriod = Math.max(1, ...gridRows.map((r) => r.period_no));
    const periods = Array.from({ length: maxPeriod }, (_, i) => i + 1);
    const days = activeDays(gridRows);
    return (
      <div className="thumb-grid">
        <div className="thumb-row">
          <div className="thumb-period" />
          {days.map((d) => <div key={d} className="thumb-day">{DAYS[d - 1]}</div>)}
        </div>
        {periods.map((p) => (
          <div key={p} className="thumb-row">
            <div className="thumb-period">{p}</div>
            {days.map((d) => {
              const cell = gridRows.filter((r) => r.period_no === p && r.day_of_week === d);
              if (!cell.length) return <div key={d} className="thumb-cell empty" />;
              return (
                <div key={d} className="thumb-cell">
                  {cell.slice(0, 2).map((s) => (
                    <span key={s.id} className="thumb-chip" style={{ background: subjectColor(s.subject) }} title={`${s.subject} · ${s.teacher_name}`}>
                      {abbr(baseSubject(s.subject))}
                    </span>
                  ))}
                  {cell.length > 2 && <span className="thumb-more">+{cell.length - 2}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    );
  };

  // 按年级分组渲染缩略图总览
  const renderOverview = () => {
    const adminClasses = classes
      .filter((c) => c.type === '行政班' && (!grade || c.grade === grade))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh', { numeric: true }));
    const byGrade = {};
    for (const ac of adminClasses) (byGrade[ac.grade || '未分年级'] ||= []).push(ac);
    const gradeOrder = [...new Set(classes.map((c) => c.grade).filter(Boolean))].sort();
    const keys = [...gradeOrder, '未分年级'].filter((g) => byGrade[g]?.length);

    return (
      <div>
        {keys.map((g) => (
          <div key={g} className="thumb-grade">
            <div className="thumb-grade-title">{g}</div>
            <div className="thumb-cards">
              {byGrade[g].map((ac) => (
                <button key={ac.id} className="thumb-card" onClick={() => { setFocusClass(String(ac.id)); setClassId(String(ac.id)); }}>
                  <div className="thumb-name">{ac.name}</div>
                  {renderThumbnail(ac)}
                </button>
              ))}
            </div>
          </div>
        ))}
        {adminClasses.length === 0 && <p className="muted">暂无行政班，请先在「班级信息」建班。</p>}
      </div>
    );
  };

  // 单班下钻：左侧年级导航 + 右侧完整课表
  const renderFocus = () => {
    const ac = classById.get(Number(focusClass));
    if (!ac) { setFocusClass(''); return null; }
    const gridRows = rows.filter((r) => adminIdsOf(r).includes(ac.id));
    // 同年级行政班导航
    const siblings = classes
      .filter((c) => c.type === '行政班' && c.grade === ac.grade)
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh', { numeric: true }));
    return (
      <div className="focus-wrap">
        <div className="focus-nav">
          <button className="btn sm" onClick={() => { setFocusClass(''); setClassId(''); }}>‹ 返回总览</button>
          <div className="focus-nav-title">{ac.grade || '未分年级'}</div>
          {siblings.map((s) => (
            <button key={s.id} className={`focus-nav-item ${String(s.id) === focusClass ? 'on' : ''}`} onClick={() => { setFocusClass(String(s.id)); setClassId(String(s.id)); }}>
              {s.name}
            </button>
          ))}
        </div>
        <div className="focus-main">
          {renderGrid(gridRows, `${ac.name}${ac.grade ? ' · ' + ac.grade : ''}`)}
        </div>
      </div>
    );
  };

  // 补课课表：按套号分组，每套内每个行政班一张卡片；卡片内按节次纵向列出课程（分层/走班折叠进所属行政班）。
  // 注：套号型补课课表 day_of_week=0（一整套独立课表，补课日整套使用、不看星期），故不能套星期网格，改为按节次纵向。
  const renderMakeupGrids = () => {
    const sets = [...new Set(makeupRows.map((r) => r.makeup_set)).values()]
      .filter((s) => s != null)
      .sort((a, b) => a - b);
    // 若存在无套号的补课课表，归为一组「未标记套号」
    const hasUnmarked = makeupRows.some((r) => r.makeup_set == null);
    const setKeys = [...sets];
    if (hasUnmarked) setKeys.push(null);

    // 一门课程的显示标签：行政班显示完整科目；分层/走班补层标识
    const courseLabel = (r) => {
      const tok = layerToken(r.class_name);
      const layer = tok.replace('层', '');
      const subj = baseSubject(r.subject || '');
      if (r.form === '分层' || r.form === '走班分层') return `${subj}${layer}`;
      return r.subject || subj;
    };

    const renderClassCard = (ac, setRows) => {
      const gridRows = setRows.filter((r) => adminIdsOf(r).includes(ac.id));
      const maxPeriod = Math.max(1, ...gridRows.map((r) => r.period_no));
      const periods = Array.from({ length: maxPeriod }, (_, i) => i + 1);
      return (
        <div className="grid-card" key={ac.id}>
          <div className="grid-title">{ac.name}</div>
          <div className="makeup-periods">
            {periods.map((p) => {
              const cellRows = gridRows.filter((r) => r.period_no === p);
              if (!cellRows.length) return null;
              return (
                <div className="makeup-row" key={p}>
                  <div className="makeup-period">第{p}节</div>
                  <div className="makeup-courses">
                    {cellRows.map((r) => (
                      <span key={r.id} className="makeup-course" title={`${r.class_name} · ${r.subject} · ${r.teacher_name}`}>
                        <span className="makeup-course-subj">{courseLabel(r)}</span>
                        <span className="makeup-course-teacher">{r.teacher_name}</span>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
            {gridRows.length === 0 && <p className="muted">该班暂无补课安排</p>}
          </div>
        </div>
      );
    };

    return (
      <div>
        {setKeys.length > 0 && (
          <div className="makeup-tabs">
            {setKeys.map((set) => {
              const setRows = makeupRows.filter((r) => (set == null ? r.makeup_set == null : r.makeup_set === set));
              const setGrade = [...new Set(setRows.map((r) => r.grade).filter(Boolean))].sort();
              const label = set == null ? '未标套号' : `第 ${set} 套${setGrade.length ? ' · ' + setGrade.join('/') : ''}`;
              return (
                <button key={String(set)} className={`btn sm ${makeupTab === set ? 'primary' : ''}`} onClick={() => setMakeupTab(set)}>{label}</button>
              );
            })}
          </div>
        )}

        {setKeys.map((set) => {
          if (makeupTab !== null && makeupTab !== set) return null;
          const setRows = makeupRows.filter((r) => (set == null ? r.makeup_set == null : r.makeup_set === set));
          const setGrade = [...new Set(setRows.map((r) => r.grade).filter(Boolean))].sort();
          const adminClasses = classes
            .filter((c) => c.type === '行政班' && setRows.some((r) => adminIdsOf(r).includes(c.id)))
            .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh', { numeric: true }));
          const setTitle = set == null ? '补课课表 · 未标记套号' : `第 ${set} 套补课课表${setGrade.length ? ' · ' + setGrade.join('/') : ''}`;
          return (
            <div key={String(set)} className="makeup-set">
              <div className="makeup-set-title">
                <span>{setTitle}</span>
                <span className="makeup-set-count">{adminClasses.length} 个班</span>
                {set != null && (
                  <button className="btn sm danger makeup-set-del" onClick={() => deleteMakeupSet(set)}>删除本套</button>
                )}
              </div>
              <div className="grids">
                {adminClasses.map((ac) => renderClassCard(ac, setRows))}
              </div>
            </div>
          );
        })}
        {makeupRows.length === 0 && <p className="muted">暂无补课课表，请先在上方「导入课表」时段选「节假补课」导入。</p>}
      </div>
    );
  };

  return (
    <div>
      <div className="page-head">
        <h2 className="page-title">课表与调课</h2>
        <p className="page-sub">行政班、分层、走班合并显示 · 点击格子看详情 · 拖拽课块调换教师</p>
      </div>

      {error && <div className="alert error">{error}</div>}

      <div className="card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>课表</h3>
        <button className="btn primary" onClick={() => setShowImport(true)}>导入课表</button>
      </div>

      {showImport && (
        <div className="modal-overlay" onClick={() => setShowImport(false)}>
          <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>导入课表</h3>
              <button className="btn ghost" onClick={() => setShowImport(false)}>关闭</button>
            </div>
            <div className="toolbar">
              <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files[0])} style={{ width: 'auto' }} />
              <select value={scope} onChange={(e) => setScope(e.target.value)} style={{ width: 140 }}>
                <option value="append">追加（不改旧表）</option>
                <option value="all">整体替换（全校）</option>
                <option value="grade">替换某年级</option>
                <option value="term">替换某时段</option>
              </select>
              <input type="date" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} title="生效日期（可选）" />
              {effFrom && (
                <input type="date" value={effTo} onChange={(e) => setEffTo(e.target.value)} title="结束日期（留空=不设终点）" />
              )}
              {scope === 'grade' && (
                <select value={scopeGrade} onChange={(e) => setScopeGrade(e.target.value)} style={{ width: 130 }}>
                  <option value="">选择年级</option>
                  {grades.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              )}
              {scope === 'term' && (
                <select value={scopeTerm} onChange={(e) => setScopeTerm(e.target.value)} style={{ width: 140 }}>
                  <option value="">选择时段</option>
                  {TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              )}
              <input type="number" min="1" step="1" value={makeupSet} onChange={(e) => setMakeupSet(e.target.value)} placeholder="套号(补课)" style={{ width: 100 }} title="补课课表套号：导入「节假补课」时填 1/2/3 区分多套轮换" />
              <button className="btn primary" onClick={importFile} disabled={!file}>导入</button>
              <button className="btn" onClick={downloadTemplate}>下载导入模板</button>
            </div>
            <p className="muted" style={{ margin: '12px 0 0', fontSize: 12.5 }}>
              追加保留旧表；替换从生效日期起启用新表（历史数据保留，统计不受影响）。
            </p>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 12.5 }}>
              补课课表：时段选「节假补课」，套号填 1/2/3 区分多套轮换，之后在校历标「补课 + 第几套」。
            </p>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <button className={`btn ${view === 'grid' ? 'primary' : ''}`} onClick={() => setView('grid')}>课表视图</button>
            <button className={`btn ${view === 'makeup' ? 'primary' : ''}`} onClick={() => setView('makeup')}>补课课表</button>
            <button className={`btn ${view === 'changes' ? 'primary' : ''}`} onClick={() => setView('changes')}>课务调整</button>
          </div>
        </div>

        {view === 'grid' && (
          <>
            <div className="toolbar">
              <select value={grade} onChange={(e) => { setGrade(e.target.value); setFocusClass(''); setClassId(''); }} style={{ width: 130 }}>
                <option value="">全部年级</option>
                {grades.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              <select value={term} onChange={(e) => setTerm(e.target.value)} style={{ width: 150 }}>
                <option value="">全部时段</option>
                {TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              {focusClass && <span className="hint">{classById.get(Number(focusClass))?.name} · 点击格子看详情 · 拖拽调课</span>}
              {!focusClass && <span className="hint">点击班级缩略图查看完整课表</span>}
            </div>
            {rows.length === 0 ? <p className="muted">暂无课表数据，请先导入。</p> : (focusClass ? renderFocus() : renderOverview())}
          </>
        )}

        {view === 'makeup' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>按套号分组展示，导入时在「套号」填 1/2/3 区分多套轮换。</p>
            {renderMakeupGrids()}
          </>
        )}

        {view === 'changes' && (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>类型</th><th>年级</th><th>班级</th><th>课程</th><th>日期/星期</th><th>节次</th><th>原教师</th><th>新教师</th><th>原因</th><th>操作人</th><th>时间</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {changes.map((c) => (
                    <tr key={`${c.source}-${c.id}`}>
                      <td><span className={`badge ${c.change_type === '代课' ? 'warn' : c.change_type === '停课' ? 'danger' : 'info'}`}>{c.change_type}{c.reverted ? '·已撤回' : ''}</span></td>
                      <td>{c.class_grade || '-'}</td>
                      <td>{c.class_name || '-'}</td>
                      <td>{c.subject || '-'}</td>
                      <td>{c.source === 'instance' ? (c.date || '-') : (c.day_of_week ? `周${'一二三四五六日'[c.day_of_week - 1]}` : '-')}</td>
                      <td>{c.period_no ? `第${c.period_no}节` : '-'}</td>
                      <td>{c.from_teacher_name || '-'}</td>
                      <td>{c.to_teacher_name || '-'}</td>
                      <td>{c.reason || '-'}</td>
                      <td>{c.operator_name || '-'}</td>
                      <td>{String(c.created_at || '').replace('T', ' ').slice(0, 16)}</td>
                      <td>
                        <div className="toolbar" style={{ marginBottom: 0, gap: 6 }}>
                          <button className="btn sm" onClick={() => setPrintChange(c)}>打印通知单</button>
                          {c.source === 'schedule' && !c.reverted && (
                            <button className="btn sm" onClick={() => revertChange(c)}>撤回</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {changes.length === 0 && <tr><td colSpan={12} className="muted">暂无课务调整记录</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {printChange && (
        <div className="modal-overlay" onClick={() => setPrintChange(null)}>
          <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head no-print">
              <h3>打印通知单</h3>
              <div className="toolbar" style={{ marginBottom: 0, gap: 8 }}>
                <button className="btn primary sm" onClick={() => window.print()}>打印</button>
                <button className="btn ghost sm" onClick={() => setPrintChange(null)}>关闭</button>
              </div>
            </div>
            <PrintSheet c={printChange} rangeLabel={rangeLabel} />
          </div>
        </div>
      )}

      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{detail.title} · {DAYS[detail.day]} 第{detail.period}节</h3>
              <button className="btn ghost" onClick={() => setDetail(null)}>关闭</button>
            </div>
            <table>
              <thead><tr><th>课程</th><th>形式</th><th>班级</th><th>教师</th><th>类型</th><th style={{ width: 250 }}>操作</th></tr></thead>
              <tbody>
                {detail.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="strong">{r.subject || '-'}</td>
                    <td><span className={`badge ${r.form === '走班' || r.form === '走班分层' ? 'warn' : r.form === '分层' ? 'info' : ''}`}>{FORM_LABEL[r.form] || r.form}</span></td>
                    <td>{r.class_name}</td>
                    <td>{r.teacher_name}</td>
                    <td>
                      <span className={`period-tag period-${r.period_type}`}>{r.period_type}</span>
                      {r.term && r.term !== '常规' && <span className="period-tag period-晚自习" style={{ marginLeft: 3 }}>{r.term}</span>}
                    </td>
                    <td>
                      <div className="toolbar" style={{ marginBottom: 0, alignItems: 'center' }}>
                        <select id={`sub-${r.id}`} defaultValue="">
                          <option value="" disabled>代课教师</option>
                          {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                        <input type="date" id={`sub-from-${r.id}`} title="开始日期（留空=立即起）" style={{ width: 140 }} />
                        <input type="date" id={`sub-to-${r.id}`} title="结束日期（留空=长期；填了则到该日自动换回）" style={{ width: 140 }} />
                        <button className="btn sm primary" onClick={() => {
                          const sel = document.getElementById(`sub-${r.id}`).value;
                          if (!sel) return setError('请选择代课教师');
                          const from = document.getElementById(`sub-from-${r.id}`).value;
                          const to = document.getElementById(`sub-to-${r.id}`).value;
                          // 结束日 → 左闭右开「次日」；未填结束=长期
                          const toDate = to ? addDay(to) : null;
                          substitute(r.id, Number(sel), from || null, toDate);
                        }}>代课</button>
                        <button className="btn sm danger" onClick={() => stopClass(r.id)}>停课</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
