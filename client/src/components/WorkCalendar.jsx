import React, { useEffect, useMemo, useState } from 'react';
import api, { errMsg } from '../api.js';
import { useToast } from './feedback.jsx';

const CATEGORIES = ['工作', '会议', '考试', '检查', '活动', '其它'];
const CAT_COLORS = {
  工作: '#167d6f', 会议: '#3b5bdb', 考试: '#c0392b', 检查: '#b0731f', 活动: '#7a4fb0', 其它: '#6b7280',
};
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const CAL_TYPE_LABEL = { 放假: '放假', 停课: '停课', 补课: '补课', 调课: '调课' };

function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayStr() { return fmt(new Date()); }

// 月初（周一为起始）偏移：0=周一 … 6=周日
function mondayStart(d) {
  const w = d.getDay(); // 0=周日
  return (w + 6) % 7;
}

export default function WorkCalendar() {
  const toast = useToast();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState(() => new Date().getMonth()); // 0-11
  const [items, setItems] = useState([]);
  const [calendar, setCalendar] = useState([]);
  const [categories] = useState(CATEGORIES);
  const [selected, setSelected] = useState(null); // 选中的日期 YYYY-MM-DD 或 null
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 当月范围（含月历上显示的相邻月日期），用于拉取数据
  const [from, to] = useMemo(() => {
    const first = new Date(year, month, 1);
    const start = new Date(first);
    start.setDate(1 - mondayStart(first));
    const end = new Date(year, month + 1, 0);
    end.setDate(end.getDate() + (6 - mondayStart(end)));
    return [fmt(start), fmt(end)];
  }, [year, month]);

  const load = async () => {
    try {
      const res = await api.get('/workplan', { params: { from, to } });
      setItems(res.data.data.items || []);
      setCalendar(res.data.data.calendar || []);
      if (res.data.data.categories) { /* 固定类别 */ }
    } catch (e) {
      setError(errMsg(e));
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [from, to]);

  const byDate = useMemo(() => {
    const m = new Map();
    for (const it of items) {
      if (!m.has(it.date)) m.set(it.date, []);
      m.get(it.date).push(it);
    }
    return m;
  }, [items]);

  const calByDate = useMemo(() => {
    const m = new Map();
    for (const c of calendar) {
      if (!m.has(c.date)) m.set(c.date, []);
      m.get(c.date).push(c);
    }
    return m;
  }, [calendar]);

  const cells = useMemo(() => {
    const out = [];
    const first = new Date(year, month, 1);
    const start = new Date(first);
    start.setDate(1 - mondayStart(first));
    const daysInGrid = 42; // 6 行
    for (let i = 0; i < daysInGrid; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      out.push(d);
    }
    return out;
  }, [year, month]);

  const prevMonth = () => { if (month === 0) { setYear(year - 1); setMonth(11); } else setMonth(month - 1); };
  const nextMonth = () => { if (month === 11) { setYear(year + 1); setMonth(0); } else setMonth(month + 1); };
  const goToday = () => { const t = new Date(); setYear(t.getFullYear()); setMonth(t.getMonth()); };

  return (
    <div className="cal">
      <div className="cal-head">
        <div className="cal-title">
          {year}年{month + 1}月
          <span className="cal-count">{items.length} 项工作</span>
        </div>
        <div className="cal-nav">
          <button className="btn sm" onClick={prevMonth}>‹ 上月</button>
          <button className="btn sm" onClick={goToday}>今天</button>
          <button className="btn sm" onClick={nextMonth}>下月 ›</button>
        </div>
      </div>

      <div className="cal-week">
        {WEEKDAYS.map((w) => <div key={w} className="cal-week-cell">{w}</div>)}
      </div>

      <div className="cal-grid">
        {cells.map((d) => {
          const ds = fmt(d);
          const inMonth = d.getMonth() === month;
          const isToday = ds === todayStr();
          const dayItems = byDate.get(ds) || [];
          const cals = calByDate.get(ds) || [];
          const undone = dayItems.filter((x) => !x.done).length;
          const calFlags = cals.filter((c) => CAL_TYPE_LABEL[c.type]);
          return (
            <button
              key={ds}
              type="button"
              className={`cal-cell${inMonth ? '' : ' out'}${isToday ? ' today' : ''}${selected === ds ? ' sel' : ''}`}
              onClick={() => setSelected(ds)}
            >
              <div className="cal-cell-top">
                <span className="cal-day">{d.getDate()}</span>
                {calFlags.length > 0 && (
                  <span className="cal-flags">
                    {calFlags.map((c, i) => (
                      <span key={i} className={`cal-flag flag-${c.type}`} title={c.note || CAL_TYPE_LABEL[c.type]}>{c.note || CAL_TYPE_LABEL[c.type]}</span>
                    ))}
                  </span>
                )}
                {undone > 0 ? <span className="cal-undone">{undone}</span> : null}
              </div>
              <div className="cal-cell-body">
                {dayItems.slice(0, 4).map((it) => (
                  <span
                    key={it.id}
                    className={`cal-chip${it.done ? ' done' : ''}`}
                    style={{ background: it.done ? '#e9edf2' : CAT_COLORS[it.category] || CAT_COLORS.其它 }}
                  >
                    {it.remind ? '🔔' : ''}{it.title}
                  </span>
                ))}
                {dayItems.length > 4 ? <span className="cal-more">+{dayItems.length - 4}</span> : null}
              </div>
            </button>
          );
        })}
      </div>

      {error ? <p className="muted mt-xs">{error}</p> : null}

      {selected ? (
        <DayPanel
          date={selected}
          items={byDate.get(selected) || []}
          cals={calByDate.get(selected) || []}
          categories={categories}
          onClose={() => setSelected(null)}
          onChanged={load}
        />
      ) : null}
    </div>
  );
}

function DayPanel({ date, items, cals, categories, onClose, onChanged }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('工作');
  const [note, setNote] = useState('');
  const [remind, setRemind] = useState(true);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reset = () => { setTitle(''); setCategory('工作'); setNote(''); setRemind(true); setEditing(null); };

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true); setError('');
    try {
      if (editing) {
        await api.patch(`/workplan/${editing.id}`, { title, category, note, remind });
        toast.success('已更新');
      } else {
        await api.post('/workplan', { date, title, category, note, remind });
        toast.success('已添加');
      }
      reset();
      onChanged();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id) => {
    try { await api.patch(`/workplan/${id}/toggle`); onChanged(); } catch (err) { toast.error(errMsg(err)); }
  };
  const edit = (it) => { setEditing(it); setTitle(it.title); setCategory(it.category); setNote(it.note || ''); setRemind(!!it.remind); };
  const del = async (id) => {
    if (!(await toast.confirm('删除该事项？', { danger: true }))) return;
    try { await api.delete(`/workplan/${id}`); if (editing?.id === id) reset(); toast.success('已删除'); onChanged(); } catch (err) { toast.error(errMsg(err)); }
  };

  const [y, m, d] = date.split('-').map(Number);
  const dow = ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()];

  return (
    <div className="cal-panel">
      <div className="cal-panel-head">
        <div>
          <span className="cal-panel-title">{m}月{d}日</span>
          <span className="muted"> 星期{dow}</span>
        </div>
        <button className="btn ghost sm" onClick={onClose}>关闭 ✕</button>
      </div>

      {cals.length > 0 ? (
        <div className="cal-panel-cals">
          {cals.map((c, i) => (
            <span key={i} className={`badge ${c.type === '放假' || c.type === '停课' ? 'danger' : c.type === '调课' ? 'info' : 'warn'}`}>
              {c.grade ? `${c.grade}·` : ''}{c.note || (CAL_TYPE_LABEL[c.type] || c.type)}
            </span>
          ))}
        </div>
      ) : null}

      <div className="cal-panel-list">
        {items.length === 0 ? (
          <p className="muted">当天暂无工作事项。</p>
        ) : (
          items.map((it) => (
            <div key={it.id} className={`cal-item${it.done ? ' done' : ''}`}>
              <label className="cal-item-check">
                <input type="checkbox" checked={!!it.done} onChange={() => toggle(it.id)} />
                <span className="cal-item-dot" style={{ background: CAT_COLORS[it.category] || CAT_COLORS.其它 }} />
                <span className="cal-item-title">{it.title}</span>
                {it.remind ? <span className="cal-item-remind" title="已设提醒">🔔</span> : null}
              </label>
              <span className="cal-item-tag" style={{ color: CAT_COLORS[it.category] || CAT_COLORS.其它 }}>{it.category}</span>
              {it.note ? <div className="cal-item-note">{it.note}</div> : null}
              <div className="cal-item-actions">
                <button className="btn sm" onClick={() => edit(it)}>编辑</button>
                <button className="btn sm danger" onClick={() => del(it.id)}>删除</button>
              </div>
            </div>
          ))
        )}
      </div>

      <form className="cal-form" onSubmit={submit}>
        <div className="cal-form-title">{editing ? '编辑事项' : '新增事项'}</div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={editing ? '事项标题' : '如：提交期中考务方案'}
        />
        <div className="cal-form-row">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <label className="cal-remind-check">
            <input type="checkbox" checked={remind} onChange={(e) => setRemind(e.target.checked)} />
            提醒
          </label>
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="备注（可选）"
          rows={2}
        />
        <div className="cal-form-actions">
          {editing ? (
            <button type="button" className="btn sm" onClick={reset}>取消编辑</button>
          ) : null}
          <button type="submit" className="btn primary" disabled={busy || !title.trim()}>
            {editing ? '保存' : '添加'}
          </button>
        </div>
        {error ? <p className="muted mt-xs">{error}</p> : null}
      </form>
    </div>
  );
}
