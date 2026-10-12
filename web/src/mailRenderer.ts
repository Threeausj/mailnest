import DOMPurify from 'dompurify';
import type { Message } from './types';

type Attachment = Message['attachments'][number];
export const imageType = /^image\/(?:png|jpe?g|gif|webp|avif|bmp)(?:;|$)/i;
export const maxBodyHeight = 200_000;
const rasterData = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i;
const htmlRoot = 'data-mailnest-email-html';
const bodyRoot = 'data-mailnest-email-body';

export function contentId(value: string) {
  try { return decodeURIComponent(value).trim().replace(/^<|>$/g, ''); }
  catch { return value.trim().replace(/^<|>$/g, ''); }
}

// CSSOM parses declarations and rules first. This scanner handles CSS escapes and
// string/function boundaries in their serialized values, rather than treating CSS
// as a regex: escaped url()/host selectors must receive the same checks as literals.
function escapeEnd(value: string, start: number) {
  let index = start + 1;
  let count = 0;
  while (index < value.length && /[\da-f]/i.test(value[index]) && count < 6) { index++; count++; }
  if (count && /\s/.test(value[index] || '')) return index + (value[index] === '\r' && value[index + 1] === '\n' ? 2 : 1);
  return count ? index : Math.min(value.length, index + 1);
}

function decodeCss(value: string) {
  let decoded = '';
  for (let index = 0; index < value.length;) {
    if (value[index] !== '\\') { decoded += value[index++]; continue; }
    const end = escapeEnd(value, index);
    const escaped = value.slice(index + 1, end);
    if (/^[\da-f]/i.test(escaped)) {
      const point = Number.parseInt(escaped.trim(), 16);
      decoded += String.fromCodePoint(point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? 0xfffd : point);
    } else if (!/^[\r\n\f]/.test(escaped)) decoded += escaped;
    index = end;
  }
  return decoded;
}

function stringEnd(value: string, start: number) {
  const quote = value[start];
  let index = start + 1;
  while (index < value.length) {
    if (value[index] === '\\') index = escapeEnd(value, index);
    else if (value[index++] === quote) return index;
  }
  return value.length;
}

function isName(character: string) {
  return !!character && (/[a-z\d_-]/i.test(character) || character.charCodeAt(0) >= 0x80 || character === '\\');
}

function nameEnd(value: string, start: number) {
  let index = start;
  while (isName(value[index])) index = value[index] === '\\' ? escapeEnd(value, index) : index + 1;
  return index;
}

function functionEnd(value: string, open: number) {
  let level = 1;
  let index = open + 1;
  while (index < value.length) {
    if (value[index] === '"' || value[index] === "'") index = stringEnd(value, index);
    else if (value[index] === '\\') index = escapeEnd(value, index);
    else if (value[index] === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2);
      index = end < 0 ? value.length : end + 2;
    } else {
      if (value[index] === '(') level++;
      if (value[index] === ')' && --level === 0) return index;
      index++;
    }
  }
  return -1;
}

function imageUrl(value: string, images?: Record<string, string>, referenced?: Set<string>): string | undefined {
  const source = value.trim();
  if (/^cid:/i.test(source)) {
    const id = contentId(source.slice(4));
    referenced?.add(id);
    return images ? (Object.hasOwn(images, id) ? images[id] : undefined) : `cid:${id}`;
  }
  if (rasterData.test(source)) return source;
  try {
    // Relative URLs in srcdoc otherwise resolve against the application's origin.
    const url = new URL(source.startsWith('//') ? `https:${source}` : source);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch { /* An unsupported image is replaced, never fetched from the app origin. */ }
  return undefined;
}

function cssQuote(value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, ' ')}"`;
}

function cssValue(value: string, images?: Record<string, string>, referenced?: Set<string>) {
  let output = '';
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character === '"' || character === "'") {
      const end = stringEnd(value, index); output += value.slice(index, end); index = end;
    } else if (character === '/' && value[index + 1] === '*') {
      const end = value.indexOf('*/', index + 2); index = end < 0 ? value.length : end + 2;
    } else if (isName(character)) {
      const end = nameEnd(value, index);
      const name = decodeCss(value.slice(index, end)).toLowerCase();
      // A viewport-height unit anywhere in layout (including a custom property
      // used through var()) can couple natural height to the resized iframe.
      // Strings and URL arguments above/below are handled separately.
      if (/^-?\d+(?:s|l|d)?v(?:h|b|i|min|max)$/.test(name)) return undefined;
      if (value[end] === '(' && name === 'url') {
        const close = functionEnd(value, end);
        if (close < 0) return undefined;
        let argument = value.slice(end + 1, close).trim();
        if (argument.startsWith('"') || argument.startsWith("'")) argument = argument.slice(1, -1);
        const safe = imageUrl(decodeCss(argument), images, referenced);
        if (!safe) return undefined;
        output += `url(${cssQuote(safe)})`;
        index = close + 1;
      } else {
        // These can introduce URLs without url(), defer URL interpretation, or
        // depend on executable worklets. None are needed for ordinary email CSS.
        if (value[end] === '(' && ['image', 'image-set', '-webkit-image-set', 'expression', 'attr', 'paint', 'element', '-moz-element'].includes(name)) return undefined;
        output += value.slice(index, end); index = end;
      }
    } else { output += character; index++; }
  }
  return output;
}

