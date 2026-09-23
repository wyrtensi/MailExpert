// A letter without its own font reads in the interface font. The HTML body is rendered in an
// iframe (its own document), which sees neither the app's CSS variables nor its @font-face rules,
// so both are handed over: the family from --font-sans and the @font-face rules for it, copied from
// the app's stylesheets (public/fonts/fonts.css). The URLs there are absolute paths, which resolve
// the same inside the srcdoc iframe.

const FONT_FACE_RULE = 5; // CSSRule.FONT_FACE_RULE, spelled out so this runs outside a browser

const unquote = (name) => String(name ?? '').trim().replace(/^['"]|['"]$/g, '');

// The first family of a font-family list: "'Manrope', sans-serif" -> "Manrope".
export function firstFamily(fontFamily) {
  return unquote(String(fontFamily ?? '').split(',')[0]);
}

// The @font-face rules for `family` in the given style sheets, as CSS text. Sheets another origin
// serves throw on cssRules and are skipped.
export function fontFaceCss(family, styleSheets = []) {
  const wanted = unquote(family).toLowerCase();
  if (!wanted) return '';
  const rules = [];
  for (const sheet of styleSheets) {
    let list;
    try { list = sheet.cssRules; } catch { continue; }
    for (const rule of list || []) {
      if (rule.type !== FONT_FACE_RULE) continue;
      if (unquote(rule.style?.getPropertyValue('font-family')).toLowerCase() === wanted) rules.push(rule.cssText);
    }
  }
  return rules.join('\n');
}

// What the email iframe needs: the font-family value for its body and the @font-face CSS.
export function emailFontFor(doc = globalThis.document) {
  if (!doc?.documentElement) return { family: '', css: '' };
  const fontFamily = getComputedStyle(doc.documentElement).getPropertyValue('--font-sans').trim();
  const family = firstFamily(fontFamily);
  return { family: family ? `'${family}'` : '', css: fontFaceCss(family, doc.styleSheets) };
}
