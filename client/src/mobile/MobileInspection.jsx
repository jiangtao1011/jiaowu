import React, { useEffect, useMemo, useState } from 'react';
import api, { errMsg } from '../api.js';

const DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const GRADE_ORDER = ['高一', '高二', '高三', '初一', '初二', '初三'];
const SUBJECT_ORDER = ['语文', '数学', '英语', '物理', '化学', '生物', '政治', '历史', '地理', '体育', '音乐', '美术', '信息技术', '信息', '通用技术', '通用', '技术'];
const CLASS_TYPE_LABEL = { 行政班: '行政班', 走班: '走班', 分层: '分层' };

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function dowOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.getDay() === 0 ? 7 : d.getDay();
}

export default function MobileInspection() {
  const user = JSON.parse(localStorage.getItem('edu_user') || '{}');
  const isAdmin = ['admin', '教务员', '教务处'].includes(user.role);
  const canSubmit = ['admin', '教务员', '教务处', '教研组长', '备课组长'].includes(user.role);

  const [types, setTypes] = useState([]);
  const [classes, setClasses] = useState([]);
  const [teachers, setTeachers] = useState([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 表单
  const [typeId, setTypeId] = useState('');
  const [classId, setClassId] = useState('');
  const [date, setDate] = useState(today());
  const [periodNo, setPeriodNo] = useState('');
  const [teacherId, setTeacherId] = useState('');
  const [subject, setSubject] = useState('');
  const [lesson, setLesson] = useState(null); // 课表联动结果
  const [dayLessons, setDayLessons] = useState([]);
  const [teacherQuery, setTeacherQuery] = useState('');
  const [values, setValues] = useState({}); // 检查项 key -> value
  const [scores, setScores] = useState({}); // name -> score
  const [cycleLabel, setCycleLabel] = useState('');
  const [photos, setPhotos] = useState([]); // 待上传文件
  const [openGrade, setOpenGrade] = useState(null); // 班级分组：当前展开的年级（默认展开含选中班级的年级）
  const [openSubject, setOpenSubject] = useState(null); // 教师分组：当前展开的学科（默认展开含选中教师的学科）

  const load = async () => {
    setError('');
    try {
      const [t, c, tc] = await Promise.all([
        api.get('/inspections/types'),
        api.get('/classes'),
        api.get('/teachers'),
      ]);
      setTypes(t.data.data.filter((x) => x.active !== 0));
      setClasses(c.data.data);
      setTeachers(tc.data.data);
      setTypeId(t.data.data.find((x) => x.active !== 0)?.id || '');
    } catch (e) { setError(errMsg(e)); }
  };
  useEffect(() => { load(); }, []);

  const currentType = types.find((t) => t.id === Number(typeId));
  const typeDims = currentType?.dimensions || [];
  const linkType = currentType && currentType.schedule_link !== 0; // 该类型是否需要课表联动

  // 周期标记：周期类 + 有日期时，向后端取自动周次
  useEffect(() => {
    if (currentType?.cycle !== 'periodic' || !date) { setCycleLabel(''); return; }
    api.get('/inspections/week-label', { params: { date } })
      .then((r) => setCycleLabel(r.data.data.label || ''))
      .catch(() => setCycleLabel(''));
  }, [currentType?.id, currentType?.cycle, date]);

  // 课表联动：选日期 + 班级后拉取当天该班课程，并按节次带出教师/科目
  const loadDayLessons = async (d, cid) => {
    if (!d || !cid) { setDayLessons([]); setPeriodNo(''); setLesson(null); return; }
    try {
      const res = await api.get('/inspections/lessons', { params: { date: d, class_id: cid } });
      setDayLessons(res.data.data);
    } catch (e) { setDayLessons([]); }
  };
  useEffect(() => {
    if (!linkType) { setDayLessons([]); setPeriodNo(''); setLesson(null); return; }
    setPeriodNo(''); setLesson(null);
    loadDayLessons(date, classId);
  }, [linkType, date, classId]);

  const periods = useMemo(() => [...new Set(dayLessons.map((l) => l.period_no))].filter((p) => p > 0).sort((a, b) => a - b), [dayLessons]);

  // 可选班级：排除年级虚拟班（答疑用，检查不应选）
  const selectableClasses = useMemo(() => classes.filter((c) => c.is_virtual !== 1), [classes]);
  // 班级按年级分组，年级内再按「行政班 → 走班 → 分层」归类
  const classesByGrade = useMemo(() => {
    const groups = [];
    const byGrade = new Map();
    for (const c of selectableClasses) {
      const g = c.grade || '未分年级';
      if (!byGrade.has(g)) { byGrade.set(g, []); groups.push({ grade: g, list: byGrade.get(g) }); }
      byGrade.get(g).push(c);
    }
    groups.sort((a, b) => {
      const ia = GRADE_ORDER.indexOf(a.grade), ib = GRADE_ORDER.indexOf(b.grade);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1; if (ib !== -1) return 1;
      return a.grade.localeCompare(b.grade, 'zh');
    });
    const typeRank = (t) => (t === '行政班' ? 0 : t === '走班' ? 1 : 2);
    return groups.map((g) => ({
      ...g,
      list: [...g.list].sort((a, b) => typeRank(a.type) - typeRank(b.type) || a.name.localeCompare(b.name, 'zh')),
    }));
  }, [selectableClasses]);

  // 教师按学科分组
  const teachersBySubject = useMemo(() => {
    const groups = [];
    const bySubj = new Map();
    for (const t of teachers) {
      const s = t.subject || '未设学科';
      if (!bySubj.has(s)) { bySubj.set(s, []); groups.push({ subject: s, list: bySubj.get(s) }); }
      bySubj.get(s).push(t);
    }
    groups.sort((a, b) => {
      const ia = SUBJECT_ORDER.indexOf(a.subject), ib = SUBJECT_ORDER.indexOf(b.subject);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1; if (ib !== -1) return 1;
      return a.subject.localeCompare(b.subject, 'zh');
    });
    return groups.map((g) => ({ ...g, list: g.list.sort((a, b) => a.name.localeCompare(b.name, 'zh')) }));
  }, [teachers]);

  // 已选班级所属年级 / 已选教师所属学科
  const selectedGrade = useMemo(() => selectableClasses.find((c) => String(c.id) === classId)?.grade, [selectableClasses, classId]);
  const selectedSubject = useMemo(() => teachers.find((t) => String(t.id) === teacherId)?.subject, [teachers, teacherId]);
  // 当前展开的组：显式指定优先，否则跟随已选（便于定位），否则默认第一个
  const activeGrade = openGrade || selectedGrade || classesByGrade[0]?.grade || null;
  const activeSubject = openSubject || selectedSubject || teachersBySubject[0]?.subject || null;

  const pickPeriod = (p) => {
    setPeriodNo(String(p));
    const matches = dayLessons.filter((l) => l.period_no === p);
    if (matches.length) {
      const first = matches[0];
      setLesson({ subject: first.subject, teacher_name: first.teacher_name, teacher_id: first.teacher_id, class_name: first.class_name, period_no: first.period_no });
      setTeacherId(String(first.teacher_id));
      setSubject(first.subject || '');
    } else {
      setLesson(null);
    }
  };

  const setScore = (name, v) => setScores((s) => ({ ...s, [name]: v }));
  const setAllScores = (v) => {
    const next = {};
    typeDims.forEach((d) => { next[d.name] = v; });
    setScores(next);
  };
  const setValue = (key, v) => setValues((prev) => ({ ...prev, [key]: v }));

  const scoreTotal = typeDims.reduce((s, d) => s + (Number(scores[d.name]) || 0) * (Number(d.weight) || 1), 0);
  const scoreMax = typeDims.reduce((s, d) => s + (Number(d.weight) || 1) * 100, 0);

  const onFiles = (e) => setPhotos((prev) => [...prev, ...Array.from(e.target.files || [])]);
  const removePhoto = (i) => setPhotos((prev) => prev.filter((_, idx) => idx !== i));

  if (!canSubmit) {
    return (
      <div>
        <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
          <div className="mt-title">常规检查</div>
        </div>
        <div className="alert error">无权限：常规检查仅教务员、教务处、教研组长、备课组长可用。</div>
      </div>
    );
  }

  const switchType = (id) => {
    setTypeId(String(id));
    setValues({}); setScores({});
    setClassId(''); setPeriodNo(''); setTeacherId(''); setSubject(''); setLesson(null); setPhotos([]); setCycleLabel('');
    setOpenGrade(null); setOpenSubject(null);
  };

  const submit = async () => {
    setError(''); setMsg('');
    if (!typeId) return setError('请选择检查类型');
    if (!date) return setError('请选择日期');
    if (linkType && !classId) return setError('请选择班级');
    if (linkType && !periodNo) return setError('请选择节次');
    if (!linkType && !teacherId) return setError('请选择被检查教师');
    setSubmitting(true);

    const scoreArr = typeDims.map((d) => ({ name: d.name, score: scores[d.name] ?? 0 }));

    try {
      const res = await api.post('/inspections', {
        type_id: Number(typeId),
        class_id: classId ? Number(classId) : null,
        teacher_id: teacherId ? Number(teacherId) : null,
        subject: subject || null,
        period_no: linkType && periodNo ? Number(periodNo) : null,
        lesson_date: date,
        cycle_label: currentType?.cycle === 'periodic' ? cycleLabel : null,
        data: { ...values },
        scores: scoreArr,
      });
      const id = res.data.data.id;

      if (photos.length) {
        const fd = new FormData();
        for (const f of photos) fd.append('photos', f);
        await api.post(`/inspections/${id}/photos`, fd);
      }

      setMsg('检查已提交');
      setClassId(''); setPeriodNo(''); setTeacherId(''); setSubject(''); setLesson(null);
      setValues({}); setScores({}); setPhotos([]); setCycleLabel(''); setTeacherQuery('');
    } catch (e) { setError(errMsg(e)); }
    setSubmitting(false);
  };

  const filteredTeachers = teachers.filter((t) => !teacherQuery || t.name.includes(teacherQuery));

  return (
    <div className="minsp">
      <div className="mobile-topbar" style={{ position: 'static', margin: '-14px -14px 12px' }}>
        <div>
          <div className="mt-title">常规检查</div>
          <div className="mt-sub">选类型 · 定对象 · 打分拍照</div>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {msg && <div className="alert success">{msg}</div>}

      {/* 检查类型 */}
      <div className="mcard">
        <div className="mcard-title">检查类型</div>
        <div className="mapply-chips">
          {types.map((t) => (
            <button key={t.id} type="button" className={`mapply-chip ${String(t.id) === String(typeId) ? 'on' : ''}`} onClick={() => switchType(t.id)}>
              {t.name}{t.cycle === 'periodic' ? '·周期' : ''}
            </button>
          ))}
        </div>
        {currentType?.category_name && <div className="mitem-sub" style={{ marginTop: 8 }}>{currentType.category_name}{linkType ? '' : ' · 无需课表联动'}</div>}
      </div>

      {/* 日期 */}
      <div className="mcard">
        <div className="mcard-title">日期{date ? <span className="mitem-sub">{DAYS[dowOf(date) - 1]}</span> : ''}</div>
        <input type="date" className="minput" value={date} onChange={(e) => setDate(e.target.value)} />
        {currentType?.cycle === 'periodic' && (
          <div className="mfield" style={{ marginTop: 12, marginBottom: 0 }}>
            <label>周期标记</label>
            <input className="minput" value={cycleLabel} onChange={(e) => setCycleLabel(e.target.value)} placeholder="如 第6周" />
          </div>
        )}
      </div>

      {/* 检查对象：联动 vs 直接选教师 */}
      {linkType ? (
        <div className="mcard">
          <div className="mcard-title">选择班级与节次<span className="mitem-sub">课表联动</span></div>
          <div className="mfield">
            <label>班级</label>
            <div className="minsp-groups">
              {classesByGrade.map((g) => {
                const open = activeGrade === g.grade;
                const hasSel = selectedGrade === g.grade;
                return (
                  <div key={g.grade} className="minsp-group">
                    <button type="button" className="minsp-group-head" onClick={() => setOpenGrade(open ? null : g.grade)}>
                      <span className={`minsp-group-title${hasSel ? ' has-sel' : ''}`}>{g.grade}</span>
                      <span className="minsp-group-meta">{g.list.length} 个班级</span>
                      <span className="minsp-group-arrow">{open ? '▾' : '▸'}</span>
                    </button>
                    {open && (
                      <div className="minsp-group-body">
                        <div className="minsp-type-tabs">
                          {['行政班', '走班', '分层'].map((ty) => {
                            const list = g.list.filter((c) => c.type === ty);
                            if (!list.length) return null;
                            return (
                              <div key={ty} className="minsp-type-block">
                                <div className="minsp-type-label">{ty}</div>
                                <div className="mapply-chips">
                                  {list.map((c) => (
                                    <button key={c.id} type="button" className={`mapply-chip ${String(c.id) === classId ? 'on' : ''}`} onClick={() => setClassId(String(c.id))}>{c.name}</button>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {classId && periods.length > 0 && (
            <div className="mfield">
              <label>节次</label>
              <div className="mapply-chips">
                {periods.map((p) => {
                  const lessons = dayLessons.filter((l) => l.period_no === p);
                  const subj = [...new Set(lessons.map((l) => l.subject).filter(Boolean))].join('/');
                  return (
                    <button key={p} type="button" className={`mapply-chip ${String(p) === String(periodNo) ? 'on' : ''}`} onClick={() => pickPeriod(p)}>
                      第{p}节{subj ? `·${subj}` : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {classId && lesson ? (
            <div className="minsp-course">
              <div className="minsp-course-subj">{lesson.subject || '未设科目'}</div>
              <div className="minsp-course-line">{lesson.teacher_name} · {lesson.class_name} · 第{lesson.period_no}节</div>
            </div>
          ) : (
            classId && date && periods.length === 0 && <div className="mitem-sub">该班当天暂无课程记录，请改选班级或日期。</div>
          )}
        </div>
      ) : (
        <div className="mcard">
          <div className="mcard-title">检查对象</div>
          <div className="mfield">
            <label>被检查教师</label>
            <input className="minput" value={teacherQuery} onChange={(e) => setTeacherQuery(e.target.value)} placeholder="搜索教师姓名" />
            {teacherQuery ? (
              <div className="mapply-teacher-list" style={{ marginTop: 8 }}>
                {filteredTeachers.map((t) => (
                  <button key={t.id} type="button" className={`mapply-teacher-item ${String(t.id) === teacherId ? 'on' : ''}`} onClick={() => { setTeacherId(String(t.id)); if (t.subject && !subject) setSubject(t.subject); }}>
                    <span className="mapply-teacher-name">{t.name}</span>
                    <span className="mapply-teacher-subj">{t.subject || '未设学科'}</span>
                    <span className="mapply-teacher-check">{String(t.id) === teacherId ? '✓' : ''}</span>
                  </button>
                ))}
                {filteredTeachers.length === 0 && <p className="mapply-empty">没有匹配的教师</p>}
              </div>
            ) : (
              <div className="minsp-groups">
                {teachersBySubject.map((g) => {
                  const open = activeSubject === g.subject;
                  const hasSel = selectedSubject === g.subject;
                  return (
                    <div key={g.subject} className="minsp-group">
                      <button type="button" className="minsp-group-head" onClick={() => setOpenSubject(open ? null : g.subject)}>
                        <span className={`minsp-group-title${hasSel ? ' has-sel' : ''}`}>{g.subject}</span>
                        <span className="minsp-group-meta">{g.list.length} 人</span>
                        <span className="minsp-group-arrow">{open ? '▾' : '▸'}</span>
                      </button>
                      {open && (
                        <div className="minsp-group-body">
                          <div className="mapply-chips">
                            {g.list.map((t) => (
                              <button key={t.id} type="button" className={`mapply-chip ${String(t.id) === teacherId ? 'on' : ''}`} onClick={() => { setTeacherId(String(t.id)); if (t.subject && !subject) setSubject(t.subject); }}>{t.name}</button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {teacherId && (
            <div className="minsp-course" style={{ marginBottom: 12 }}>
              <div className="minsp-course-subj">{teachers.find((t) => String(t.id) === teacherId)?.name || ''}</div>
              <div className="minsp-course-line">{subject || '未设科目'} · {selectableClasses.find((c) => String(c.id) === classId)?.name || '未选班级'}</div>
            </div>
          )}
          <div className="mfield" style={{ marginBottom: 0 }}>
            <label>班级（选填）</label>
            <div className="minsp-groups">
              {classesByGrade.map((g) => {
                const open = activeGrade === g.grade;
                return (
                  <div key={g.grade} className="minsp-group">
                    <button type="button" className="minsp-group-head" onClick={() => setOpenGrade(open ? null : g.grade)}>
                      <span className={`minsp-group-title${selectedGrade === g.grade ? ' has-sel' : ''}`}>{g.grade}</span>
                      <span className="minsp-group-meta">{g.list.length} 个班级</span>
                      <span className="minsp-group-arrow">{open ? '▾' : '▸'}</span>
                    </button>
                    {open && (
                      <div className="minsp-group-body">
                        <div className="mapply-chips">
                          {g.list.map((c) => (
                            <button key={c.id} type="button" className={`mapply-chip ${String(c.id) === classId ? 'on' : ''}`} onClick={() => setClassId(String(c.id))}>{c.name}</button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 检查项 */}
      {currentType && (currentType.items || []).length > 0 && (
        <div className="mcard">
          <div className="mcard-title">检查项</div>
          {(currentType.items || []).map((item) => (
            <div key={item.key} className="mfield" style={{ marginBottom: item.type === 'select' ? 16 : 12 }}>
              <label>{item.label}</label>
              {item.type === 'select' ? (
                <div className="mapply-chips">
                  {(item.options || []).map((o) => (
                    <button key={o} type="button" className={`mapply-chip ${values[item.key] === o ? 'on' : ''}`} onClick={() => setValue(item.key, o)}>{o}</button>
                  ))}
                </div>
              ) : item.type === 'photo' ? (
                <>
                  <input type="file" accept="image/*" capture="environment" multiple onChange={onFiles} />
                  {photos.length > 0 && <div className="minsp-thumbs">{photos.map((f, i) => (
                    <div key={i} className="minsp-thumb" onClick={() => removePhoto(i)}>
                      <img src={URL.createObjectURL(f)} alt={f.name} />
                      <span className="minsp-thumb-x">×</span>
                    </div>
                  ))}</div>}
                </>
              ) : (
                <textarea className="minput" rows={item.type === 'textarea' ? 3 : 2} value={values[item.key] || ''} onChange={(e) => setValue(item.key, e.target.value)} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* 打分 */}
      {typeDims.length > 0 && (
        <div className="mcard">
          <div className="mcard-title">打分</div>
          <div className="score-quick-all">
            <button type="button" className={`score-q-btn ${typeDims.every((d) => (Number(scores[d.name]) || 0) === 100) ? 'on' : ''}`} onClick={() => setAllScores(100)}>满分</button>
            <button type="button" className={`score-q-btn ${typeDims.every((d) => (Number(scores[d.name]) || 0) === 90) ? 'on' : ''}`} onClick={() => setAllScores(90)}>优秀</button>
            <button type="button" className={`score-q-btn ${typeDims.every((d) => (Number(scores[d.name]) || 0) === 80) ? 'on' : ''}`} onClick={() => setAllScores(80)}>良好</button>
            <button type="button" className={`score-q-btn ${typeDims.every((d) => (Number(scores[d.name]) || 0) === 60) ? 'on' : ''}`} onClick={() => setAllScores(60)}>及格</button>
          </div>
          {typeDims.map((d) => (
            <div key={d.id ?? d.name} className="score-row">
              <div className="score-row-head">
                <span className="score-label">{d.label}{Number(d.weight) !== 1 ? <span className="score-weight"> ×{d.weight}</span> : ''}</span>
                <span className="score-val">{Number(scores[d.name]) || 0}</span>
              </div>
              <input type="range" min="0" max="100" step="5" value={Number(scores[d.name]) || 0} onChange={(e) => setScore(d.name, Number(e.target.value))} className="score-range" />
              <div className="score-quick">
                {[100, 90, 80, 70, 60].map((v) => (
                  <button key={v} type="button" className={`score-q-btn ${Number(scores[d.name]) === v ? 'on' : ''}`} onClick={() => setScore(d.name, v)}>{v}</button>
                ))}
              </div>
            </div>
          ))}
          <div className="score-total">
            得分 <strong>{Math.round(scoreTotal * 10) / 10}</strong>
            <em> / {Math.round(scoreMax * 10) / 10}</em>
          </div>
        </div>
      )}

      {/* 补充照片（无 photo 检查项时也保留） */}
      {!(currentType && (currentType.items || []).some((it) => it.type === 'photo')) && (
        <div className="mcard">
          <div className="mcard-title">拍照上传<span className="mitem-sub">选填</span></div>
          <input type="file" accept="image/*" capture="environment" multiple onChange={onFiles} />
          {photos.length > 0 && <div className="minsp-thumbs">{photos.map((f, i) => (
            <div key={i} className="minsp-thumb" onClick={() => removePhoto(i)}>
              <img src={URL.createObjectURL(f)} alt={f.name} />
              <span className="minsp-thumb-x">×</span>
            </div>
          ))}</div>}
        </div>
      )}

      <button className="mbtn" style={{ marginTop: 4 }} disabled={submitting} onClick={submit}>{submitting ? '提交中…' : '提交检查'}</button>
      <div style={{ height: 16 }} />
    </div>
  );
}
