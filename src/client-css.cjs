// Client styles for dsh-daily.
//
// Colours are built with color-mix() against currentColor and low-alpha
// accents, so the panel inherits the host theme instead of fighting it. No
// hard-coded background or text colour anywhere, which is what keeps it legible
// under both light and dark themes without shipping two palettes.

module.exports = [
  '.dd-root{display:flex;flex-direction:column;gap:14px;padding:16px;height:100%;overflow:auto;color:inherit;font-size:13px;line-height:1.5}',
  '.dd-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}',
  '.dd-title{font-size:15px;font-weight:600}',
  '.dd-sub{opacity:.6;font-size:12px}',
  '.dd-spacer{flex:1}',
  '.dd-btn{border:1px solid color-mix(in srgb,currentColor 22%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;cursor:pointer}',
  '.dd-btn:hover{background:color-mix(in srgb,currentColor 8%,transparent)}',
  '.dd-btn:disabled{opacity:.45;cursor:default}',
  '.dd-btn.dd-primary{border-color:color-mix(in srgb,#16a34a 45%,transparent);background:color-mix(in srgb,#16a34a 14%,transparent);color:color-mix(in srgb,#16a34a 80%,currentColor)}',
  '.dd-bar{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;opacity:.75;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:8px;padding:7px 10px}',
  '.dd-bar b{font-variant-numeric:tabular-nums}',
  '.dd-sec>h4{margin:0 0 8px;font-size:12px;font-weight:600;opacity:.75;display:flex;align-items:center;gap:8px}',
  '.dd-count{opacity:.55;font-weight:400}',
  '.dd-list{display:flex;flex-direction:column;gap:8px}',
  '.dd-card{border:1px solid color-mix(in srgb,currentColor 13%,transparent);border-radius:9px;padding:10px 12px}',
  '.dd-card.dd-idea{border-left:3px solid color-mix(in srgb,#7c3aed 60%,transparent)}',
  '.dd-card.dd-improve{border-left:3px solid color-mix(in srgb,#0284c7 55%,transparent)}',
  '.dd-row1{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
  '.dd-name{font-weight:600;font-size:13px}',
  '.dd-tag{font-size:11px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,currentColor 9%,transparent);opacity:.8}',
  // The type label is the one that carries the product rule (a report must not
  // be all one type), so it is coloured rather than left as a grey tag.
  '.dd-type{font-size:11px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,#0891b2 14%,transparent);color:color-mix(in srgb,#0891b2 78%,currentColor);border:1px solid color-mix(in srgb,#0891b2 30%,transparent)}',
  '.dd-actions{margin-left:auto;display:flex;gap:6px}',
  '.dd-line{font-size:12px;margin-top:4px}',
  '.dd-delta{font-size:12.5px}',
  '.dd-k{opacity:.55}',
  '.dd-link{color:inherit;text-decoration:underline;text-underline-offset:2px;opacity:.8;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}',
  '.dd-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid transparent}',
  '.dd-badge.dd-ok{background:color-mix(in srgb,#16a34a 16%,transparent);color:color-mix(in srgb,#16a34a 80%,currentColor);border-color:color-mix(in srgb,#16a34a 32%,transparent)}',
  '.dd-badge.dd-warn{background:color-mix(in srgb,#d97706 16%,transparent);color:color-mix(in srgb,#d97706 82%,currentColor);border-color:color-mix(in srgb,#d97706 32%,transparent)}',
  '.dd-empty{opacity:.55;font-size:12px;padding:8px 0}',
  '.dd-err{border:1px solid color-mix(in srgb,#dc2626 50%,transparent);background:color-mix(in srgb,#dc2626 8%,transparent);border-radius:8px;padding:8px 10px;font-size:12px}',
  '.dd-notes{font-size:12px;opacity:.8;font-style:italic}',
  '.dd-hist{display:flex;gap:8px;flex-wrap:wrap;font-size:12px}',
  '.dd-hist span{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:6px;padding:2px 8px;opacity:.8}',
  '.dd-spin{display:inline-block;animation:dd-rot 1s linear infinite}',
  '@keyframes dd-rot{to{transform:rotate(360deg)}}',
].join('')