function declarations(style: CSSStyleDeclaration, images?: Record<string, string>, referenced?: Set<string>) {
  const safe = document.createElement('div').style;
  for (const property of Array.from(style)) {
    const name = decodeCss(property).toLowerCase();
    if (['behavior', '-moz-binding', 'animation', 'animation-name', 'transition', 'transition-property'].includes(name)) continue;
    const value = cssValue(style.getPropertyValue(property), images, referenced);
    if (value === undefined) continue;
    const decoded = decodeCss(value).toLowerCase();
    // Fixed elements and viewport-height sizing escape natural document flow and
    // can create an iframe-height feedback loop. Preserve relative/absolute layout.
    if (name === 'position' && decoded.trim() === 'fixed') continue;
    if (/^(?:(?:min|max)-)?(?:height|block-size)$/.test(name) && /(?:\d|\.)\s*(?:s|l|d)?v(?:h|b|i|min|max)\b/.test(decoded)) continue;
    safe.setProperty(property, value, style.getPropertyPriority(property));
  }
  return safe.cssText;
}

function selector(value: string) {
  const decoded = decodeCss(value).toLowerCase();
  // A shadow tree contains all other selectors. Host and slot selectors are the
  // exceptions, so reject them even when their names are CSS-escaped.
  if (decoded.includes(':host') || decoded.includes('::slotted') || decoded.includes('::part')) return undefined;
  let output = '';
  let attributes = 0;
  for (let index = 0; index < value.length;) {
    const character = value[index];
    if (character === '"' || character === "'") {
      const end = stringEnd(value, index); output += value.slice(index, end); index = end;
    } else if (character === '[') { attributes++; output += character; index++; }
    else if (character === ']') { attributes--; output += character; index++; }
    else if (!attributes && isName(character)) {
      const end = nameEnd(value, index);
      const name = decodeCss(value.slice(index, end)).toLowerCase();
      const previous = value[index - 1];
      if (previous === ':' && name === 'root') output = `${output.slice(0, -1)}[${htmlRoot}]`;
      else if ((name === 'html' || name === 'body') && previous !== '.' && previous !== '#' && previous !== ':') output += `[${name === 'html' ? htmlRoot : bodyRoot}]`;
      else output += value.slice(index, end);
      index = end;
    } else { output += character; index++; }
  }
  return output;
}

function rules(list: CSSRuleList, images?: Record<string, string>, referenced?: Set<string>, depth = 0): string {
  if (depth > 8) return '';
  return Array.from(list, (rule) => {
    if (rule instanceof CSSStyleRule) {
      const scoped = selector(rule.selectorText);
      const clean = declarations(rule.style, images, referenced);
      return scoped && clean ? `${scoped}{${clean}}` : '';
    }
    if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
      const child = rules(rule.cssRules, images, referenced, depth + 1);
      return child ? `@${rule instanceof CSSMediaRule ? 'media' : 'supports'} ${rule.conditionText}{${child}}` : '';
    }
    // No @import, @font-face, @page, namespace, keyframes, or CSS property rules.
    return '';
  }).join('\n');
}

function stylesheet(css: string, images?: Record<string, string>, referenced?: Set<string>) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    return rules(sheet.cssRules, images, referenced);
  } catch { return ''; }
}

function inlineStyle(element: Element, images?: Record<string, string>, referenced?: Set<string>) {
  const raw = element.getAttribute('style');
  if (!raw) return;
  const style = document.createElement('div').style;
  style.cssText = raw;
  const safe = declarations(style, images, referenced);
  if (safe) element.setAttribute('style', safe);
  else element.removeAttribute('style');
}

function bodyAttributes(source: HTMLElement, target: HTMLElement) {
  for (const attribute of Array.from(source.attributes)) target.setAttribute(attribute.name, attribute.value);
  // The original body is represented inside the shadow tree, so apply its legacy
  // presentation attributes explicitly (table/td attributes remain native HTML).
  const color = source.getAttribute('text');
  const background = source.getAttribute('bgcolor');
  if (color && !target.style.color) target.style.color = color;
  if (background && !target.style.backgroundColor) target.style.backgroundColor = background;
  const image = source.getAttribute('background');
  if (image && !target.style.backgroundImage) target.style.backgroundImage = `url(${cssQuote(image)})`;
}

