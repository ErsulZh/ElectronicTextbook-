import * as pdfjsLib from '/node_modules/pdfjs-dist/build/pdf.mjs';
import { PageFlip } from '/node_modules/page-flip/dist/js/page-flip.module.js';

// PDF.js 5 uses a recently added Map helper that is absent in the Chromium
// version bundled with some Electron releases. Keep the reader compatible.
if (!Map.prototype.getOrInsertComputed) {
  Object.defineProperty(Map.prototype, 'getOrInsertComputed', {
    value(key, createValue) {
      if (!this.has(key)) this.set(key, createValue(key));
      return this.get(key);
    },
    configurable: true
  });
}

pdfjsLib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';
const $ = selector => document.querySelector(selector);
const cleanText = value => value.replace(/\s+/g, ' ').trim();
let supportedExtensions = new Set(['.pdf', '.docx', '.docm', '.dotx', '.dotm', '.doc', '.dot', '.docb', '.odt', '.rtf', '.txt', '.md', '.html', '.htm', '.epub']);
let formatByExtension = new Map(), serverCapabilities = null;
let pages = [], toc = [], pageFlip = null, importing = false, sourceBlocks = [], documentLayout = null, documentTocHints = [];
let importNotices = [], resizeTimer = null;
const renderedPdfPages = new Set();
let sessionToken = null, currentImportId = null;
let activePdf = null;

void loadFormatSupport();

async function loadFormatSupport() {
  try {
    const response = await fetch('/src/format-support.json', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.formats)) throw new Error('Файл поддержки форматов недоступен.');
    formatByExtension = new Map(data.formats.flatMap(format => format.extensions.map(extension => [extension, format])));
    supportedExtensions = new Set(formatByExtension.keys());
    $('#fileInput').accept = [...supportedExtensions].join(',');
    renderFormatSupport(data.formats);
  } catch (error) {
    console.warn('Не удалось загрузить информацию о форматах:', error);
  }
}

async function getServerCapabilities() {
  if (serverCapabilities) return serverCapabilities;
  const response = await fetch('/api/capabilities', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error('Не удалось проверить поддержку Microsoft Word.');
  serverCapabilities = data;
  return data;
}

function renderFormatSupport(formats) {
  const list = $('#supportedFormats');
  if (list) list.textContent = formats.flatMap(format => format.extensions).map(extension => extension.slice(1).toUpperCase()).join(' · ');
  const table = $('#formatSupportTable');
  if (!table) return;
  table.innerHTML = formats.map(format => `<tr><td>${format.label}</td><td>${formatStatusLabel(format.status)}</td><td>${format.preserves}</td><td>${format.limitation}</td></tr>`).join('');
}

function formatStatusLabel(status) {
  return ({ supported: 'Поддерживается', limited: 'Ограниченно', 'requires-word': 'Нужен Word' })[status] || 'Неизвестно';
}

$('#openFile').onclick = chooseFile;
$('#newFile').onclick = chooseFile;
$('#prev').onclick = () => pageFlip?.flipPrev('bottom');
$('#next').onclick = () => pageFlip?.flipNext('bottom');
$('#tocToggle').onclick = () => setTocPanelVisibility($('#tocPanel').hidden, { moveFocus: true });
$('#closeToc').onclick = () => setTocPanelVisibility(false, { moveFocus: true });
$('#tocSearch').oninput = filterToc;
$('#goPage').onclick = goToPage;
$('#pageJump').onkeydown = event => { if (event.key === 'Enter') goToPage(); };
const narrowViewport = window.matchMedia('(max-width: 799px)');
narrowViewport.addEventListener('change', event => { setTocPanelVisibility(!event.matches); });
$('#fileInput').onchange = event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (file) importFile(file);
};

const uploadCard = document.querySelector('.upload-card');
if (uploadCard) {
  ['dragenter', 'dragover'].forEach(type => uploadCard.addEventListener(type, event => {
    event.preventDefault();
    if (!importing) uploadCard.classList.add('is-drop-target');
  }));
  ['dragleave', 'drop'].forEach(type => uploadCard.addEventListener(type, event => {
    event.preventDefault();
    uploadCard.classList.remove('is-drop-target');
  }));
  uploadCard.addEventListener('drop', event => {
    const [file] = event.dataTransfer?.files || [];
    if (file) importFile(file);
  });
}

