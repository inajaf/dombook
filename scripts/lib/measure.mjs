/**
 * The readability measurement, as source that runs INSIDE the page.
 *
 * One copy, used by the interface suite and by `scripts/inspect.mjs`. The measurement exists to
 * catch a surface nobody can read, and two copies of it would eventually disagree about which
 * surfaces count — which is the drift the guard tests exist to prevent, one level up.
 *
 * It is source text rather than a function because it is handed to `Runtime.evaluate`: the object
 * it returns has to cross the DevTools boundary, and only serialisable values do.
 */
export const MEASURE_SOURCE = `
  const srgb = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const luminance = ([r, g, b]) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  // color-mix() computes to color(srgb r g b / a), and a parser that reads only rgb()/rgba()
  // does not FAIL on it — it returns null and the node is skipped. A colour this pass cannot read
  // is a colour that passes every check there is, which is how near-white text on a white field
  // stayed green. Both forms are read.
  const parse = (value) => {
    const text = String(value);
    const srgb = text.match(/color\(srgb\s+([^)]+)\)/);
    if (srgb) {
      const parts = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number);
      return { rgb: parts.slice(0, 3).map((v) => Math.round(v * 255)), a: parts.length > 3 ? parts[3] : 1 };
    }
    const m = text.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
  };
  const blend = (fg, fa, bg) => fg.map((c, i) => c * fa + bg[i] * (1 - fa));
  const ratio = (a, b) => { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  // The colour actually behind the glyphs: walk up until an opaque background is found, blending
  // any translucent layers on the way. A contrast check against white alone would pass a label
  // sitting on a tinted panel.
  const effectiveBackground = (el) => {
    const stack = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) { stack.push(bg); if (bg.a >= 0.999) break; }
      node = node.parentElement;
    }
    let base = [255, 255, 255];
    for (let i = stack.length - 1; i >= 0; i -= 1) base = blend(stack[i].rgb, stack[i].a, base);
    return base;
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').trim();

  const tooSmall = [];
  const lowContrast = [];
  for (const el of document.querySelectorAll('body *')) {
    const text = ownText(el);
    if (!text || !visible(el)) continue;
    if (el.closest('.svg-sprite')) continue;
    const s = getComputedStyle(el);
    const size = parseFloat(s.fontSize);
    const fg = parse(s.color);
    if (!fg) continue;
    const bg = effectiveBackground(el);
    const solid = fg.a >= 0.999 ? fg.rgb : blend(fg.rgb, fg.a, bg);
    const large = size >= 24 || (size >= 18.66 && (Number(s.fontWeight) || 400) >= 700);
    const required = large ? 3 : 4.5;
    const value = ratio(solid, bg);
    if (size < 12) tooSmall.push(Math.round(size * 10) / 10 + 'px "' + text.slice(0, 40) + '"');
    if (value < required - 0.02) lowContrast.push(Math.round(value * 100) / 100 + ':1 (needs ' + required + ') ' + size + 'px "' + text.slice(0, 40) + '"');
  }

  // A FIELD'S OWN TEXT, which the pass above cannot see.
  //
  // The contrast check walks text NODES, and an empty <input> has none — its value is a property,
  // not a child node, and its placeholder is a pseudo-element. So a field painted white in the
  // dark theme reported nothing at all while showing near-white text on white to anyone who
  // typed in it. This measures the element itself: its own colour against its own
  // background, which is the same floor the body text is held to.
  const deadFields = [];
  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea')) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    if (!fg) continue;
    const own = parse(s.backgroundColor);
    const bg = own && own.a >= 0.999 ? own.rgb : effectiveBackground(el);
    const value = ratio(fg.a >= 0.999 ? fg.rgb : blend(fg.rgb, fg.a, bg), bg);
    if (value < 4.5 - 0.02) {
      deadFields.push(Math.round(value * 100) / 100 + ':1 on ' + s.backgroundColor + ' — ' + (el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '')) + ' "' + (el.name || el.id || '') + '"');
    }
  }

  const tiny = [];
  for (const el of document.querySelectorAll('button, a[href], select, input:not([type=hidden]), textarea, summary, [role=button]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    // A control wrapped in its own <label> is hit through the label, which is the larger box —
    // a 20px checkbox in a 44px row is a 44px target, not a 20px one.
    const wrapper = el.closest('label');
    const box = wrapper && wrapper !== el ? wrapper.getBoundingClientRect() : r;
    if (box.height < 24 || box.width < 24) {
      tiny.push(Math.round(r.width) + 'x' + Math.round(r.height) + ' "' + (el.innerText || el.getAttribute('aria-label') || el.type || '').trim().slice(0, 30) + '"');
    }
  }
  return { tooSmall, lowContrast, tiny, deadFields };
`;

/** Run it against a connected app and return the four problem lists. */
export async function measure(app) {
  return app.evaluate(MEASURE_SOURCE);
}