function hasAuthorColors(root: HTMLElement, css: string) {
  const colored = (style: CSSStyleDeclaration) => Array.from(style).some(property => /^(?:color|background(?:-.*)?)$/.test(decodeCss(property).toLowerCase()));
  if ([root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].some(element =>
    colored(element.style) || ['color', 'bgcolor', 'text', 'background'].some(name => !!element.getAttribute(name)?.trim()))) return true;
  const containsColors = (list: CSSRuleList): boolean => Array.from(list).some(rule =>
    rule instanceof CSSStyleRule ? colored(rule.style) :
      rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule ? containsColors(rule.cssRules) : false);
  try {
    const sheet = new CSSStyleSheet(); sheet.replaceSync(css);
    return containsColors(sheet.cssRules);
  } catch { return true; }
}

export type PreparedMail = { html: string; css: string; inline: Attachment[]; hasAuthorColors: boolean };

export function prepareMail(html: string, attachments: Attachment[]): PreparedMail {
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'link', 'meta', 'base', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'video', 'audio', 'svg', 'math', 'template', 'slot'],
    FORBID_ATTR: ['srcset', 'autofocus', 'nonce', 'is', 'slot'],
    ADD_ATTR: ['target', 'background', 'cellpadding', 'cellspacing', 'align', 'valign', 'bgcolor'],
  });
  const parsed = new DOMParser().parseFromString(clean, 'text/html');
  const referenced = new Set<string>();
  const css = Array.from(parsed.querySelectorAll('style'), (element) => {
    const safe = stylesheet(element.textContent || '', undefined, referenced);
    const media = element.getAttribute('media');
    element.remove();
    return media ? stylesheet(`@media ${media}{${safe}}`) : safe;
  }).join('\n');
  const mailHtml = parsed.createElement('div');
  const mailBody = parsed.createElement('div');
  bodyAttributes(parsed.documentElement, mailHtml);
  bodyAttributes(parsed.body, mailBody);
  mailHtml.setAttribute(htmlRoot, '');
  mailBody.setAttribute(bodyRoot, '');
  mailBody.append(...Array.from(parsed.body.childNodes));
  mailHtml.append(mailBody);
  mailHtml.querySelectorAll('img').forEach((image) => {
    const src = image.getAttribute('src') || '';
    if (/^cid:/i.test(src)) referenced.add(contentId(src.slice(4)));
  });
  [mailHtml, ...Array.from(mailHtml.querySelectorAll('*'))].forEach((element) => {
    inlineStyle(element, undefined, referenced);
    const background = element.getAttribute('background');
    if (background) {
      const safe = imageUrl(background, undefined, referenced);
      if (safe) element.setAttribute('background', safe);
      else element.removeAttribute('background');
    }
  });
  const inline = attachments.filter((attachment) => attachment.contentId && referenced.has(contentId(attachment.contentId)) && imageType.test(attachment.contentType));
  return { html: mailHtml.outerHTML, css, inline, hasAuthorColors: hasAuthorColors(mailHtml, css) };
}