async function chooseFile() {
  if (importing) return;
  $('#fileInput').click();
}

async function getSessionToken() {
  if (sessionToken) return sessionToken;
  const response = await fetch('/api/session', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.token) throw new Error('Не удалось установить защищённое соединение с локальным сервером. Перезапустите сайт.');
  sessionToken = data.token;
  return sessionToken;
}

async function releaseImport(id) {
  if (!id || !sessionToken) return;
  try {
    await fetch(`/api/import/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'X-Textbook-Token': sessionToken },
      keepalive: true
    });
  } catch (_) {
    // The server removes stale imports automatically; a failed cleanup request must not interrupt reading.
  }
}

async function disposePdf(pdf) {
  try { await pdf?.destroy?.(); } catch (_) { /* A closed PDF worker needs no further action. */ }
}

function setTocPanelVisibility(open, { moveFocus = false } = {}) {
  const panel = $('#tocPanel');
  const toggle = $('#tocToggle');
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  if (!moveFocus) return;
  if (open) requestAnimationFrame(() => $('#tocSearch').focus());
  else toggle.focus();
}

function applyPreparedBook(prepared) {
  pages = prepared.pages;
  toc = prepared.toc;
  sourceBlocks = prepared.sourceBlocks;
  documentLayout = prepared.documentLayout;
  documentTocHints = prepared.documentTocHints;
  importNotices = prepared.importNotices;
  activePdf = prepared.pdf;
}

function captureBookState() {
  return { pages, toc, sourceBlocks, documentLayout, documentTocHints, importNotices, pdf: activePdf };
}

async function importFile(selectedFile) {
  if (importing) return;
  const extension = `.${selectedFile.name.split('.').pop()?.toLowerCase() || ''}`;
  if (!supportedExtensions.has(extension)) {
    alert('Этот формат пока не поддерживается. Откройте таблицу «Поддержка форматов» на стартовой странице.');
    return;
  }
  importing = true;
  $('#loading').hidden = false;
  $('#openFile').disabled = true;
  $('#newFile').disabled = true;
  const previousState = captureBookState();
  let importedId = null;
  let prepared = null;
  try {
    const format = formatByExtension.get(extension);
    if (format?.status === 'requires-word') {
      const capabilities = await getServerCapabilities();
      if (!capabilities.wordConversionAvailable) throw new Error(`Для ${format.label} нужен установленный Microsoft Word. Сохраните файл как DOCX или PDF либо установите Word.`);
    }
    const token = await getSessionToken();
    const response = await fetch(`/api/import?name=${encodeURIComponent(selectedFile.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Textbook-Token': token },
      body: selectedFile
    });
    const imported = await response.json();
    if (!response.ok) throw new Error(imported.error || 'Сервер не смог прочитать файл.');
    importedId = imported.id;
    const loading = imported.extension === '.pdf' ? loadPdf(imported) : loadDocument(imported);
    const timeoutError = new Error('Превышено время ожидания. Попробуйте открыть другой файл.');
    let timeoutId;
    const timeout = new Promise((_, reject) => { timeoutId = setTimeout(() => reject(timeoutError), 90000); });
    try {
      prepared = await Promise.race([loading, timeout]);
    } catch (error) {
      if (error === timeoutError) void loading.then(lateBook => disposePdf(lateBook.pdf)).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
    const previousPdf = previousState.pdf;
    applyPreparedBook(prepared);
    $('#bookName').textContent = imported.name;
    $('#welcome').hidden = true;
    $('#reader').hidden = false;
    setTocPanelVisibility(!narrowViewport.matches);
    renderToc();
    renderImportNotice();
    createBook();
    const previousImportId = currentImportId;
    currentImportId = imported.id;
    if (previousImportId && previousImportId !== currentImportId) void releaseImport(previousImportId);
    if (previousPdf && previousPdf !== activePdf) void disposePdf(previousPdf);
  } catch (error) {
    if (prepared?.pdf && prepared.pdf !== previousState.pdf) void disposePdf(prepared.pdf);
    applyPreparedBook(previousState);
    if (importedId) void releaseImport(importedId);
    alert(`Не удалось открыть файл. Проверьте формат документа.\n\n${error.message}`);
  } finally {
    importing = false;
    $('#loading').hidden = true;
    $('#openFile').disabled = false;
    $('#newFile').disabled = false;
  }
}

async function loadDocument(file) {
  const model = file.document;
  if (!model?.blocks?.length) throw new Error('Сервер не вернул модель документа. Попробуйте открыть файл ещё раз.');
  const nextImportNotices = [...(file.notices || []), ...(model.notices || [])];
  const nextTocHints = model.tocHints || [];
  const holder = document.createElement('div');
  model.blocks.forEach(block => {
    const template = document.createElement('template');
    template.innerHTML = sanitizeImportedHtml(block.html || '');
    holder.append(template.content);
  });
  const nextBlocks = collectSourceBlocks(holder);
  const nextLayout = getPageLayout();
  let { pages: nextPages, toc: nextToc } = paginateDocument(nextBlocks, nextLayout, nextTocHints);
  if (nextPages.length > 1200) throw new Error('После разбиения получилось больше 1200 страниц. Разделите материал на части.');
  if (!nextPages.length) nextPages = [{ type: 'html', html: '<h1>Документ</h1><p>В файле нет отображаемого текста.</p>' }];
  nextToc = nextToc.filter(item => item.page < nextPages.length);
  if (!nextToc.length) nextToc = [{ title: 'Начало документа', level: 1, page: 0 }];
  return { pages: nextPages, toc: nextToc, sourceBlocks: nextBlocks, documentLayout: nextLayout, documentTocHints: nextTocHints, importNotices: nextImportNotices, pdf: null };
}

function sanitizeImportedHtml(html) {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  holder.querySelectorAll('script,style,iframe,object,embed,form,link,meta,xml').forEach(node => node.remove());
  holder.querySelectorAll('*').forEach(node => [...node.attributes].forEach(attribute => {
    if (attribute.name === 'style' || attribute.name.startsWith('on') || /^javascript:/i.test(attribute.value)) node.removeAttribute(attribute.name);
  }));
  holder.querySelectorAll('[src], [srcset], [href]').forEach(node => {
    for (const name of ['src', 'srcset', 'href']) {
      const value = node.getAttribute(name);
      if (!value) continue;
      if (!value.startsWith('/api/asset/') && !value.startsWith('#')) node.removeAttribute(name);
    }
  });
  return holder.innerHTML;
}

function collectSourceBlocks(holder) {
  return [...holder.childNodes].flatMap(normalizeSourceNode)
    .filter(node => cleanText(node.textContent) || node.querySelector?.('img,table'));
}

function normalizeSourceNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = cleanText(node.textContent || '');
    if (!text) return [];
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    return expandBlock(paragraph);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const tag = node.tagName.toUpperCase();
  if (['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'BODY', 'CENTER', 'FONT'].includes(tag) && node.children.length) {
    return [...node.childNodes].flatMap(normalizeSourceNode);
  }
  if (tag === 'UL' || tag === 'OL') return splitList(node);
  return expandBlock(node);
}

function expandBlock(block) {
  block.querySelectorAll('img').forEach(image => image.removeAttribute('style'));
  if (block.tagName === 'TABLE' || block.tagName === 'UL' || block.tagName === 'OL') return [block];
  const text = cleanText(block.textContent || '');
  if (!['P', 'LI'].includes(block.tagName) || block.querySelector('img,table') || text.length < 720) return [block];
  return splitTextBlock(block, 420);
}

function splitTextBlock(block, limit = 420) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) textNodes.push(walker.currentNode);
  if (!textNodes.length) return [block];
  const parts = [];
  let part, length;
  const startPart = () => {
    part = block.cloneNode(false);
    if (parts.length) part.classList.add('continued-paragraph');
    length = 0;
    parts.push(part);
  };
  const appendToken = (textNode, token) => {
    const ancestors = [];
    for (let parent = textNode.parentElement; parent && parent !== block; parent = parent.parentElement) ancestors.unshift(parent);
    let target = part;
    ancestors.forEach(original => {
      const copy = original.cloneNode(false);
      target.append(copy);
      target = copy;
    });
    target.append(document.createTextNode(token));
  };
  startPart();
  textNodes.forEach(textNode => {
    textNode.nodeValue.split(/(\s+)/).filter(Boolean).forEach(token => {
      const maxTokenPart = Math.max(24, Math.floor(limit * 0.75));
      const tokenParts = /\S/.test(token) && token.length > maxTokenPart
        ? token.match(new RegExp(`.{1,${maxTokenPart}}`, 'g')) || [token]
        : [token];
      tokenParts.forEach(partText => {
        const isWord = /\S/.test(partText);
        if (isWord && length + partText.length > limit && length > limit * 0.45) startPart();
        appendToken(textNode, partText);
        length += partText.length;
      });
    });
  });
  if (parts.length > 1 && cleanText(parts.at(-1).textContent).length < 48) {
    const last = parts.pop();
    parts.at(-1).append(...last.childNodes);
  }
  return parts;
}

