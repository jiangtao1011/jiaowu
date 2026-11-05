import React from 'react';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';

// ===== 图表统一色板（与设计令牌主色协调）=====
export const CHART_COLORS = ['#167d6f', '#3b5bdb', '#e8590c', '#7a4fb0', '#2e8b57', '#b0731f', '#c0392b', '#0f5f54'];

// ===== KPI 指标卡：左侧色条 + 大号数字 + 标签 =====
export function KpiCard({ value, label, to, color = 'var(--primary)', icon }) {
  const body = (
    <div className="kpi-card">
      <span className="kpi-bar" style={{ background: color }} />
      {icon && <span className="kpi-icon">{icon}</span>}
      <div className="kpi-body">
        <div className="kpi-v">{value ?? '—'}</div>
        <div className="kpi-l">{label}</div>
      </div>
    </div>
  );
  if (to) return <a href={to} className="kpi-link">{body}</a>;
  return body;
}

// ===== 环形图（≤5 类用）=====
// data: [{ name, value }]
export function DonutChart({ data, colors = CHART_COLORS, height = 220 }) {
  if (!data || data.length === 0) return <ChartEmpty />;
  return (
    <div className="chart-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="80%" paddingAngle={2} strokeWidth={0}>
            {data.map((entry, i) => (
              <Cell key={i} fill={colors[i % colors.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(v, n) => [`${v} 条`, n]} />
          <Legend verticalAlign="bottom" height={28} iconType="circle" />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

// ===== 横向条形（排行，适合达标率/覆盖率高亮异常）=====
// data: [{ name, value, color? }]，value 为 0-100 或任意数值
export function HBarChart({ data, height = 220, color = 'var(--primary)', maxValue }) {
  if (!data || data.length === 0) return <ChartEmpty />;
  return (
    <div className="chart-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 4, right: 24, top: 4, bottom: 4 }}>
          <XAxis type="number" hide={!maxValue} domain={maxValue ? [0, maxValue] : [0, 'auto']} />
          <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 12, fill: 'var(--text-soft)' }} />
          <Tooltip />
          <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={18}>
            {data.map((entry, i) => (
              <Cell key={i} fill={entry.color || color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ===== 横向堆积条（类型构成，多类友好，图例 + 百分比）=====
// data: [{ name, value }]
export function StackedBar({ data, colors = CHART_COLORS, height = 200 }) {
  if (!data || data.length === 0) return <ChartEmpty />;
  const total = data.reduce((s, d) => s + (d.value || 0), 0);
  const pct = (v) => (total ? Math.round((v / total) * 100) : 0);
  return (
    <div className="stacked-bar">
      <div className="sb-track">
        {data.map((d, i) => (
          <div key={i} className="sb-seg" style={{ width: `${pct(d.value)}%`, background: colors[i % colors.length] }} title={`${d.name} ${d.value} 节 (${pct(d.value)}%)`} />
        ))}
      </div>
      <div className="sb-legend">
        {data.map((d, i) => (
          <div key={i} className="sb-legend-item">
            <span className="sb-dot" style={{ background: colors[i % colors.length] }} />
            <span className="sb-name">{d.name}</span>
            <span className="sb-val">{d.value} 节 · {pct(d.value)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ===== 空态 =====
export function ChartEmpty({ text = '暂无数据' }) {
  return <div className="chart-empty">{text}</div>;
}

// ===== 骨架屏 =====
export function ChartSkeleton({ height = 200 }) {
  return <div className="chart-skeleton" style={{ height }} />;
}
