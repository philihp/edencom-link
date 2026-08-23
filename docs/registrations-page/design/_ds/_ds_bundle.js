/* @ds-bundle: {"format":4,"namespace":"DesignSystem_80a92c","components":[{"name":"EntityCard","sourcePath":"components/cards/EntityCard.jsx"},{"name":"Avatar","sourcePath":"components/core/Avatar.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"StatusDot","sourcePath":"components/core/StatusDot.jsx"},{"name":"Sparkline","sourcePath":"components/data/Sparkline.jsx"},{"name":"SparklineStat","sourcePath":"components/data/SparklineStat.jsx"},{"name":"StatusTable","sourcePath":"components/data/StatusTable.jsx"},{"name":"RangePicker","sourcePath":"components/forms/RangePicker.jsx"},{"name":"BracketNav","sourcePath":"components/navigation/BracketNav.jsx"}],"sourceHashes":{"components/cards/EntityCard.jsx":"d0a29472c24f","components/core/Avatar.jsx":"fad4b1325b8c","components/core/Badge.jsx":"8d46399a8a97","components/core/Button.jsx":"a1851da1f31b","components/core/StatusDot.jsx":"ff222fba1528","components/data/Sparkline.jsx":"ad1da93e23c7","components/data/SparklineStat.jsx":"def5c713add3","components/data/StatusTable.jsx":"3041db9985ac","components/forms/RangePicker.jsx":"48fe176cb05f","components/navigation/BracketNav.jsx":"3d33b1ee26ad"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.DesignSystem_80a92c = window.DesignSystem_80a92c || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Avatar.jsx
try { (() => {
function hash(str, mult) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = h * mult + str.charCodeAt(i) >>> 0;
  return h;
}
function initialsFor(name) {
  const parts = String(name).split(' ').filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
function Avatar({
  name,
  size = 52,
  color
}) {
  const bg = color || `hsl(${hash(name || '', 31) % 360}, 45%, 32%)`;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      width: size,
      height: size,
      borderRadius: '50%',
      background: bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontWeight: 700,
      fontSize: Math.round(size * 0.3),
      color: 'var(--text-primary)',
      flexShrink: 0,
      fontFamily: "'Eve Sans Neue', sans-serif"
    }
  }, initialsFor(name || ''));
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
const TONES = {
  info: 'var(--status-info)',
  good: 'var(--status-good)',
  warn: 'var(--status-warn)',
  bad: 'var(--status-bad)',
  neutral: 'var(--text-tertiary)'
};
function Badge({
  children,
  tone = 'info'
}) {
  const color = TONES[tone] || tone;
  return /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      fontWeight: 700,
      color,
      border: `1px solid ${color}`,
      borderRadius: 3,
      padding: '1px 5px',
      letterSpacing: 0.4,
      flexShrink: 0,
      fontFamily: "'Eve Sans Neue', sans-serif",
      textTransform: 'uppercase',
      display: 'inline-block'
    }
  }, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/cards/EntityCard.jsx
try { (() => {
function EntityCard({
  name,
  subtitle,
  meta,
  isMain,
  onClick,
  onMenuClick,
  menuOpen,
  menuItems
}) {
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      background: 'var(--surface-card)',
      border: '1px solid var(--surface-card-border)',
      borderRadius: 'var(--radius-lg)',
      padding: 16,
      position: 'relative',
      cursor: onClick ? 'pointer' : 'default',
      fontFamily: "'Eve Sans Neue', sans-serif"
    }
  }, onMenuClick ? /*#__PURE__*/React.createElement("button", {
    onClick: e => {
      e.stopPropagation();
      onMenuClick(e);
    },
    style: {
      position: 'absolute',
      top: 12,
      right: 12,
      background: 'transparent',
      border: 'none',
      color: 'var(--text-tertiary)',
      fontSize: 16,
      lineHeight: 1,
      cursor: 'pointer',
      padding: '4px 8px',
      borderRadius: 4
    }
  }, "\u22EE") : null, menuOpen && menuItems ? /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      position: 'absolute',
      top: 38,
      right: 12,
      background: 'var(--bg-overlay)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-overlay)',
      zIndex: 10,
      minWidth: 180,
      overflow: 'hidden'
    }
  }, menuItems.map((item, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    onClick: item.onClick,
    style: {
      padding: '10px 14px',
      fontSize: 13,
      color: 'var(--text-primary)',
      cursor: 'pointer',
      whiteSpace: 'nowrap'
    }
  }, item.label))) : null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      alignItems: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Avatar, {
    name: name,
    size: 52
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0,
      flex: 1,
      paddingRight: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      fontSize: 16,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      color: 'var(--text-primary)'
    }
  }, name), isMain ? /*#__PURE__*/React.createElement(__ds_scope.Badge, {
    tone: "info"
  }, "Main") : null), subtitle ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: 'var(--text-secondary)',
      marginTop: 6
    }
  }, subtitle) : null)), meta ? /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      borderTop: '1px solid var(--surface-card-border)',
      paddingTop: 10
    }
  }, meta) : null);
}
Object.assign(__ds_scope, { EntityCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/cards/EntityCard.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function Button({
  children,
  variant = 'primary',
  size = 'md',
  onClick,
  disabled
}) {
  const base = {
    border: 'none',
    borderRadius: 'var(--radius-md)',
    fontFamily: "'Eve Sans Neue', sans-serif",
    fontWeight: 700,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    padding: size === 'sm' ? '7px 14px' : '10px 18px',
    fontSize: size === 'sm' ? 13 : 14
  };
  const variants = {
    primary: {
      background: 'var(--accent-primary)',
      color: '#17181a'
    },
    secondary: {
      background: 'var(--bg-overlay)',
      color: 'var(--text-primary)'
    },
    ghost: {
      background: 'transparent',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-strong)'
    }
  };
  return /*#__PURE__*/React.createElement("button", {
    onClick: disabled ? undefined : onClick,
    disabled: disabled,
    style: {
      ...base,
      ...variants[variant]
    }
  }, children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/StatusDot.jsx
try { (() => {
const TONES = {
  good: 'var(--status-good)',
  warn: 'var(--status-warn)',
  bad: 'var(--status-bad)',
  info: 'var(--status-info)'
};
function StatusDot({
  tone = 'good',
  label,
  size = 8
}) {
  return /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: size,
      height: size,
      borderRadius: '50%',
      background: TONES[tone] || tone,
      flexShrink: 0,
      display: 'inline-block'
    }
  }), label ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: 'var(--text-secondary)',
      fontFamily: "'Eve Sans Neue', sans-serif"
    }
  }, label) : null);
}
Object.assign(__ds_scope, { StatusDot });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/StatusDot.jsx", error: String((e && e.message) || e) }); }