function splitTable(table, rowsPerPart = 6) {
  const rows = [...table.rows];
  const headerRows = table.tHead ? [...table.tHead.rows] : (rows[0]?.cells.length && [...rows[0].cells].every(cell => cell.tagName === 'TH') ? [rows[0]] : []);
  const bodyRows = rows.filter(row => !headerRows.includes(row));
  if (bodyRows.length <= rowsPerPart) return [table];
  const tables = [];
  for (let start = 0; start < bodyRows.length; start += rowsPerPart) {
    const copy = table.cloneNode(false);
    if (headerRows.length) {
      const head = document.createElement('thead');
      headerRows.forEach(row => head.append(row.cloneNode(true)));
      copy.append(head);
    }
    const body = document.createElement('tbody');
    bodyRows.slice(start, start + rowsPerPart).forEach(row => body.append(row.cloneNode(true)));
    copy.append(body);
    tables.push(copy);
  }
  return tables;
}

function splitList(list, itemsPerPart = 6, itemTextLimit = 420) {
  const items = [...list.children].filter(item => item.tagName === 'LI');
  const itemParts = items.flatMap((item, itemIndex) => {
    const fragments = cleanText(item.textContent).length > itemTextLimit
      ? splitTextBlock(item, itemTextLimit)
      : [item.cloneNode(true)];
    return fragments.map((fragment, fragmentIndex) => ({ fragment, itemIndex, continuation: fragmentIndex > 0 }));
  });
  if (itemParts.length <= itemsPerPart && itemParts.length === items.length) return [list];
  const chunks = [];
  const initialStart = Number(list.getAttribute('start')) || 1;
  for (let start = 0; start < itemParts.length; start += itemsPerPart) {
    const copy = list.cloneNode(false);
    const chunk = itemParts.slice(start, start + itemsPerPart);
    if (copy.tagName === 'OL') copy.setAttribute('start', String(initialStart + chunk[0].itemIndex));
    chunk.forEach(({ fragment, itemIndex, continuation }) => {
      if (copy.tagName === 'OL' && continuation) fragment.setAttribute('value', String(initialStart + itemIndex));
      copy.append(fragment);
    });
    chunks.push(copy);
  }
  return chunks;
}

