'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Transform, pipeline } = require('stream');
const { execFile } = require('child_process');
const { promisify, TextDecoder } = require('util');
const ROOT = __dirname;
const WIN7_RUNTIME = process.env.TEXTBOOK_WIN7_RUNTIME === '1';
const NODE_MODULES_ROOT = WIN7_RUNTIME ? path.join(ROOT, 'win7-runtime', 'node_modules') : path.join(ROOT, 'node_modules');
const mammoth = require(path.join(NODE_MODULES_ROOT, 'mammoth'));
const JSZip = require(path.join(NODE_MODULES_ROOT, 'jszip'));
const { DOMParser } = require(path.join(NODE_MODULES_ROOT, '@xmldom', 'xmldom'));
const MarkdownIt = require(path.join(NODE_MODULES_ROOT, 'markdown-it'));

const execFileAsync = promisify(execFile);
const pipelineAsync = promisify(pipeline);
const fsp = fs.promises;
const PORT = process.env.PORT ? Number(process.env.PORT) : 4173;
const MAX_FILE_SIZE = 250 * 1024 * 1024;
const MAX_TOTAL_STORED_BYTES = 750 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 10;
const MAX_CONCURRENT_IMPORTS = 2;
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const UPLOAD_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const FORMAT_SUPPORT = require('./src/format-support.json').formats;
const FORMAT_BY_EXTENSION = new Map(FORMAT_SUPPORT.flatMap(format => format.extensions.map(extension => [extension, format])));
const SUPPORTED_EXTENSIONS = new Set(FORMAT_BY_EXTENSION.keys());
const WORD_LAYOUT_EXTENSIONS = new Set(['.docx', '.docm', '.dotx', '.doc', '.dot', '.dotm', '.docb', '.rtf']);
const uploads = new Map();
const SESSION_TOKEN = toBase64Url(crypto.randomBytes(32));
let activeImports = 0;
let wordAvailable;
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: true, breaks: false });

const docxStyleMap = [
  "p[style-name='Heading 1'] => h1:fresh", "p[style-name='Заголовок 1'] => h1:fresh", "p[style-name='Тақырып 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh", "p[style-name='Заголовок 2'] => h2:fresh", "p[style-name='Тақырып 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh", "p[style-name='Заголовок 3'] => h3:fresh", "p[style-name='Тақырып 3'] => h3:fresh",
  "p[style-name='Title'] => h1.title:fresh", "p[style-name='Название'] => h1.title:fresh"
];

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2'
};

function securityHeaders() {
  return {
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store'
  };
}