// components/data/Sparkline.jsx
try { (() => {
/**
 * Raw sparkline SVG: a thin line across `values`, a faint reference line at the
 * vertical midpoint, and enforces a minimum visual range so near-flat series
 * still show motion.
 */
function Sparkline({
  values,
  width = 90,
  height = 28,
  minRange = 1,
  strokeColor
}) {
  const vals = values && values.length ? values : [0, 0];
  const rawMax = Math.max(...vals);
  const rawMin = Math.min(...vals);
  let max = rawMax;
  let min = rawMin;
  if (max - min < minRange) {
    const mid = (max + min) / 2;
    max = mid + minRange / 2;
    min = mid - minRange / 2;
  }
  const span = max - min || 1;
  const stepX = vals.length > 1 ? width / (vals.length - 1) : width;
  const points = vals.map((v, i) => {
    const x = i * stepX;
    const y = height - (v - min) / span * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const midY = height / 2;
  return /*#__PURE__*/React.createElement("svg", {
    width: width,
    height: height,
    viewBox: `0 0 ${width} ${height}`,
    style: {
      display: 'block',
      overflow: 'visible'
    }
  }, /*#__PURE__*/React.createElement("line", {
    x1: "0",
    y1: midY,
    x2: width,
    y2: midY,
    stroke: "var(--text-primary)",
    strokeOpacity: "0.14",
    strokeWidth: "1"
  }), /*#__PURE__*/React.createElement("polyline", {
    points: points.join(' '),
    fill: "none",
    stroke: strokeColor || 'var(--text-secondary)',
    strokeWidth: "1.5",
    strokeLinejoin: "round",
    strokeLinecap: "round"
  }));
}
Object.assign(__ds_scope, { Sparkline });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/Sparkline.jsx", error: String((e && e.message) || e) }); }

// components/data/SparklineStat.jsx
try { (() => {
/**
 * Composite row: stacked high/low labels, the sparkline, and a bold current-value
 * readout — the exact unit repeated across Indexes table cells and Structure cards.
 */
function SparklineStat({
  values,
  formatValue = v => `${v.toFixed(2)}%`,
  width = 90,
  height = 28,
  minRange = 1
}) {
  const vals = values && values.length ? values : [0];
  const high = Math.max(...vals);
  const low = Math.min(...vals);
  const current = vals[vals.length - 1];
  const flat = vals.length < 2 || vals.every(v => v === vals[0]);
  if (vals.length === 0) {
    return /*#__PURE__*/React.createElement("span", {
      style: {
        color: 'var(--text-tertiary)',
        fontFamily: 'monospace'
      }
    }, "\u2014");
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      fontFamily: "'Eve Sans Neue', sans-serif"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'monospace',
      fontSize: 10,
      lineHeight: 1.3,
      color: 'var(--text-tertiary)',
      textAlign: 'right',
      minWidth: 40
    }
  }, /*#__PURE__*/React.createElement("div", null, formatValue(high)), /*#__PURE__*/React.createElement("div", null, formatValue(low))), /*#__PURE__*/React.createElement(__ds_scope.Sparkline, {
    values: vals,
    width: width,
    height: height,
    minRange: minRange
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      fontWeight: 700,
      fontSize: 15,
      color: 'var(--text-primary)',
      minWidth: 56
    }
  }, formatValue(current)));
}
Object.assign(__ds_scope, { SparklineStat });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/SparklineStat.jsx", error: String((e && e.message) || e) }); }

// components/data/StatusTable.jsx
try { (() => {
function StatusTable({
  columns,
  rows
}) {
  const template = columns.map(c => c.width || '1fr').join(' ');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px solid var(--surface-card-border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      fontFamily: "'Eve Sans Neue', sans-serif"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: template,
      padding: '10px 16px',
      background: 'var(--bg-surface)',
      fontSize: 12,
      color: 'var(--text-tertiary)',
      textTransform: 'uppercase',
      letterSpacing: 0.4
    }
  }, columns.map((c, i) => /*#__PURE__*/React.createElement("div", {
    key: i
  }, c.label))), rows.map((row, ri) => /*#__PURE__*/React.createElement("div", {
    key: ri,
    style: {
      display: 'grid',
      gridTemplateColumns: template,
      padding: '12px 16px',
      borderTop: '1px solid var(--surface-card-border)',
      alignItems: 'center',
      fontSize: 14
    }
  }, columns.map((c, ci) => /*#__PURE__*/React.createElement("div", {
    key: ci,
    style: {
      color: c.dim ? 'var(--text-secondary)' : 'var(--text-primary)',
      fontFamily: c.mono ? 'monospace' : 'inherit',
      fontSize: c.mono ? 12 : 14,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, c.statusKey ? /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.StatusDot, {
    tone: row[c.statusKey]
  }), /*#__PURE__*/React.createElement("span", null, row[c.key])) : row[c.key])))));
}
Object.assign(__ds_scope, { StatusTable });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/StatusTable.jsx", error: String((e && e.message) || e) }); }

// components/forms/RangePicker.jsx
try { (() => {
function RangePicker({
  options = ['1 day', '3 days', '7 days', '14 days', '28 days'],
  value,
  onChange
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      display: 'inline-block'
    }
  }, /*#__PURE__*/React.createElement("select", {
    value: value,
    onChange: e => onChange && onChange(e.target.value),
    style: {
      appearance: 'none',
      WebkitAppearance: 'none',
      background: 'var(--bg-surface)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-md)',
      color: 'var(--text-primary)',
      fontFamily: "'Eve Sans Neue', sans-serif",
      fontSize: 14,
      padding: '9px 32px 9px 14px',
      cursor: 'pointer'
    }
  }, options.map(opt => /*#__PURE__*/React.createElement("option", {
    key: opt,
    value: opt,
    style: {
      background: 'var(--bg-surface)'
    }
  }, opt))), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      right: 12,
      top: '50%',
      transform: 'translateY(-50%)',
      pointerEvents: 'none',
      color: 'var(--text-tertiary)',
      fontSize: 11
    }
  }, "\u25BE"));
}
Object.assign(__ds_scope, { RangePicker });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/RangePicker.jsx", error: String((e && e.message) || e) }); }

// components/navigation/BracketNav.jsx
try { (() => {
function BracketNav({
  items,
  activeId,
  onSelect
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 20,
      fontSize: 14,
      color: 'var(--text-tertiary)',
      fontFamily: "'Eve Sans Neue', sans-serif",
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("span", null, "["), items.map((item, i) => /*#__PURE__*/React.createElement("a", {
    key: item.id,
    href: "#",
    onClick: e => {
      e.preventDefault();
      onSelect && onSelect(item.id);
    },
    style: {
      color: item.id === activeId ? 'var(--text-primary)' : 'var(--link)',
      textDecoration: 'none'
    }
  }, item.label)), /*#__PURE__*/React.createElement("span", null, "]"));
}
Object.assign(__ds_scope, { BracketNav });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/navigation/BracketNav.jsx", error: String((e && e.message) || e) }); }

__ds_ns.EntityCard = __ds_scope.EntityCard;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.StatusDot = __ds_scope.StatusDot;

__ds_ns.Sparkline = __ds_scope.Sparkline;

__ds_ns.SparklineStat = __ds_scope.SparklineStat;

__ds_ns.StatusTable = __ds_scope.StatusTable;

__ds_ns.RangePicker = __ds_scope.RangePicker;

__ds_ns.BracketNav = __ds_scope.BracketNav;

})();