function getPageLayout() {
  const readerWidth = document.querySelector('.reading-area')?.clientWidth || 0;
  const availableWidth = readerWidth > 320
    ? readerWidth
    : Math.max(360, window.innerWidth - (window.innerWidth > 760 ? 300 : 0));
  const narrow = availableWidth <= 760;
  const totalWidth = Math.min(availableWidth * (narrow ? 0.92 : 0.94), narrow ? 620 : 1120);
  return {
    width: Math.max(280, Math.min(600, Math.floor(narrow ? totalWidth : totalWidth / 2))),
    height: Math.max(410, Math.min(Math.floor((window.innerHeight - 74) * (narrow ? 0.70 : 0.75)), 720))
  };
}

function isHeadingNode(node) {
  return /^H[1-6]$/.test(node?.tagName || '');
}

function hasBodyContent(nodes) {
  return nodes.some(node => !isHeadingNode(node) && (cleanText(node.textContent || '') || node.querySelector?.('img,table')));
}

function paginateDocument(blocks, layout, tocHints = []) {
  const probe = document.createElement('article');
  probe.className = 'book-page pagination-probe';
  probe.style.width = `${layout.width}px`;
  probe.style.height = `${layout.height}px`;
  const content = document.createElement('div');
  content.className = 'book-content';
  probe.append(content);
  document.body.append(probe);

  const result = [];
  const topics = [];
  const contentsIndex = blocks.findIndex(block => isContentsHeading(cleanText(block.textContent)));
  const bodyStartIndex = contentsIndex < 0 ? 0 : findBodyStartIndex(blocks, contentsIndex);
  const hintsByTitle = new Map(tocHints.map(hint => [cleanText(hint.title), hint]));
  let current = [];
  const flush = () => {
    if (!current.length) return;
    result.push({ type: 'html', html: current.map(node => node.outerHTML).join('') });
    current = [];
    content.replaceChildren();
  };
  const fits = () => content.scrollHeight <= content.clientHeight + 1;

  const queue = [];
  blocks.forEach((source, index) => {
    const candidate = index >= bodyStartIndex ? getTopic(source, hintsByTitle, contentsIndex < 0 || index >= bodyStartIndex) : null;
    queue.push({ node: source, topic: candidate });
  });

  while (queue.length) {
    const entry = queue.shift();
    // A chapter heading must stay with the following subheading or text. Without this
    // guard a new topic after a chapter may leave a nearly empty page containing only
    // "4-ТАРАУ" or another heading.
    if (entry.topic && current.length && hasBodyContent(current) && content.scrollHeight > content.clientHeight * 0.62) flush();
    let node = entry.node.cloneNode(true);
    if (entry.topic && !isHeadingNode(node)) {
      const heading = document.createElement(`h${Math.min(Math.max(entry.topic.level || 1, 1), 6)}`);
      heading.className = 'inferred-heading';
      heading.innerHTML = node.innerHTML;
      node = heading;
    }
    content.append(node);
    if (!fits() && current.length) {
      content.removeChild(node);
      flush();
      queue.unshift(entry);
      continue;
    }
    if (!fits()) {
      content.removeChild(node);
      const fragments = splitOversizedBlock(entry.node);
      if (fragments.length > 1) {
        queue.unshift(...fragments.map((fragment, index) => ({ node: fragment, topic: index === 0 ? entry.topic : null })));
        continue;
      }
      node.classList.add('fit-reduction');
      content.append(node);
      if (!fits()) {
        content.removeChild(node);
        const emergencyFragments = splitOversizedBlock(entry.node, true);
        if (emergencyFragments.length > 1) {
          queue.unshift(...emergencyFragments.map((fragment, index) => ({ node: fragment, topic: index === 0 ? entry.topic : null })));
          continue;
        }
        node.classList.add('force-fit');
        content.append(node);
        if (!fits()) {
          content.removeChild(node);
          const plainText = cleanText(entry.node.textContent || '');
          if (plainText) {
            const fallback = document.createElement('p');
            fallback.textContent = plainText;
            const textFragments = splitTextBlock(fallback, 120);
            if (textFragments.length > 1) {
              queue.unshift(...textFragments.map((fragment, index) => ({ node: fragment, topic: index === 0 ? entry.topic : null })));
              continue;
            }
          }
          const notice = document.createElement('p');
          notice.className = 'unrenderable-block';
          notice.textContent = 'Этот фрагмент слишком велик для страницы и не может быть показан без обрезания. Разделите исходный документ на части.';
          content.append(notice);
        }
      }
    }
    if (entry.topic) topics.push({ ...entry.topic, page: result.length });
    current.push(node);
  }
  flush();
  probe.remove();
  return { pages: result, toc: topics };
}