export function mailDocument(prepared: PreparedMail, images: Record<string, string>, nonce: string, token: string, initialTheme: 'light' | 'dark' = 'light') {
  const parsed = new DOMParser().parseFromString(prepared.html, 'text/html');
  parsed.querySelectorAll('img').forEach((image) => {
    const src = image.getAttribute('src') || '';
    const safe = imageUrl(src, images);
    if (!safe) {
      const placeholder = parsed.createElement('span');
      placeholder.className = 'blocked-image';
      placeholder.textContent = image.alt || (/^cid:/i.test(src) ? '[内嵌图片]' : '[图片无法显示]');
      image.replaceWith(placeholder);
      return;
    }
    image.setAttribute('src', safe);
    image.setAttribute('loading', 'eager');
    image.setAttribute('decoding', 'async');
    image.setAttribute('referrerpolicy', 'no-referrer');
  });
  parsed.querySelectorAll('a, area').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (!/^(https?:\/\/|mailto:)/i.test(href)) link.removeAttribute('href');
    link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer');
  });
  parsed.querySelectorAll('*').forEach((element) => {
    inlineStyle(element, images);
    const background = element.getAttribute('background');
    if (background) {
      const safe = imageUrl(background, images);
      if (safe) element.setAttribute('background', safe);
      else element.removeAttribute('background');
    }
  });
  parsed.querySelectorAll('table').forEach((table) => {
    if (table.parentElement?.closest('table')) return;
    const scroll = parsed.createElement('div');
    scroll.className = 'mail-table-scroll';
    // This wrapper contains wide tables without overriding their original width,
    // cell padding, alignment, or nested layout. Inline important declarations keep
    // an email's generic div/* rules from changing this transport-only wrapper.
    scroll.style.cssText = 'display:block!important;width:100%!important;max-width:100%!important;min-width:0!important;overflow-x:auto!important;overflow-y:hidden!important;position:relative!important;';
    table.replaceWith(scroll); scroll.append(table);
  });
  // Escaping '<' prevents a CSS string containing </style> from ending the trusted
  // style element on srcdoc reparse. Untrusted HTML is stored in an inert template,
  // never interpolated into the executable script.
  const css = stylesheet(prepared.css, images).replace(/</g, '\\3c ');
  const dark = initialTheme === 'dark';
  const adaptive = !prepared.hasAuthorColors;
  const initialInk = dark && adaptive ? '#e5e7eb' : '#1d1d1f';
  const initialBackground = dark ? adaptive ? '#171b22' : '#fff' : 'transparent';
  const measurement = `(()=>{const token='${token}',limit=${maxBodyHeight},adaptive=${adaptive};let root,shadow,lastHeight=0,lastCapped=false,pending=false;function report(){pending=false;if(!root)return;const natural=Math.ceil(root.getBoundingClientRect().height);if(!Number.isFinite(natural))return;const capped=natural>limit,height=Math.max(16,Math.min(limit,natural));document.documentElement.style.overflowY=capped?'auto':'hidden';document.body.style.overflowY=capped?'visible':'hidden';if(height===lastHeight&&capped===lastCapped)return;lastHeight=height;lastCapped=capped;parent.postMessage({type:'mailnest:body-height',token,height,capped},'*')}function schedule(){if(!pending){pending=true;requestAnimationFrame(report)}}function setTheme(data){if(data.theme!=='light'&&data.theme!=='dark')return;const dark=data.theme==='dark';const safe=(value,fallback)=>typeof value==='string'&&CSS.supports('color',value)?value:fallback;document.documentElement.dataset.theme=data.theme;document.documentElement.style.colorScheme=dark&&adaptive?'dark':'light';root.style.setProperty('--mailnest-message-ink',dark&&adaptive?safe(data.foreground,'#e5e7eb'):'#1d1d1f');root.style.setProperty('--mailnest-message-background',dark?adaptive?safe(data.background,'#171b22'):'#fff':'transparent');root.style.setProperty('--mailnest-message-link',dark&&adaptive?'#8ab4ff':'#2563eb');root.style.setProperty('--mailnest-placeholder-ink',dark&&adaptive?'#b3becd':'#839084');root.style.setProperty('--mailnest-placeholder-border',dark&&adaptive?'#586273':'#ccd9d0');schedule()}function start(){root=document.body.firstElementChild;const host=root.firstElementChild,source=document.querySelector('template[data-mailnest-source]');shadow=host.attachShadow({mode:'open'});shadow.append(source.content);source.remove();new ResizeObserver(schedule).observe(root);shadow.addEventListener('load',schedule,true);window.addEventListener('resize',schedule);window.addEventListener('message',event=>{if(event.source!==parent||event.data?.token!==token)return;if(event.data.type==='mailnest:theme')setTheme(event.data);else if(event.data.type==='mailnest:measure-request'){lastHeight=0;schedule()}});schedule()}document.addEventListener('DOMContentLoaded',start,{once:true})})();`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><style>html{color-scheme:${dark && adaptive ? 'dark' : 'light'};background:transparent;overflow-x:hidden;overflow-y:hidden}body{margin:0;padding:0;background:transparent;overflow-y:hidden}.mailnest-document-root{display:flow-root;width:100%;min-width:0;padding:4px 0 12px;background:var(--mailnest-message-background);--mailnest-message-background:${initialBackground};--mailnest-message-ink:${initialInk};--mailnest-message-link:${dark && adaptive ? '#8ab4ff' : '#2563eb'}}[data-mailnest-mail-host]{display:flow-root;width:100%;min-width:0}</style><script nonce="${nonce}" data-mailnest-measure>${measurement}</script></head><body><div class="mailnest-document-root"><div data-mailnest-mail-host></div></div><template data-mailnest-source><style>[${htmlRoot}],[${bodyRoot}]{display:flow-root;min-width:0}[${bodyRoot}]{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:var(--mailnest-message-ink,#1d1d1f)}a{color:var(--mailnest-message-link,#2563eb)}img{max-width:100%!important;height:auto!important}pre{white-space:pre-wrap;overflow-wrap:anywhere}.blocked-image{display:inline-block;border:1px dashed var(--mailnest-placeholder-border,#ccd9d0);border-radius:4px;padding:4px 8px;color:var(--mailnest-placeholder-ink,#839084);font-size:12px}</style><style>${css}</style>${parsed.body.innerHTML}</template></body></html>`;
}
