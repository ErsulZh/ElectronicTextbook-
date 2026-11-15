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
const supportedExtensions = new Set(['.pdf', '.docx', '.docm', '.dotx', '.dotm', '.doc', '.dot', '.docb', '.odt', '.rtf', '.txt', '.md', '.html', '.htm', '.epub']);
let pages = [], toc = [], pageFlip = null, importing = false, sourceBlocks = [], documentLayout = null;
let importNotices = [], resizeTimer = null;
const renderedPdfPages = new Set();
let sessionToken = null, currentImportId = null;

$('#openFile').onclick = chooseFile;
$('#newFile').onclick = chooseFile;
$('#prev').onclick = () => pageFlip?.flipPrev('bottom');
$('#next').onclick = () => pageFlip?.flipNext('bottom');
$('#tocToggle').onclick = () => { $('#tocPanel').hidden = !$('#tocPanel').hidden; };
$('#closeToc').onclick = () => { $('#tocPanel').hidden = true; };
$('#tocSearch').oninput = filterToc;
$('#goPage').onclick = goToPage;
$('#pageJump').onkeydown = event => { if (event.key === 'Enter') goToPage(); };
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

async function importFile(selectedFile) {
  if (importing) return;
  const extension = `.${selectedFile.name.split('.').pop()?.toLowerCase() || ''}`;
  if (!supportedExtensions.has(extension)) {
    alert('Поддерживаются PDF, Word (DOC/DOCX/DOCM), ODT, RTF, EPUB, TXT, Markdown и HTML.');
    return;
  }
  importing = true;
  $('#loading').hidden = false;
  $('#openFile').disabled = true;
  $('#newFile').disabled = true;
  try {
    const token = await getSessionToken();
    const response = await fetch(`/api/import?name=${encodeURIComponent(selectedFile.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Textbook-Token': token },
      body: selectedFile
    });
    const imported = await response.json();
    if (!response.ok) throw new Error(imported.error || 'Сервер не смог прочитать файл.');
    const loading = imported.extension === '.pdf' ? loadPdf(imported) : loadDocument(imported);
    await Promise.race([loading, new Promise((_, reject) => setTimeout(() => reject(new Error('Превышено время ожидания. Попробуйте открыть другой файл.')), 90000))]);
    $('#bookName').textContent = imported.name;
    $('#welcome').hidden = true;
    $('#reader').hidden = false;
    renderToc();
    renderImportNotice();
    createBook();
    const previousImportId = currentImportId;
    currentImportId = imported.id;
    if (previousImportId && previousImportId !== currentImportId) void releaseImport(previousImportId);
  } catch (error) {
    alert(`Не удалось открыть файл. Проверьте формат документа.\n\n${error.message}`);
  } finally {
    importing = false;
    $('#loading').hidden = true;
    $('#openFile').disabled = false;
    $('#newFile').disabled = false;
  }
}

async function loadDocument(file) {
  const html = file.html;
  importNotices = file.notices || [];
  const holder = document.createElement('div');
  holder.innerHTML = sanitizeImportedHtml(html);
  sourceBlocks = collectSourceBlocks(holder);
  documentLayout = getPageLayout();
  ({ pages, toc } = paginateDocument(sourceBlocks, documentLayout));
  if (pages.length > 1200) throw new Error('После разбиения получилось больше 1200 страниц. Разделите материал на части.');
  if (!pages.length) pages = [{ type: 'html', html: '<h1>Документ</h1><p>В файле нет отображаемого текста.</p>' }];
  toc = toc.filter(item => item.page < pages.length);
  if (!toc.length) toc = [{ title: 'Начало документа', level: 1, page: 0 }];
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
  if (block.tagName === 'TABLE') return splitTable(block);
  const text = cleanText(block.textContent || '');
  if (!['P', 'LI'].includes(block.tagName) || block.querySelector('img,table') || text.length < 720) return [block];
  return splitTextBlock(block, 420);
}

function splitTextBlock(block, limit = 420) {
  const text = cleanText(block.textContent || '');
  if (!text) return [block];
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (next.length > limit && current) { chunks.push(current); current = word; } else current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((chunk, index) => {
    const part = block.cloneNode(false);
    part.textContent = chunk;
    if (index > 0) part.classList.add('continued-paragraph');
    return part;
  });
}

function splitTable(table, rowsPerPart = 6) {
  const rows = [...table.rows];
  if (rows.length <= rowsPerPart + 1) return [table];
  const header = rows[0];
  const tables = [];
  for (let start = 1; start < rows.length; start += rowsPerPart) {
    const copy = table.cloneNode(false);
    const body = document.createElement('tbody');
    body.append(header.cloneNode(true));
    rows.slice(start, start + rowsPerPart).forEach(row => body.append(row.cloneNode(true)));
    copy.append(body);
    tables.push(copy);
  }
  return tables;
}

function splitList(list) {
  const chunks = [];
  [...list.children].filter(item => item.tagName === 'LI').forEach(item => {
    splitTextBlock(item, 360).forEach(part => {
      const copy = list.cloneNode(false);
      copy.append(part);
      chunks.push(copy);
    });
  });
  return chunks.length ? chunks : [list];
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

function paginateDocument(blocks, layout) {
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
  const documentHasContents = blocks.some(block => /^(мазмұны|содержание|оглавление|contents?)$/i.test(cleanText(block.textContent)));
  let hasContents = false;
  let bodyStarted = !documentHasContents;
  let current = [];
  const flush = () => {
    if (!current.length) return;
    result.push({ type: 'html', html: current.map(node => node.outerHTML).join('') });
    current = [];
    content.replaceChildren();
  };
  const fits = () => content.scrollHeight <= content.clientHeight + 1;

  const queue = [];
  for (const source of blocks) {
    const text = cleanText(source.textContent);
    if (/^(мазмұны|содержание|оглавление|contents?)$/i.test(text)) hasContents = true;
    const candidate = getTopic(source);
    if (hasContents && candidate && isBodyStart(text, candidate)) bodyStarted = true;
    queue.push({ node: source, topic: bodyStarted ? candidate : null });
  }

  while (queue.length) {
    const entry = queue.shift();
    if (entry.topic && current.length) flush();
    const node = entry.node.cloneNode(true);
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
    }
    if (entry.topic) topics.push({ ...entry.topic, page: result.length });
    current.push(node);
  }
  flush();
  probe.remove();
  return { pages: result, toc: topics };
}

function splitOversizedBlock(block) {
  const tag = block.tagName?.toUpperCase();
  if (['P', 'LI', 'H1', 'H2', 'H3', 'H4'].includes(tag)) return splitTextBlock(block, 220);
  if (tag === 'UL' || tag === 'OL') return splitList(block);
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
  const headers = [...(table.rows[0]?.cells || [])].map(cell => cleanText(cell.textContent));
  const output = [];
  [...table.rows].slice(1).forEach(row => [...row.cells].forEach((cell, index) => {
    const paragraph = document.createElement('p');
    const label = headers[index] ? `${headers[index]}: ` : '';
    paragraph.textContent = `${label}${cleanText(cell.textContent)}`;
    output.push(...splitTextBlock(paragraph, 220));
  }));
  return output.length ? output : [table];
}

function isBodyStart(text, topic) {
  return /^(кіріспе|введение|introduction)$/i.test(text)
    || /^\d+\s*[-–]?\s*(тарау|глава|бөлім|chapter)\b/i.test(text)
    || topic.level > 1;
}

function getTopic(node) {
  const text = cleanText(node.textContent);
  if (!text || /^((содержание)|(оглавление)|(contents?))$/i.test(text)) return null;
  const tag = node.tagName.toLowerCase();
  if (/^h[1-4]$/.test(tag)) return { title: text, level: Number(tag[1]) };
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
  sourceBlocks = [];
  documentLayout = null;
  importNotices = [];
  const pdf = await pdfjsLib.getDocument({ url: file.pdfUrl, isEvalSupported: false, enableXfa: false }).promise;
  if (pdf.numPages > 1200) throw new Error('PDF содержит больше 1200 страниц. Разделите материал на части.');
  pages = Array.from({ length: pdf.numPages }, (_, index) => ({ type: 'pdf', pdf, pageNumber: index + 1 }));
  toc = [];
  const outline = await pdf.getOutline();
  if (outline?.length) {
    const flatten = async (items, level = 1) => {
      for (const item of items) {
        let page = 0;
        try { const destination = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest; page = destination?.[0] ? await pdf.getPageIndex(destination[0]) : 0; } catch (_) { /* fallback */ }
        toc.push({ title: item.title || 'Раздел', level, page });
        if (item.items?.length) await flatten(item.items, level + 1);
      }
    };
    await flatten(outline);
  }
  if (!toc.length) toc = await detectPdfToc(pdf);
  if (!toc.length) {
    toc = [{ title: 'Начало документа', level: 1, page: 0 }];
    importNotices = ['В PDF нет встроенного оглавления. Для перехода используйте поле «Стр.» внизу книги.'];
  }
}

async function detectPdfToc(pdf) {
  const topics = [];
  for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, 12); pageNumber++) {
    const pdfPage = await pdf.getPage(pageNumber);
    const textContent = await pdfPage.getTextContent();
    const lines = pdfTextLines(textContent.items);
    const isContentsPage = lines.some(line => /^(мазмұны|содержание|оглавление|contents?)$/i.test(cleanText(line)));
    if (!isContentsPage) continue;
    for (const line of lines) {
      const match = /^(.*?)\s*(?:[.·•…\s]{3,})\s*(\d{1,4})\s*$/.exec(cleanText(line));
      if (!match) continue;
      const title = cleanText(match[1].replace(/[.·•…\s]+$/g, ''));
      const target = Number(match[2]) - 1;
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
    button.className = `toc-item l${Math.min(item.level, 2)}`; button.textContent = item.title;
    button.onclick = () => { pageFlip?.flip(item.page, 'top'); setActiveTopic(index); if (innerWidth < 800) $('#tocPanel').hidden = true; };
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

function createBook() {
  const currentPage = pageFlip?.getCurrentPageIndex?.() || 0;
  const oldBook = $('#book'); const book = document.createElement('div'); book.id = 'book'; oldBook.replaceWith(book);
  pageFlip = null;
  const leaves = pages.map((data, index) => {
    const leaf = document.createElement('article'); leaf.className = 'book-page'; leaf.dataset.num = index + 1;
    leaf.innerHTML = data.type === 'html' ? `<div class="book-content">${data.html}</div><span class="page-number" aria-hidden="true">${index + 1}</span>` : `<div class="book-content"><div class="pdf-wait">Подготавливаем страницу…</div></div><span class="page-number" aria-hidden="true">${index + 1}</span>`;
    return leaf;
  });
  leaves.forEach(leaf => book.append(leaf));
  const layout = documentLayout || getPageLayout();
  pageFlip = new PageFlip(book, {
    width: layout.width, height: layout.height, size: 'stretch', minWidth: 280, maxWidth: 600, minHeight: 410, maxHeight: 720,
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
  if ($('#reader').hidden || !pageFlip || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) return;
  if (event.key === 'ArrowRight') { event.preventDefault(); pageFlip.flipNext('bottom'); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); pageFlip.flipPrev('bottom'); }
});
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (importing || !sourceBlocks.length || $('#reader').hidden) return;
    const nextLayout = getPageLayout();
    if (Math.abs(nextLayout.width - documentLayout.width) < 12 && Math.abs(nextLayout.height - documentLayout.height) < 12) return;
    const oldPage = pageFlip?.getCurrentPageIndex?.() || 0;
    documentLayout = nextLayout;
    ({ pages, toc } = paginateDocument(sourceBlocks, documentLayout));
    toc = toc.filter(item => item.page < pages.length);
    if (!toc.length) toc = [{ title: 'Начало документа', level: 1, page: 0 }];
    renderToc();
    createBook();
    if (oldPage && pageFlip) pageFlip.turnToPage(Math.min(oldPage, pages.length - 1));
  }, 220);
});