function splitOversizedBlock(block, emergency = false) {
  const tag = block.tagName?.toUpperCase();
  if (['P', 'LI', 'H1', 'H2', 'H3', 'H4'].includes(tag)) return splitTextBlock(block, 220);
  if (tag === 'UL' || tag === 'OL') return splitList(block, 1, emergency ? 120 : 220);
  if (tag === 'TABLE') {
    if (block.rows.length > 2) return splitTable(block, 1);
    return tableRowAsParagraphs(block);
  }
  const text = cleanText(block.textContent || '');
  if (text) {
    const paragraph = document.createElement('p');
    paragraph.textContent = text;
    return splitTextBlock(paragraph, 220);
  }
  return [block];
}

function tableRowAsParagraphs(table) {
  const headerRow = table.tHead?.rows[0] || ([...(table.rows[0]?.cells || [])].every(cell => cell.tagName === 'TH') ? table.rows[0] : null);
  const headers = [...(headerRow?.cells || [])].map(cell => cleanText(cell.textContent));
  const output = [];
  [...table.rows].filter(row => row !== headerRow).forEach(row => [...row.cells].forEach((cell, index) => {
    const paragraph = document.createElement('p');
    const label = headers[index] ? `${headers[index]}: ` : '';
    paragraph.textContent = `${label}${cleanText(cell.textContent)}`;
    output.push(...splitTextBlock(paragraph, 220));
  }));
  return output.length ? output : [table];
}

