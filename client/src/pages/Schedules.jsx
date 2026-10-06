import React, { useEffect, useState } from 'react';
import api, { errMsg } from '../api.js';

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

// 从班级名中提取层标识（如 '高一(1)班数学A层' -> 'A层'）
const layerToken = (name) => {
  const m = /([A-Za-z0-9一二三四五六七八九十]+层)/.exec(name || '');
  return m ? m[1] : '';
};
// 去掉科目尾部的层标识
const baseSubject = (s) => (s || '').replace(/[A-Za-z0-9一二三四五六七八九十]+层$/, '').trim();

export default function Schedules() {
  const [rows, setRows] = useState([]);
  const [classes, setClasses] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
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

  const load = async () => {
    try {
      const [c, t] = await Promise.all([api.get('/classes'), api.get('/teachers')]);
      setClasses(c.data.data); setTeachers(t.data.data);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const loadMakeup = async () => {
    try {
      const r = await api.get('/schedules', { params: { term: '节假补课', include_inactive: '1' } });
      setMakeupRows(r.data.data);
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { if (view === 'makeup') loadMakeup(); }, [view]);

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
    if (!file) return setError('请先选择课表文件（.xlsx / .csv）');
    if (scope !== 'append' && !effFrom) return setError('替换导入需指定生效日期');
    if (effFrom && effTo && effFrom > effTo) return setError('生效日期不能晚于结束日期');
    setError(''); setMsg('');
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
      setMsg(`导入成功 ${inserted} 条（${mode}）${errors.length ? `，${errors.length} 条未导入` : ''}`);
      setFile(null);
      loadSchedules();
    } catch (e) { setError(errMsg(e)); }
  };

  const onDrop = async (targetScheduleId) => {
    if (drag == null || drag === targetScheduleId) { setDrag(null); return; }
    try {
      const src = rows.find((r) => r.id === drag);
      const dst = rows.find((r) => r.id === targetScheduleId);
      if (!src || !dst) { setDrag(null); return; }
      await api.post('/schedules/adjust', { schedule_id: drag, change_type: '调课', from_teacher_id: src.teacher_id, to_teacher_id: dst.teacher_id, reason: '拖拽调课' });
      await api.post('/schedules/adjust', { schedule_id: targetScheduleId, change_type: '调课', from_teacher_id: dst.teacher_id, to_teacher_id: src.teacher_id, reason: '拖拽调课' });
      setMsg('调课成功');
      setDrag(null);
      loadSchedules();
    } catch (e) { setError(errMsg(e)); setDrag(null); }
  };

  const substitute = async (scheduleId, teacherId, fromDate, toDate) => {
    try {
      await api.post('/schedules/adjust', {
        schedule_id: scheduleId, change_type: '代课', from_teacher_id: null, to_teacher_id: teacherId,
        from_date: fromDate || null, to_date: toDate || null, reason: '代课',
      });
      setMsg(toDate ? `代课成功（至 ${toDate}，之后自动换回）` : fromDate ? `代课成功（${fromDate} 起）` : '代课成功');
      loadSchedules();
    } catch (e) { setError(errMsg(e)); }
  };

  // 日期字符串 +1 天，用于把「结束日」转成左闭右开区间的「次日」
  const addDay = (dateStr) => {
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + 1);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  const stopClass = async (scheduleId) => {
    try {
      await api.post('/schedules/adjust', { schedule_id: scheduleId, change_type: '停课', reason: '停课' });
      setMsg('停课成功');
      loadSchedules();
    } catch (e) { setError(errMsg(e)); }
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

  // 渲染一张完整网格
  const renderGrid = (gridRows, title, readonly = false) => {
    const maxPeriod = Math.max(1, ...gridRows.map((r) => r.period_no));
    const periods = Array.from({ length: maxPeriod }, (_, i) => i + 1);
    return (
      <div>
        <div className="grid-title">{title}</div>
        <div className="schedule-grid">
          <div className="cell head">节次</div>
          {DAYS.map((d) => <div key={d} className="cell head">{d}</div>)}
          {periods.map((p) => (
            <React.Fragment key={p}>
              <div className="cell head">第{p}节</div>
              {DAYS.map((_, di) => {
                const cellRows = gridRows.filter((r) => r.period_no === p && r.day_of_week === di + 1);
                if (!cellRows.length) return <div key={di} className="cell"><span className="muted">空</span></div>;
                return (
                  <div key={di} className={`cell ${readonly ? '' : 'clickable'}`}
                    onClick={() => !readonly && setDetail({ title, day: di, period: p, rows: cellRows })}>
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

  const renderGrids = () => {
    // 班级课表：单张网格（后端已合并该班自身 + 分层子班 + 合班走班）
    if (classId) {
      const c = classById.get(Number(classId));
      return renderGrid(rows, c ? c.name : '班级课表');
    }
    // 总课表 / 年级课表：每个行政班一张网格，分层/走班折叠进所属行政班
    const adminClasses = classes
      .filter((c) => c.type === '行政班' && (!grade || c.grade === grade))
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
    const grids = adminClasses.map((ac) => {
      const gridRows = rows.filter((r) => adminIdsOf(r).includes(ac.id));
      return (
        <div className="grid-card" key={ac.id}>
          {renderGrid(gridRows, `${ac.name}${ac.grade ? ' · ' + ac.grade : ''}`)}
        </div>
      );
    });
    return <div className="grids">{grids}</div>;
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
        {setKeys.map((set) => {
          const setRows = makeupRows.filter((r) => (set == null ? r.makeup_set == null : r.makeup_set === set));
          const setGrade = [...new Set(setRows.map((r) => r.grade).filter(Boolean))].sort();
          const adminClasses = classes
            .filter((c) => c.type === '行政班' && setRows.some((r) => adminIdsOf(r).includes(c.id)))
            .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
          const setTitle = set == null ? '补课课表 · 未标记套号' : `第 ${set} 套补课课表${setGrade.length ? ' · ' + setGrade.join('/') : ''}`;
          return (
            <div key={String(set)} className="makeup-set">
              <div className="makeup-set-title">{setTitle}<span className="makeup-set-count">{adminClasses.length} 个班</span></div>
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
        <p className="page-sub">每个班级一张课表：行政班、分层、走班合并显示；点击任意格子查看详情并可代课/停课，拖拽课块可调换教师</p>
      </div>

      {error && <div className="alert error">{error}</div>}
      {msg && <div className="alert success">{msg}</div>}

      <div className="card">
        <h3>导入课表</h3>
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
        <p className="muted" style={{ margin: 0 }}>表头：班级、星期、节次、类型、时段、课程名称、教师。按「课程名称」导入；班级填「班级信息」里的名称（行政班/分层/走班），系统自动识别上课形式并合并到对应班级课表。</p>
        <p className="muted" style={{ margin: '4px 0 0' }}>「追加」保留旧课表不变，可选填生效/结束日期（如补课课表只在一段日期内生效）；「替换」从生效日期起关闭选定范围内旧课表、启用新表（旧数据仍保留，历史统计不受影响）。</p>
        <p className="muted" style={{ margin: '4px 0 0' }}>补课课表轮换：时段选「节假补课」，每个文件导入为一套，在「套号」填 1/2/3（高一/高二两套、高三三套）；之后在校历把补课周日标「补课 + 用第几套」即可按套轮换、按节假日标准计酬。</p>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <button className={`btn ${view === 'grid' ? 'primary' : ''}`} onClick={() => setView('grid')}>课表视图</button>
            <button className={`btn ${view === 'makeup' ? 'primary' : ''}`} onClick={() => setView('makeup')}>补课课表</button>
          </div>
        </div>

        {view === 'grid' && (
          <>
            <div className="toolbar">
              <select value={classId} onChange={(e) => setClassId(e.target.value)} style={{ width: 170 }}>
                <option value="">全部班级（总课表）</option>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.name}（{c.type}）</option>)}
              </select>
              <select value={grade} onChange={(e) => setGrade(e.target.value)} style={{ width: 130 }}>
                <option value="">全部年级</option>
                {grades.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              <select value={term} onChange={(e) => setTerm(e.target.value)} style={{ width: 150 }}>
                <option value="">全部时段</option>
                {TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <span className="hint">选班级看单班课表；全部/年级视图按「每个行政班一张课表」展示；点击格子看详情。</span>
            </div>
            {rows.length === 0 ? <p className="muted">暂无课表数据，请先导入。</p> : renderGrids()}
          </>
        )}

        {view === 'makeup' && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>节假补课课表，按套号分组、以课表网格呈现；分层/走班折叠进所属行政班。导入时在「套号」填 1/2/3 区分多套轮换。</p>
            {renderMakeupGrids()}
          </>
        )}
      </div>

      {detail && (
        <div className="modal-overlay" onClick={() => setDetail(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{detail.title} · {DAYS[detail.day]} 第{detail.period}节</h3>
              <button className="btn ghost" onClick={() => setDetail(null)}>关闭</button>
            </div>
            <p className="muted" style={{ marginTop: 0 }}>该格子的全部课程，可逐门代课或停课。</p>
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
                      <p className="muted" style={{ margin: '4px 0 0', fontSize: 12 }}>代课留空日期=长期；只填结束日期=单日；填开始+结束=区间（结束后自动换回原教师）。</p>
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