function toBase64Url(value) {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function sendJson(response, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  response.writeHead(status, { ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function streamFile(request, response, filePath, allowRange = false) {
  const stat = await fsp.stat(filePath);
  const headers = { ...securityHeaders(), 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' };
  if (allowRange && request.headers.range) {
    const match = /bytes=(\d+)-(\d*)/.exec(request.headers.range);
    if (!match) return sendError(response, 416, 'Некорректный диапазон файла.');
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) return sendError(response, 416, 'Диапазон находится за пределами файла.');
    response.writeHead(206, { ...headers, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(filePath, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': stat.size, ...(allowRange ? { 'Accept-Ranges': 'bytes' } : {}) });
  fs.createReadStream(filePath).pipe(response);
}

async function saveUpload(request, target) {
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (declaredLength > MAX_FILE_SIZE) throw new Error('Файл больше 250 МБ.');
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_FILE_SIZE) callback(new Error('Файл больше 250 МБ.'));
      else callback(null, chunk);
    }
  });
  await pipelineAsync(request, limiter, fs.createWriteStream(target, { flags: 'wx' }));
  if (!received) throw new Error('Выбран пустой файл.');
  return received;
}

function isTrustedApiRequest(request) {
  const origin = request.headers.origin;
  const address = server && typeof server.address === 'function' ? server.address() : null;
  const activePort = address && address.port ? address.port : PORT;
  const expectedOrigin = `http://127.0.0.1:${activePort}`;
  return (!origin || origin === expectedOrigin) && request.headers['x-textbook-token'] === SESSION_TOKEN;
}

function currentStoredBytes() {
  return [...uploads.values()].reduce((total, record) => total + record.size, 0);
}

function getUpload(id) {
  const record = uploads.get(id);
  if (record) record.lastAccessAt = Date.now();
  return record;
}

async function cleanupUpload(id) {
  const record = uploads.get(id);
  if (!record) return false;
  uploads.delete(id);
  await removeDirectory(record.workDir).catch(() => {});
  return true;
}

async function removeDirectory(directory) {
  if (typeof fsp.rm === 'function') return fsp.rm(directory, { recursive: true, force: true });
  return fsp.rmdir(directory, { recursive: true });
}

async function sweepExpiredUploads() {
  const expired = [...uploads.values()]
    .filter(record => Date.now() - record.lastAccessAt > UPLOAD_TTL_MS)
    .map(record => cleanupUpload(record.id));
  await Promise.all(expired);
}

async function verifyFileSignature(filePath, extension) {
  const handle = await fsp.open(filePath, 'r');
  const header = Buffer.alloc(16);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  const hasPrefix = value => header.subarray(0, value.length).equals(value);
  const isZip = hasPrefix(Buffer.from('PK\x03\x04')) || hasPrefix(Buffer.from('PK\x05\x06'));
  const isCompoundDocument = hasPrefix(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]));
  const isRtf = header.toString('ascii').replace(/^\uFEFF/, '').startsWith('{\\rtf');
  if (extension === '.pdf' && !hasPrefix(Buffer.from('%PDF-'))) throw new Error('Расширение PDF не соответствует содержимому файла.');
  if (['.docx', '.docm', '.dotx', '.dotm', '.odt', '.epub'].includes(extension) && !isZip) throw new Error('Расширение Office/EPUB не соответствует содержимому файла.');
  if (['.doc', '.dot', '.docb'].includes(extension) && !isCompoundDocument) throw new Error('Расширение старого Word не соответствует содержимому файла.');
  if (extension === '.rtf' && !isRtf) throw new Error('Расширение RTF не соответствует содержимому файла.');
}

function validateArchive(zip, label) {
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error(`${label} содержит слишком много файлов.`);
  const declaredSize = entries.reduce((size, entry) => size + Number((entry._data && entry._data.uncompressedSize) || 0), 0);
  if (declaredSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error(`${label} слишком велик после распаковки.`);
}

async function handleImport(request, response, url) {
  if (!isTrustedApiRequest(request)) return sendError(response, 403, 'Запрос отклонён: откройте файл через сайт учебника.');
  if (activeImports >= MAX_CONCURRENT_IMPORTS) return sendError(response, 429, 'Сейчас уже обрабатываются другие файлы. Повторите попытку через несколько секунд.');
  if (uploads.size >= MAX_ACTIVE_UPLOADS) return sendError(response, 429, 'Открыто слишком много книг. Закройте или замените текущую книгу.');
  const requestedName = url.searchParams.get('name') || '';
  const name = path.basename(requestedName);
  const extension = path.extname(name).toLowerCase();
  if (!name || name !== requestedName || !SUPPORTED_EXTENSIONS.has(extension)) return sendError(response, 400, 'Выберите поддерживаемый документ.');
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (declaredLength + currentStoredBytes() > MAX_TOTAL_STORED_BYTES) return sendError(response, 507, 'Недостаточно места для ещё одной открытой книги.');
  activeImports += 1;
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  let workDir = null;
  try {
    workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'electronic-textbook-web-'));
    const inputPath = path.join(workDir, `source${extension}`);
    const size = await saveUpload(request, inputPath);
    if (size + currentStoredBytes() > MAX_TOTAL_STORED_BYTES) throw new Error('Недостаточно места для ещё одной открытой книги.');
    await verifyFileSignature(inputPath, extension);
    const assetUrl = relativePath => `/api/asset/${id}/${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
    const record = { id, name, extension, size, workDir, inputPath, renderedPdfPath: null, createdAt: Date.now(), lastAccessAt: Date.now() };
    uploads.set(id, record);
    const context = { workDir, assetUrl, name, extension, formatInfo: FORMAT_BY_EXTENSION.get(extension) };
    if (extension === '.pdf') return sendJson(response, 200, { id, name, extension, size, pdfUrl: `/api/file/${id}`, document: createPdfDocumentModel(name) });
    const exactWordLayout = WORD_LAYOUT_EXTENSIONS.has(extension) && await isMicrosoftWordAvailable();
    let parsed = await parseDocument(inputPath, extension, context, { preferOriginalLayout: exactWordLayout });
    if (exactWordLayout) {
      try {
        record.renderedPdfPath = await convertWordToPdf(inputPath, workDir);
        return sendJson(response, 200, {
          id, name, extension, size, ...parsed,
          pdfUrl: `/api/rendered/${id}`,
          renderMode: 'original-layout'
        });
      } catch (_) {
        // The HTML renderer remains a usable fallback if a specific Word document cannot be exported to PDF.
        parsed = await parseDocument(inputPath, extension, context);
        parsed.notices.push('Не удалось сохранить точную разметку Word; открыт адаптированный текстовый вид.');
        parsed.document.notices.push('Не удалось сохранить точную разметку Word; открыт адаптированный текстовый вид.');
      }
    }
    sendJson(response, 200, { id, name, extension, size, ...parsed });
  } catch (error) {
    await cleanupUpload(id);
    if (workDir) await removeDirectory(workDir).catch(() => {});
    sendError(response, 422, error.message || 'Не удалось обработать файл.');
  } finally {
    activeImports -= 1;
  }
}

async function parseDocument(filePath, extension, context, options = {}) {
  if (['.docx', '.docm', '.dotx'].includes(extension)) return parseDocx(filePath, context, options);
  if (['.doc', '.dot', '.dotm', '.docb', '.rtf'].includes(extension)) {
    await assertMicrosoftWordAvailable();
    return parseDocx(await convertLegacyWordToDocx(filePath, context.workDir), context, options);
  }
  if (extension === '.odt') return parsedDocument(await parseOdt(filePath), 'odt', ['ODT импортируется в ограниченном режиме: сохранены заголовки и абзацы.'], context);
  if (extension === '.txt') {
    const decoded = await readTextFile(filePath);
    return parsedDocument(textToHtml(decoded.text), 'text', decoded.notice ? [decoded.notice] : [], context);
  }
  if (extension === '.md') {
    const decoded = await readTextFile(filePath);
    return parsedDocument(markdown.render(decoded.text), 'markdown', decoded.notice ? [decoded.notice] : [], context);
  }
  if (extension === '.html' || extension === '.htm') return parsedDocument(await readHtmlFile(filePath), 'html', ['HTML открыт в безопасном режиме: скрипты, стили и внешние ресурсы отключены.'], context);
  if (extension === '.epub') return parsedDocument(await parseEpub(filePath), 'epub', ['EPUB импортируется в ограниченном режиме: сохранены порядок глав и текст.'], context);
  throw new Error('Этот формат пока не поддерживается.');
}

function removeExternalUrls(html) {
  return html.replace(/\s(?:src|srcset|href)\s*=\s*(["'])(.*?)\1/gi, (match, _quote, value) => {
    if (value.startsWith('/api/asset/') || value.startsWith('#')) return match;
    return '';
  });
}

function sanitizeDocumentHtml(html) {
  const withoutActiveElements = html
    .replace(/<(script|style|iframe|object|embed|form|link|meta|xml)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(link|meta|base)\b[^>]*\/?\s*>/gi, '');
  const withoutDangerousAttributes = withoutActiveElements
    .replace(/\sstyle\s*=\s*(["']).*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  return removeExternalUrls(withoutDangerousAttributes);
}

function parsedDocument(html, format, notices = [], context = {}) {
  const safeHtml = sanitizeDocumentHtml(html);
  return {
    format,
    notices: notices.filter(Boolean),
    document: createDocumentModel(safeHtml, { ...context, format, notices })
  };
}

function createPdfDocumentModel(name) {
  return {
    version: 1,
    title: path.basename(name, path.extname(name)),
    format: 'pdf',
    blocks: [],
    assets: [],
    tocHints: [],
    notices: [],
    capabilities: FORMAT_BY_EXTENSION.get('.pdf')
  };
}

function createDocumentModel(html, context) {
  const blocks = [];
  const blockPattern = /<(h[1-6]|p|ul|ol|table|pre|blockquote)\b[^>]*>[\s\S]*?<\/\1\s*>|<img\b[^>]*>/gi;
  let match;
  while ((match = blockPattern.exec(html))) {
    const fragment = match[0];
    const tagMatch = /<([a-z0-9]+)/i.exec(fragment);
    const tag = ((tagMatch && tagMatch[1]) || 'p').toLowerCase();
    const text = cleanMarkupText(fragment);
    const type = /^h[1-6]$/.test(tag) ? 'heading'
      : tag === 'ul' || tag === 'ol' ? 'list'
        : tag === 'table' ? 'table'
          : tag === 'img' ? 'image'
            : tag === 'pre' ? 'code'
              : 'paragraph';
    if (text || type === 'image') blocks.push({ type, level: type === 'heading' ? Number(tag[1]) : undefined, text, html: fragment });
  }
  if (!blocks.length && cleanMarkupText(html)) blocks.push({ type: 'paragraph', text: cleanMarkupText(html), html: `<p>${escapeHtml(cleanMarkupText(html))}</p>` });
  const firstHeading = blocks.find(block => block.type === 'heading');
  const title = (firstHeading && firstHeading.text) || path.basename(context.name || 'Документ', path.extname(context.name || ''));
  return {
    version: 1,
    title,
    format: context.format,
    blocks,
    assets: [...new Set([...html.matchAll(/\/api\/asset\/[^"'\s>]+/g)].map(match => match[0]))],
    tocHints: blocks.filter(block => block.type === 'heading').map(block => ({ title: block.text, level: block.level })),
    notices: (context.notices || []).filter(Boolean),
    capabilities: context.formatInfo || null
  };
}

function cleanMarkupText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}

async function parseDocx(filePath, context, { preferOriginalLayout = false } = {}) {
  const assetDir = path.join(context.workDir, 'assets');
  await fsp.mkdir(assetDir, { recursive: true });
  let imageNumber = 0;
  const conversionNotices = [];
  const result = await mammoth.convertToHtml({ path: filePath }, {
    styleMap: docxStyleMap,
    convertImage: mammoth.images.imgElement(async image => {
      if (imageNumber >= 1000) throw new Error('В документе больше 1000 изображений.');
      const extension = { 'image/png': 'png', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[image.contentType];
      if (!extension) conversionNotices.push(`Изображение формата ${image.contentType} требует дополнительного преобразования.`);
      const fileName = `image-${++imageNumber}.${extension || 'bin'}`;
      await fsp.writeFile(path.join(assetDir, fileName), Buffer.from(await image.read('base64'), 'base64'));
      return { src: context.assetUrl(path.join('assets', fileName)) };
    })
  });
  const mammothNotices = result.messages.map(message => message.message);
  const needsWordHtml = conversionNotices.length || mammothNotices.some(message => /oMath|image\/x-(wmf|emf)|OLEObject/i.test(message));
  if (needsWordHtml && !preferOriginalLayout) {
    try {
      const wordHtml = await convertWordToHtml(filePath, context);
      return parsedDocument(wordHtml, 'word-html', ['Для сохранения формул и старых рисунков использовано преобразование Microsoft Word.'], context);
    } catch (_) {
      return parsedDocument(result.value, 'docx', [...conversionNotices, ...mammothNotices, 'Часть объектов может не отображаться без Microsoft Word.'], context);
    }
  }
  return parsedDocument(result.value, 'docx', conversionNotices, context);
}

async function convertLegacyWordToDocx(inputPath, workDir) {
  const outputPath = path.join(workDir, 'converted.docx');
  await runWordConversion(inputPath, outputPath, 16);
  return outputPath;
}

async function convertWordToHtml(inputPath, context) {
  const htmlDir = path.join(context.workDir, 'word-html');
  await fsp.mkdir(htmlDir, { recursive: true });
  const outputPath = path.join(htmlDir, 'document.html');
  await runWordConversion(inputPath, outputPath, 10);
  const html = await readHtmlFile(outputPath);
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const body = bodyMatch && bodyMatch[1] ? bodyMatch[1] : html;
  return rewriteOfficeAssetUrls(body, htmlDir, context.workDir, context.assetUrl);
}

async function convertWordToPdf(inputPath, workDir) {
  const outputPath = path.join(workDir, 'original-layout.pdf');
  await runWordConversion(inputPath, outputPath, 17);
  return outputPath;
}

async function runWordConversion(inputPath, outputPath, format) {
  const quote = value => value.replace(/'/g, "''");
  const saveCommand = format === 17
    ? `$doc.ExportAsFixedFormat('${quote(outputPath)}',17,$false,0,0,1,1,0,$true,$true,1,$true,$false,$false)`
    : `$doc.SaveAs2('${quote(outputPath)}',${format})`;
  const script = `$ErrorActionPreference='Stop'; $word=$null; $doc=$null; try { $word=New-Object -ComObject Word.Application; $word.Visible=$false; $word.DisplayAlerts=0; $word.AutomationSecurity=3; $doc=$word.Documents.Open('${quote(inputPath)}',$false,$true,$false); ${saveCommand}; } finally { if($doc){$doc.Close(0)}; if($word){$word.Quit()} }`;
  try {
    // Large teaching manuals can take longer than the normal document conversion.
    // Keep a finite limit so the UI can report a real error rather than loading forever.
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: format === 17 ? 180000 : 90000 });
  } catch (_) {
    throw new Error('Не удалось преобразовать этот Word-файл. Установите Microsoft Word или сохраните его как DOCX.');
  }
}

async function isMicrosoftWordAvailable() {
  if (wordAvailable !== undefined) return wordAvailable;
  if (process.env.TEXTBOOK_DISABLE_WORD === '1' || process.platform !== 'win32') return (wordAvailable = false);
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
  const relativePaths = [
    ['Microsoft Office', 'root', 'Office16', 'WINWORD.EXE'],
    ['Microsoft Office', 'Office16', 'WINWORD.EXE'],
    ['Microsoft Office', 'Office15', 'WINWORD.EXE'],
    ['Microsoft Office', 'Office14', 'WINWORD.EXE']
  ];
  for (const root of roots) {
    for (const relativePath of relativePaths) {
      try {
        await fsp.access(path.join(root, ...relativePath));
        return (wordAvailable = true);
      } catch (_) { /* continue searching */ }
    }
  }
  return (wordAvailable = false);
}

async function assertMicrosoftWordAvailable() {
  if (!(await isMicrosoftWordAvailable())) throw new Error('Для DOC, DOT, DOTM, DOCB и RTF нужен установленный Microsoft Word. Сохраните файл как DOCX или PDF либо установите Word.');
}

async function readHtmlFile(filePath) {
  const buffer = await fsp.readFile(filePath);
  const header = buffer.subarray(0, 8192).toString('latin1');
  const charsetMatch = /charset\s*=\s*["']?([^"'\s;>]+)/i.exec(header);
  const declared = charsetMatch && charsetMatch[1] ? charsetMatch[1].toLowerCase() : undefined;
  const encodings = { 'windows-1251': 'windows-1251', cp1251: 'windows-1251', 'windows-1252': 'windows-1252', cp1252: 'windows-1252', utf8: 'utf-8', 'utf-8': 'utf-8', unicode: 'utf-16le', 'utf-16': 'utf-16le', 'utf-16le': 'utf-16le' };
  return decodeTextBuffer(buffer, encodings[declared]).text;
}

async function readTextFile(filePath) {
  return decodeTextBuffer(await fsp.readFile(filePath));
}

function decodeTextBuffer(buffer, declaredEncoding) {
  const bom = buffer.subarray(0, 3);
  if (bom.equals(Buffer.from([0xEF, 0xBB, 0xBF]))) return { text: new TextDecoder('utf-8').decode(buffer.subarray(3)), encoding: 'utf-8' };
  if (buffer.subarray(0, 2).equals(Buffer.from([0xFF, 0xFE]))) return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'utf-16le' };
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  const oddNulls = [...sample].filter((_byte, index) => index % 2 === 1 && sample[index] === 0).length;
  if (sample.length > 6 && oddNulls > sample.length / 6) return { text: new TextDecoder('utf-16le').decode(buffer), encoding: 'utf-16le' };
  if (declaredEncoding) return { text: new TextDecoder(declaredEncoding).decode(buffer), encoding: declaredEncoding };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' };
  } catch (_) {
    return { text: new TextDecoder('windows-1251').decode(buffer), encoding: 'windows-1251', notice: 'Кодировка Windows-1251 определена автоматически.' };
  }
}

function rewriteOfficeAssetUrls(html, sourceDir, workDir, assetUrl) {
  return html.replace(/\bsrc\s*=\s*(["'])(.*?)\1/gi, (_match, quote, value) => {
    if (/^(?:https?:|data:|#)/i.test(value)) return `src=${quote}${value}${quote}`;
    const target = path.resolve(sourceDir, decodeURIComponent(value.replace(/\//g, path.sep)));
    if (!isInside(workDir, target)) return '';
    return `src=${quote}${assetUrl(path.relative(workDir, target))}${quote}`;
  });
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textToHtml(text) {
  return text.replace(/\r/g, '').split(/\n{2,}/).map(paragraph => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('');
}

async function parseOdt(filePath) {
  const zip = await JSZip.loadAsync(await fsp.readFile(filePath));
  validateArchive(zip, 'ODT');
  const contentFile = zip.file('content.xml');
  const content = contentFile ? await contentFile.async('text') : null;
  if (!content) throw new Error('В ODT отсутствует content.xml.');
  const xml = new DOMParser().parseFromString(content, 'text/xml');
  const elements = Array.from(xml.getElementsByTagName('*')).filter(node => node.nodeName === 'text:h' || node.nodeName === 'text:p');
  return elements.map(node => {
    const tag = node.nodeName === 'text:h' ? `h${Math.min(Number(node.getAttribute('text:outline-level')) || 1, 3)}` : 'p';
    return `<${tag}>${escapeHtml(node.textContent || '')}</${tag}>`;
  }).join('');
}

async function parseEpub(filePath) {
  const zip = await JSZip.loadAsync(await fsp.readFile(filePath));
  validateArchive(zip, 'EPUB');
  const containerFile = zip.file('META-INF/container.xml');
  const container = containerFile ? await containerFile.async('text') : null;
  const opfPathMatch = /full-path=["']([^"']+)["']/.exec(container || '');
  const opfPath = opfPathMatch && opfPathMatch[1];
  if (!opfPath) throw new Error('Не удалось прочитать структуру EPUB.');
  const opfFile = zip.file(opfPath);
  const opf = opfFile ? await opfFile.async('text') : null;
  if (!opf) throw new Error('В EPUB отсутствует пакет книги.');
  const manifest = new Map([...opf.matchAll(/<item\b[^>]*id=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*>/g)].map(match => [match[1], match[2]]));
  const root = path.posix.dirname(opfPath);
  const ids = [...opf.matchAll(/<itemref\b[^>]*idref=["']([^"']+)["'][^>]*>/g)].map(match => match[1]);
  const chapters = [];
  for (const [index, id] of ids.slice(0, 600).entries()) {
    const href = manifest.get(id);
    const chapterPath = href && path.posix.normalize(path.posix.join(root, href));
    const chapter = chapterPath && zip.file(chapterPath) ? await zip.file(chapterPath).async('text') : '';
    const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(chapter);
    const body = bodyMatch && bodyMatch[1] ? bodyMatch[1] : '';
    const plain = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(chapter);
    const headingMatch = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(body);
    const documentTitle = titleMatch && titleMatch[1] ? titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const headingTitle = headingMatch && headingMatch[1] ? headingMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const title = documentTitle || headingTitle || `Глава ${index + 1}`;
    if (plain) chapters.push(`<h1>${escapeHtml(title)}</h1>${textToHtml(plain)}`);
  }
  return chapters.join('') || '<p>В EPUB не найден текст.</p>';
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'src/index.html' : pathname.replace(/^\//, '');
  const allowed = relative.startsWith('src/') || relative.startsWith('node_modules/pdfjs-dist/') || relative.startsWith('node_modules/page-flip/');
  if (!allowed) return sendError(response, 404, 'Страница не найдена.');
  const requestedModule = relative.startsWith('node_modules/');
  const staticRoot = requestedModule ? NODE_MODULES_ROOT : ROOT;
  let staticRelative = requestedModule ? relative.slice('node_modules/'.length) : relative;
  // PDF.js legacy build is transpiled for the browser generation still available on Windows 7.
  if (WIN7_RUNTIME && staticRelative.startsWith('pdfjs-dist/build/')) staticRelative = staticRelative.replace(/^pdfjs-dist\/build\//, 'pdfjs-dist/legacy/build/');
  const filePath = path.resolve(staticRoot, staticRelative);
  if (!isInside(staticRoot, filePath)) return sendError(response, 403, 'Доступ запрещён.');
  try { await streamFile(request, response, filePath); } catch (_) { sendError(response, 404, 'Файл не найден.'); }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    if (request.method === 'GET' && url.pathname === '/api/session') return sendJson(response, 200, { token: SESSION_TOKEN });
    if (request.method === 'GET' && url.pathname === '/api/capabilities') return sendJson(response, 200, { formats: FORMAT_SUPPORT, wordConversionAvailable: await isMicrosoftWordAvailable() });
    if (request.method === 'POST' && url.pathname === '/api/import') return handleImport(request, response, url);
    if (request.method === 'DELETE' && /^\/api\/import\/[^/]+$/.test(url.pathname)) {
      if (!isTrustedApiRequest(request)) return sendError(response, 403, 'Запрос отклонён: откройте файл через сайт учебника.');
      const released = await cleanupUpload(url.pathname.split('/').pop());
      return sendJson(response, 200, { released });
    }
    if (request.method === 'GET' && /^\/api\/file\/[^/]+$/.test(url.pathname)) {
      const record = getUpload(url.pathname.split('/').pop());
      if (!record) return sendError(response, 404, 'Файл больше недоступен.');
      return streamFile(request, response, record.inputPath, true);
    }
    if (request.method === 'GET' && /^\/api\/rendered\/[^/]+$/.test(url.pathname)) {
      const record = getUpload(url.pathname.split('/').pop());
      if (!record || !record.renderedPdfPath) return sendError(response, 404, 'Точный вид документа больше недоступен.');
      return streamFile(request, response, record.renderedPdfPath, true);
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/asset/')) {
      const [, , , id, ...segments] = url.pathname.split('/');
      const record = getUpload(id);
      const relative = segments.map(decodeURIComponent).join(path.sep);
      const assetPath = record && path.resolve(record.workDir, relative);
      if (!record || !isInside(record.workDir, assetPath)) return sendError(response, 404, 'Ресурс не найден.');
      return streamFile(request, response, assetPath);
    }
    if (request.method === 'GET' || request.method === 'HEAD') return serveStatic(request, response, url.pathname);
    sendError(response, 405, 'Метод не поддерживается.');
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendError(response, 500, 'Ошибка локального сервера.');
    else response.destroy();
  }
});

async function cleanup() { await Promise.all([...uploads.keys()].map(cleanupUpload)); }

const sweepTimer = setInterval(() => { sweepExpiredUploads().catch(error => console.error('Не удалось очистить временные файлы:', error)); }, UPLOAD_SWEEP_INTERVAL_MS);
sweepTimer.unref();

server.listen(PORT, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${server.address().port}`;
  console.log(`Электронный учебник запущен: ${address}`);
  if (process.platform === 'win32' && process.env.TEXTBOOK_NO_BROWSER !== '1') execFile('cmd.exe', ['/c', 'start', '', address], { windowsHide: true }, () => {});
});
server.on('error', error => { console.error(`Сервер не запущен: ${error.message}`); process.exitCode = 1; });
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(sweepTimer);
  await cleanup();
  server.close(() => process.exit());
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