function isContentsHeading(text) {
  return /^(мазмұны|содержание|оглавление|contents?)$/i.test(text);
}

function findBodyStartIndex(blocks, contentsIndex) {
  for (let index = contentsIndex + 1; index < blocks.length; index++) {
    const node = blocks[index];
    const text = cleanText(node.textContent);
    const tag = node.tagName?.toLowerCase();
    // Word contents are often styled as H2/H3. After a contents page, only a true document
    // start (introduction, chapter, or the next H1) may establish the start of navigation.
    if (tag === 'h1' || /^(кіріспе|введение|introduction)$/i.test(text) || /^\d+\s*[-–]?\s*(тарау|глава|бөлім|chapter)\b/i.test(text)) return index;
  }
  return Number.POSITIVE_INFINITY;
}

function isBibliographicCitation(text) {
  // Do not use \b around Cyrillic words: JavaScript defines it only for ASCII \w.
  const hasSourceMarker = /(?:конспект(?:\s+лекций)?|университет(?:і)?|издательств\w*|isbn|reference\s+book)/i.test(text);
  const hasPublicationDetail = /(?:19|20)\d{2}\s*(?:г\.?|год(?:а)?)?/i.test(text) || /(?:тула|алматы|москва|астана)/i.test(text);
  return hasSourceMarker && hasPublicationDetail;
}

function getTopic(node, hintsByTitle = new Map(), allowInferred = true) {
  const text = cleanText(node.textContent);
  if (!text || isContentsHeading(text)) return null;
  if (isBibliographicCitation(text)) return null;
  const tag = node.tagName.toLowerCase();
  if (/^h[1-4]$/.test(tag)) return { title: text, level: Number(tag[1]) };
  if (/^h[5-6]$/.test(tag)) return { title: text, level: Number(tag[1]) };
  const hinted = hintsByTitle.get(text);
  if (hinted) return { title: text, level: hinted.level || 1 };
  if (!allowInferred) return null;
  const boldText = [...node.querySelectorAll('strong,b')].map(item => cleanText(item.textContent)).join('');
  const mostlyBold = node.tagName === 'P' && boldText.length >= text.replace(/\s/g, '').length * 0.88;
  const numbered = /^(\d+)\s*\.\s*(\d+)(?:\s*\.\s*(\d+))?\.?\s+/.exec(text);
  const chapter = /^\d+\s*[-–]?\s*(тарау|глава|бөлім|chapter)\b/i.test(text);
  const lesson = /^(?:лекция|дәріс|lesson|тема|тақырып|модуль|module|раздел|бөлім)\s*(?:№|n[oº.]?\s*)?\d+\b/i.test(text);
  const letters = (text.match(/[A-Za-zА-ЯӘІҢҒҮҰҚӨҺа-яәіңғүұқөһ]/g) || []).length;
  const capitals = (text.match(/[A-ZА-ЯӘІҢҒҮҰҚӨҺ]/g) || []).length;
  const upperCaseTitle = letters > 4 && capitals / letters > 0.62;
  if (text.length <= 230 && ((mostlyBold && (numbered || chapter || upperCaseTitle || lesson)) || lesson)) {
    const level = chapter || upperCaseTitle || lesson ? 1 : (numbered[3] ? 3 : 2);
    return { title: text, level };
  }
  return null;
}

async function loadPdf(file) {
  const pdf = await pdfjsLib.getDocument({ url: file.pdfUrl, isEvalSupported: false, enableXfa: false }).promise;
  try {
    if (pdf.numPages > 1200) throw new Error('PDF содержит больше 1200 страниц. Разделите материал на части.');
    const nextPages = Array.from({ length: pdf.numPages }, (_, index) => ({ type: 'pdf', pdf, pageNumber: index + 1 }));
    const nextToc = [];
    const outline = await pdf.getOutline();
    if (outline?.length) {
      const flatten = async (items, level = 1) => {
        for (const item of items) {
          let page = null;
          try { const destination = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest; page = destination?.[0] ? await pdf.getPageIndex(destination[0]) : null; } catch (_) { /* Skip a broken bookmark instead of linking it to page one. */ }
          if (Number.isInteger(page) && page >= 0 && page < pdf.numPages) nextToc.push({ title: item.title || 'Раздел', level, page });
          if (item.items?.length) await flatten(item.items, level + 1);
        }
      };
      await flatten(outline);
    }
    if (!nextToc.length) nextToc.push(...await detectPdfToc(pdf));
    const nextImportNotices = [];
    if (!nextToc.length) {
      nextToc.push({ title: 'Начало документа', level: 1, page: 0 });
      nextImportNotices.push('В PDF нет встроенного оглавления. Для перехода используйте поле «Стр.» внизу книги.');
    }
    return { pages: nextPages, toc: nextToc, sourceBlocks: [], documentLayout: getPageLayout(), documentTocHints: [], importNotices: nextImportNotices, pdf };
  } catch (error) {
    await disposePdf(pdf);
    throw error;
  }
}

