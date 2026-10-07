import React, { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import api, { errMsg } from '../api.js';

const STATUS = { pending: '待审核', approved: '已通过', rejected: '已驳回', withdrawn: '已撤回' };
const STATUS_CLS = { pending: 'warn', approved: 'ok', rejected: '', withdrawn: 'info' };
const TYPE_ICON = { 答疑: '问', 晚自习: '晚', 晚练: '练', 早自习: '早' };

export default function MobileApply() {
  const location = useLocation();
  // 在移动壳内（/m/apply）作为 tab 时，嵌入壳视觉；独立 /apply 页保留原品牌 header
  const embedded = location.pathname.startsWith('/m');
  const [self, setSelf] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [mode, setMode] = useState(null); // '答疑' | '晚自习' | '早自习' | '批量' | null(首页)
  const [loading, setLoading] = useState(true);

  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const isAdmin = ['admin', '教务员', '教务处'].includes(user.role);
  const isGradeLeader = user.role === '年级组长';
  const canBatch = isAdmin || isGradeLeader;

  // 表单
  const [grade, setGrade] = useState('');
  const [classId, setClassId] = useState('');
  const [date, setDate] = useState(() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
  const [periodCount, setPeriodCount] = useState(1);
  const [content, setContent] = useState('');

  // 批量申报（教务员/年级组长）：公共字段填一次 + 教师多选
  const [batchCtx, setBatchCtx] = useState(null);
  const [batchGrade, setBatchGrade] = useState('');
  const [batchType, setBatchType] = useState('答疑');
  const [batchClassId, setBatchClassId] = useState('');
  const [batchDate, setBatchDate] = useState('');
  const [batchPeriodCount, setBatchPeriodCount] = useState(1);
  const [batchContent, setBatchContent] = useState('');
  const [selectedTeachers, setSelectedTeachers] = useState([]); // 选中的教师 id 数组
  const [teacherQuery, setTeacherQuery] = useState(''); // 教师搜索过滤

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/applications/self');
      setSelf(r.data.data);
      setError('');
    } catch (e) { setError(errMsg(e)); }
    setLoading(false);
  };
  const loadBatchCtx = async () => {
    try { setBatchCtx((await api.get('/applications/batch-context')).data.data); } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); if (canBatch) loadBatchCtx(); }, []);

  const today = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  const openMode = (m) => {
    setMode(m);
    setMsg(''); setError('');
    setGrade(''); setClassId(''); setContent('');
    setDate(today()); setPeriodCount(1);
    if (m === '批量') {
      setBatchGrade(batchCtx?.managed_grade || '');
      setBatchType(batchCtx?.typePays?.[0]?.name || '答疑');
      setBatchClassId('');
      setBatchDate(today());
      setBatchPeriodCount(1);
      setBatchContent('');
      setSelectedTeachers([]);
      setTeacherQuery('');
    }
  };

  const submit = async () => {
    setError(''); setMsg('');
    if (!self.teacher) return setError('你的账号尚未绑定教师档案，请联系教务员绑定后再申报');
    if (mode === '答疑' && !grade) return setError('请选择年级');
    if (mode === '晚自习' && !classId) return setError('请选择班级');
    if (mode === '早自习' && !grade) return setError('请选择年级');
    if (!date) return setError('请选择日期');
    try {
      // 答疑/早自习为年级级（挂年级虚班）；晚自习为班级级（挂行政班）
      const isGradeLevel = mode === '答疑' || mode === '早自习';
      const virtualClassId = isGradeLevel
        ? (self.qna_grades.find((g) => g.grade === grade)?.virtual_class_id ?? null)
        : null;
      const payload = {
        grade: isGradeLevel ? grade : (self.evening_classes.find((c) => c.id === Number(classId))?.grade || ''),
        subject: self.teacher.subject,
        class_id: isGradeLevel ? virtualClassId : Number(classId),
        date,
        period_count: periodCount,
        period_type: mode,
        content: content || null,
      };
      await api.post('/applications', payload);
      setMsg(`${mode}申报已提交，待教务处审核`);
      setMode(null);
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  const del = async (id) => {
    if (!window.confirm('确定删除该申报记录？')) return;
    try { await api.delete(`/applications/${id}`); load(); } catch (e) { setError(errMsg(e)); }
  };

  // ===== 批量申报（教务员/年级组长，同一天·同类型·多教师） =====
  const toggleTeacher = (id) => {
    setSelectedTeachers((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));
  };
  const toggleAllTeachers = (list) => {
    const allIds = list.map((t) => String(t.id));
    const allSelected = allIds.length > 0 && allIds.every((id) => selectedTeachers.includes(id));
    setSelectedTeachers(allSelected ? [] : allIds);
  };
  const submitBatch = async () => {
    setError(''); setMsg('');
    if (!batchGrade) return setError('请选择年级');
    if (!batchType) return setError('请选择类型');
    if (!batchDate) return setError('请选择日期');
    if (!selectedTeachers.length) return setError('请至少选择一位教师');
    const items = selectedTeachers.map((tid) => {
      const t = (batchCtx?.teachers || []).find((x) => String(x.id) === String(tid));
      return {
        grade: batchGrade, subject: t?.subject || '', teacher_id: tid,
        class_id: batchClassId || null, date: batchDate,
        period_count: batchPeriodCount, period_type: batchType, content: batchContent,
      };
    });
    try {
      const res = await api.post('/applications/batch', { items });
      const { inserted, errors } = res.data.data;
      setMsg(`批量申报已提交 ${inserted} 条待审核${errors.length ? `，${errors.length} 条失败` : ''}`);
      if (errors.length) setError(errors.join('；'));
      setSelectedTeachers([]);
      setMode(null);
      load();
    } catch (e) { setError(errMsg(e)); }
  };

  if (loading) return <div className="mapply"><div className="mapply-loading">加载中…</div></div>;

  const teacher = self?.teacher;
  const notBound = !teacher;

  // 批量申报：按所选年级 + 搜索词过滤的可见教师
  const visibleBatchTeachers = (batchCtx?.teachers || []).filter((t) => {
    if (teacherQuery && !t.name.includes(teacherQuery)) return false;
    if (batchGrade && Array.isArray(t.grades) && t.grades.length && !t.grades.includes(batchGrade)) return false;
    return true;
  });

  return (
    <div className={`mapply${embedded ? ' mapply-embedded' : ''}`}>
      {!embedded && (
        <header className="mapply-top">
          <div className="mapply-brand">
            <div className="mapply-mark">教</div>
            <div>
              <div className="mapply-title">自主申报</div>
              <div className="mapply-sub">{teacher ? `${teacher.name} · ${teacher.subject}` : '课程中心'}</div>
            </div>
          </div>
        </header>
      )}

      {embedded && (
        <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
          <div>
            <div className="mt-title">自主申报</div>
            <div className="mt-sub">{teacher ? `${teacher.name} · ${teacher.subject}` : '课程中心'}</div>
          </div>
        </div>
      )}

      {error && <div className="alert error">{error}</div>}
      {msg && <div className="alert success">{msg}</div>}

      {notBound && (
        <div className="mapply-notice">
          你的账号尚未绑定教师档案，无法自主申报。请联系教务员在「账号管理」里为你的账号绑定教师档案。
        </div>
      )}

      {/* 首页：两个大入口 + 我的记录 */}
      {!mode && (
        <>
          <div className="mapply-hero">
            <h1>老师好，今天要申报什么课务？</h1>
            <p>提交后由教务处审核，通过即按次计酬。</p>
          </div>
          <div className="mapply-cards">
            <button className="mapply-card" disabled={notBound} onClick={() => openMode('答疑')}>
              <div className="mapply-card-icon qa">问</div>
              <div className="mapply-card-body">
                <div className="mapply-card-title">申报答疑</div>
                <div className="mapply-card-desc">针对年级 · 临时某天某次</div>
              </div>
              <div className="mapply-card-arrow">›</div>
            </button>
            <button className="mapply-card" disabled={notBound} onClick={() => openMode('晚自习')}>
              <div className="mapply-card-icon night">晚</div>
              <div className="mapply-card-body">
                <div className="mapply-card-title">申报晚自习</div>
                <div className="mapply-card-desc">针对班级 · 临时某天某次</div>
              </div>
              <div className="mapply-card-arrow">›</div>
            </button>
            <button className="mapply-card" disabled={notBound} onClick={() => openMode('早自习')}>
              <div className="mapply-card-icon early">早</div>
              <div className="mapply-card-body">
                <div className="mapply-card-title">申报早自习</div>
                <div className="mapply-card-desc">针对年级 · 按课时数折算</div>
              </div>
              <div className="mapply-card-arrow">›</div>
            </button>
            {canBatch && (
              <button className="mapply-card" onClick={() => openMode('批量')}>
                <div className="mapply-card-icon batch">批</div>
                <div className="mapply-card-body">
                  <div className="mapply-card-title">批量申报</div>
                  <div className="mapply-card-desc">多教师 · 一次提交</div>
                </div>
                <div className="mapply-card-arrow">›</div>
              </button>
            )}
          </div>

          <div className="mapply-records">
            <div className="mapply-records-head">
              <h3>我的申报</h3>
              <span className="mapply-count">{self?.my_records?.length || 0} 条</span>
            </div>
            {self?.my_records?.length === 0 && <p className="mapply-empty">还没有申报记录</p>}
            {self?.my_records?.map((q) => (
              <div key={q.id} className={`mapply-record st-${q.status}`}>
                <div className="mapply-record-icon">{TYPE_ICON[q.period_type] || '课'}</div>
                <div className="mapply-record-body">
                  <div className="mapply-record-line1">
                    <span className={`period-tag period-${q.period_type}`}>{q.period_type}</span>
                    <span className="mapply-record-title">{q.grade} · {q.subject}</span>
                  </div>
                  <div className="mapply-record-line2">
                    {q.date} · {q.period_count}节{q.class_name ? ` · ${q.class_name}` : ''}
                  </div>
                </div>
                <div className="mapply-record-side">
                  <span className={`badge ${STATUS_CLS[q.status]}`}>{STATUS[q.status]}</span>
                  {q.status === 'pending' && (
                    <button className="mapply-del" onClick={() => del(q.id)}>删除</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* 答疑申报表单 */}
      {mode === '答疑' && (
        <div className="mapply-form">
          <button className="mapply-back" onClick={() => setMode(null)}>‹ 返回</button>
          <h2>申报答疑</h2>
          <p className="mapply-form-hint">答疑针对年级，不针对班级。选择年级与日期节数即可。</p>

          <div className="mapply-field">
            <label>年级</label>
            <div className="mapply-chips">
              {self?.qna_grades?.map((g) => (
                <button key={g.grade} type="button" className={`mapply-chip ${grade === g.grade ? 'on' : ''}`} onClick={() => setGrade(g.grade)}>{g.grade}</button>
              ))}
            </div>
            {self?.qna_grades?.length === 0 && <p className="mapply-empty">暂无可申报的年级</p>}
          </div>

          <div className="mapply-field">
            <label>日期</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div className="mapply-field">
            <label>节数</label>
            <div className="mapply-stepper">
              <button type="button" onClick={() => setPeriodCount((n) => Math.max(1, n - 1))}>−</button>
              <span>{periodCount}</span>
              <button type="button" onClick={() => setPeriodCount((n) => Math.min(12, n + 1))}>+</button>
            </div>
          </div>

          <div className="mapply-field">
            <label>内容说明（选填）</label>
            <textarea rows={3} value={content} onChange={(e) => setContent(e.target.value)} placeholder="如 函数专题答疑" />
          </div>

          <button className="mapply-submit" onClick={submit}>提交答疑申报</button>
        </div>
      )}

      {/* 晚自习申报表单 */}
      {mode === '晚自习' && (
        <div className="mapply-form">
          <button className="mapply-back" onClick={() => setMode(null)}>‹ 返回</button>
          <h2>申报晚自习</h2>
          <p className="mapply-form-hint">晚自习针对你代课年级的具体班级。</p>

          <div className="mapply-field">
            <label>班级</label>
            <div className="mapply-chips">
              {self?.evening_classes?.map((c) => (
                <button key={c.id} type="button" className={`mapply-chip ${classId === String(c.id) ? 'on' : ''}`} onClick={() => setClassId(String(c.id))}>{c.name}</button>
              ))}
            </div>
            {self?.evening_classes?.length === 0 && <p className="mapply-empty">暂无可申报的班级</p>}
          </div>

          <div className="mapply-field">
            <label>日期</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div className="mapply-field">
            <label>节数</label>
            <div className="mapply-stepper">
              <button type="button" onClick={() => setPeriodCount((n) => Math.max(1, n - 1))}>−</button>
              <span>{periodCount}</span>
              <button type="button" onClick={() => setPeriodCount((n) => Math.min(12, n + 1))}>+</button>
            </div>
          </div>

          <div className="mapply-field">
            <label>内容说明（选填）</label>
            <textarea rows={3} value={content} onChange={(e) => setContent(e.target.value)} placeholder="如 晚自习看班" />
          </div>

          <button className="mapply-submit" onClick={submit}>提交晚自习申报</button>
        </div>
      )}

      {/* 早自习申报表单（年级级，挂年级虚班） */}
      {mode === '早自习' && (
        <div className="mapply-form">
          <button className="mapply-back" onClick={() => setMode(null)}>‹ 返回</button>
          <h2>申报早自习</h2>
          <p className="mapply-form-hint">早自习针对年级，不针对具体班级。选择年级、日期与课时数即可。</p>

          <div className="mapply-field">
            <label>年级</label>
            <div className="mapply-chips">
              {self?.qna_grades?.map((g) => (
                <button key={g.grade} type="button" className={`mapply-chip ${grade === g.grade ? 'on' : ''}`} onClick={() => setGrade(g.grade)}>{g.grade}</button>
              ))}
            </div>
            {self?.qna_grades?.length === 0 && <p className="mapply-empty">暂无可申报的年级</p>}
          </div>

          <div className="mapply-field">
            <label>日期</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div className="mapply-field">
            <label>课时数</label>
            <div className="mapply-stepper">
              <button type="button" onClick={() => setPeriodCount((n) => Math.max(1, n - 1))}>−</button>
              <span>{periodCount}</span>
              <button type="button" onClick={() => setPeriodCount((n) => Math.min(12, n + 1))}>+</button>
            </div>
          </div>

          <div className="mapply-field">
            <label>内容说明（选填）</label>
            <textarea rows={3} value={content} onChange={(e) => setContent(e.target.value)} placeholder="如 早自习看班" />
          </div>

          <button className="mapply-submit" onClick={submit}>提交早自习申报</button>
        </div>
      )}

      {/* 批量申报表单（教务员/年级组长） */}
      {mode === '批量' && (
        <div className="mapply-form">
          <button className="mapply-back" onClick={() => { setMode(null); setSelectedTeachers([]); }}>‹ 返回</button>
          <h2>批量申报</h2>
          <p className="mapply-form-hint">
            同一类型、同一天，一次勾选多位教师提交。
            {batchCtx?.managed_grade ? ` 年级已锁定为「${batchCtx.managed_grade}」。` : ''}
          </p>

          <div className="mapply-field">
            <label>年级</label>
            {batchCtx?.managed_grade ? (
              <input value={batchGrade} readOnly />
            ) : (
              <select className="mapply-select" value={batchGrade} onChange={(e) => { setBatchGrade(e.target.value); setBatchClassId(''); setSelectedTeachers([]); }}>
                <option value="">请选择年级</option>
                {(batchCtx?.grades || []).map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            )}
          </div>

          <div className="mapply-field">
            <label>类型</label>
            <div className="mapply-chips">
              {(batchCtx?.typePays || []).map((t) => (
                <button key={t.id} type="button" className={`mapply-chip ${batchType === t.name ? 'on' : ''}`} onClick={() => setBatchType(t.name)}>{t.name}（{t.pay}元/节）</button>
              ))}
            </div>
          </div>

          <div className="mapply-field">
            <label>日期</label>
            <input type="date" value={batchDate} onChange={(e) => setBatchDate(e.target.value)} />
          </div>

          <div className="mapply-field">
            <label>节数</label>
            <div className="mapply-stepper">
              <button type="button" onClick={() => setBatchPeriodCount((n) => Math.max(1, n - 1))}>−</button>
              <span>{batchPeriodCount}</span>
              <button type="button" onClick={() => setBatchPeriodCount((n) => Math.min(12, n + 1))}>+</button>
            </div>
          </div>

          <div className="mapply-field">
            <label>班级（选填，晚自习等班级级类型填）</label>
            <select className="mapply-select" value={batchClassId} onChange={(e) => setBatchClassId(e.target.value)}>
              <option value="">不选（针对年级）</option>
              {(batchCtx?.classes || []).filter((c) => !batchGrade || c.grade === batchGrade).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          <div className="mapply-field">
            <label>选择教师（可多选）</label>
            <input
              className="mapply-teacher-search"
              value={teacherQuery}
              onChange={(e) => setTeacherQuery(e.target.value)}
              placeholder="搜索教师姓名，点下面勾选"
            />
            <div className="mapply-teacher-bar">
              <button type="button" className="mapply-chip" onClick={() => toggleAllTeachers(visibleBatchTeachers)}>
                {(() => {
                  const visibleIds = visibleBatchTeachers.map((t) => String(t.id));
                  const all = visibleIds.length > 0 && visibleIds.every((id) => selectedTeachers.includes(id));
                  return all ? '取消全选' : '全选';
                })()}
              </button>
              <span className="mapply-selected-count">已选 {selectedTeachers.length} 人</span>
            </div>
            <div className="mapply-teacher-list">
              {visibleBatchTeachers.map((t) => {
                const on = selectedTeachers.includes(String(t.id));
                return (
                  <button key={t.id} type="button" className={`mapply-teacher-item ${on ? 'on' : ''}`} onClick={() => toggleTeacher(String(t.id))}>
                    <span className="mapply-teacher-name">{t.name}</span>
                    <span className="mapply-teacher-subj">{t.subject || '未设学科'}</span>
                    <span className="mapply-teacher-check">{on ? '✓' : ''}</span>
                  </button>
                );
              })}
              {visibleBatchTeachers.length === 0 && (
                <p className="mapply-empty">没有匹配的教师</p>
              )}
            </div>
          </div>

          <div className="mapply-field">
            <label>内容说明（选填）</label>
            <input value={batchContent} onChange={(e) => setBatchContent(e.target.value)} placeholder="如 函数专题答疑" />
          </div>

          <button className="mapply-submit" onClick={submitBatch} disabled={!selectedTeachers.length}>批量提交（{selectedTeachers.length} 人）</button>
        </div>
      )}
    </div>
  );
}