async function detectPdfToc(pdf) {
  const topics = [];
  let pageLabels = null;
  try { pageLabels = await pdf.getPageLabels?.(); } catch (_) { /* PDF may not define labels */ }
  if (!pageLabels?.length) return topics;
  for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, 40); pageNumber++) {
    const pdfPage = await pdf.getPage(pageNumber);
    const textContent = await pdfPage.getTextContent();
    const lines = pdfTextLines(textContent.items);
    const isContentsPage = lines.some(line => /^(мазмұны|содержание|оглавление|contents?)$/i.test(cleanText(line)));
    if (!isContentsPage) continue;
    for (const line of lines) {
      const match = /^(.*?)\s*(?:[.·•…\s]{3,})\s*(\d{1,4})\s*$/.exec(cleanText(line));
      if (!match) continue;
      const title = cleanText(match[1].replace(/[.·•…\s]+$/g, ''));
      const printedNumber = Number(match[2]);
      const target = pageLabels.findIndex(label => cleanText(label) === String(printedNumber));
      if (title.length < 4 || target < 0 || target >= pdf.numPages) continue;
      topics.push({ title, level: 1, page: target });
    }
  }
  return topics.filter((topic, index, array) => index === 0 || topic.title !== array[index - 1].title);
}

function pdfTextLines(items) {
  const grouped = new Map();
  items.filter(item => item.str?.trim()).forEach(item => {
    const y = Math.round((item.transform?.[5] || 0) * 2) / 2;
    const row = grouped.get(y) || [];
    row.push({ x: item.transform?.[4] || 0, text: item.str });
    grouped.set(y, row);
  });
  return [...grouped.entries()].sort((a, b) => b[0] - a[0]).map(([, row]) => row.sort((a, b) => a.x - b.x).map(part => part.text).join(' '));
}

function renderToc() {
  const nav = $('#toc'); nav.innerHTML = '';
  toc.forEach((item, index) => {
    const button = document.createElement('button');
    button.className = `toc-item l${Math.min(item.level, 6)}`; button.textContent = item.title; button.dataset.page = String(item.page + 1);
    button.onclick = () => { pageFlip?.flip(item.page, 'top'); setActiveTopic(index); if (innerWidth < 800) setTocPanelVisibility(false, { moveFocus: true }); };
    nav.append(button);
  });
  setActiveTopic(-1);
  filterToc();
}

function renderImportNotice() {
  const notice = $('#importNotice');
  const messages = [...new Set(importNotices)].slice(0, 2);
  notice.hidden = !messages.length;
  notice.textContent = messages.length ? messages.join(' ') : '';
}

function filterToc() {
  const query = $('#tocSearch').value.trim().toLocaleLowerCase();
  document.querySelectorAll('.toc-item').forEach(button => {
    button.hidden = Boolean(query) && !button.textContent.toLocaleLowerCase().includes(query);
  });
}

function goToPage() {
  const page = Number($('#pageJump').value);
  if (!pageFlip || !Number.isInteger(page) || page < 1 || page > pages.length) return;
  pageFlip.flip(page - 1, 'top');
}

function createBook({ preservePage = false } = {}) {
  const currentPage = preservePage ? pageFlip?.getCurrentPageIndex?.() || 0 : 0;
  const oldBook = $('#book'); const bookStage = oldBook.parentElement; const book = document.createElement('div'); book.id = 'book';
  if (pageFlip) {
    try { pageFlip.destroy(); } catch (error) { console.warn('Не удалось корректно закрыть предыдущую книгу:', error); }
  }
  if (oldBook.isConnected) oldBook.replaceWith(book);
  else bookStage.append(book);
  pageFlip = null;
  const leaves = pages.map((data, index) => {
    const leaf = document.createElement('article'); leaf.className = 'book-page'; leaf.dataset.num = index + 1;
    leaf.innerHTML = data.type === 'html' ? `<div class="book-content">${data.html}</div><span class="page-number" aria-hidden="true">${index + 1}</span>` : `<div class="book-content"><div class="pdf-wait">Подготавливаем страницу…</div></div><span class="page-number" aria-hidden="true">${index + 1}</span>`;
    return leaf;
  });
  leaves.forEach(leaf => book.append(leaf));
  const layout = documentLayout || getPageLayout();
  pageFlip = new PageFlip(book, {
    width: layout.width, height: layout.height, size: 'fixed', minWidth: 280, maxWidth: 600, minHeight: 410, maxHeight: 720,
    drawShadow: true, maxShadowOpacity: 0.55, flippingTime: 780, usePortrait: true, showCover: false,
    mobileScrollSupport: true, swipeDistance: 25, startZIndex: 5, disableFlipByClick: false
  });
  pageFlip.loadFromHTML(leaves);
  renderedPdfPages.clear();
  pageFlip.on('flip', event => { updateReaderState(event.data); ensurePdfPagesAround(event.data, leaves); });
  const target = Math.min(currentPage, Math.max(0, pages.length - 1));
  if (target) pageFlip.turnToPage(target);
  updateReaderState(target);
  ensurePdfPagesAround(target, leaves);
}

function ensurePdfPagesAround(pageIndex, leaves) {
  for (let index = Math.max(0, pageIndex - 2); index <= Math.min(pages.length - 1, pageIndex + 3); index++) {
    if (pages[index].type === 'pdf' && !renderedPdfPages.has(index)) {
      renderedPdfPages.add(index);
      renderPdfPage(pages[index], leaves[index]);
    }
  }
}

async function renderPdfPage(data, leaf) {
  try {
    const pdfPage = await data.pdf.getPage(data.pageNumber); const viewport = pdfPage.getViewport({ scale: 1.65 });
    const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
    const content = leaf.querySelector('.book-content');
    content.replaceChildren(canvas);
    await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  } catch (error) {
    console.error('PDF page rendering error:', error);
    const content = leaf.querySelector('.book-content');
    content.replaceChildren();
    const message = document.createElement('div');
    message.className = 'pdf-wait';
    message.textContent = `Не удалось отрисовать страницу: ${error.message || 'неизвестная ошибка'}`;
    content.append(message);
  }
}

function updateReaderState(page) {
  const current = Number(page) || 0, count = pages.length;
  $('#pageCounter').textContent = `${Math.min(current + 1, count)} / ${count}`;
  $('#pageJump').max = String(count); $('#pageJump').value = String(Math.min(current + 1, count));
  $('#prev').disabled = current <= 0; $('#next').disabled = current >= count - 1;
  let topicIndex = -1; toc.forEach((topic, index) => { if (topic.page <= current) topicIndex = index; }); setActiveTopic(topicIndex);
}
function setActiveTopic(index) { document.querySelectorAll('.toc-item').forEach((button, i) => button.classList.toggle('active', i === index)); }
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#tocPanel').hidden && innerWidth < 800) {
    setTocPanelVisibility(false, { moveFocus: true });
    return;
  }
  if ($('#reader').hidden || !pageFlip || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
  if (event.key === 'ArrowRight') { event.preventDefault(); pageFlip.flipNext('bottom'); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); pageFlip.flipPrev('bottom'); }
});
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (importing || (!sourceBlocks.length && !activePdf) || $('#reader').hidden) return;
    const nextLayout = getPageLayout();
    if (Math.abs(nextLayout.width - documentLayout.width) < 12 && Math.abs(nextLayout.height - documentLayout.height) < 12) return;
    documentLayout = nextLayout;
    if (sourceBlocks.length) {
      ({ pages, toc } = paginateDocument(sourceBlocks, documentLayout, documentTocHints));
      toc = toc.filter(item => item.page < pages.length);
      if (!toc.length) toc = [{ title: 'Начало документа', level: 1, page: 0 }];
    }
    renderToc();
    createBook({ preservePage: true });
  }, 220);
});

window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  void releaseImport(currentImportId);
  void disposePdf(activePdf);
});
