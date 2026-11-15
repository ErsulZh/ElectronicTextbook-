'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');

const execFileAsync = promisify(execFile);
const ROOT = __dirname;
const PORT = process.env.PORT ? Number(process.env.PORT) : 4173;
const MAX_FILE_SIZE = 250 * 1024 * 1024;
const MAX_TOTAL_STORED_BYTES = 750 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 10;
const MAX_CONCURRENT_IMPORTS = 2;
const UPLOAD_TTL_MS = 30 * 60 * 1000;
const UPLOAD_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.docm', '.dotx', '.dotm', '.doc', '.dot', '.docb', '.odt', '.rtf', '.txt', '.md', '.html', '.htm', '.epub']);
const uploads = new Map();
const SESSION_TOKEN = crypto.randomBytes(32).toString('base64url');
let activeImports = 0;

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
  await pipeline(request, limiter, fs.createWriteStream(target, { flags: 'wx' }));
  if (!received) throw new Error('Выбран пустой файл.');
  return received;
}

function isTrustedApiRequest(request) {
  const origin = request.headers.origin;
  const expectedOrigin = `http://127.0.0.1:${PORT}`;
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
  await fsp.rm(record.workDir, { recursive: true, force: true }).catch(() => {});
  return true;
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
  const declaredSize = entries.reduce((size, entry) => size + Number(entry._data?.uncompressedSize || 0), 0);
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
  const id = crypto.randomUUID();
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'electronic-textbook-web-'));
  const inputPath = path.join(workDir, `source${extension}`);
  try {
    const size = await saveUpload(request, inputPath);
    if (size + currentStoredBytes() > MAX_TOTAL_STORED_BYTES) throw new Error('Недостаточно места для ещё одной открытой книги.');
    await verifyFileSignature(inputPath, extension);
    const assetUrl = relativePath => `/api/asset/${id}/${relativePath.split(path.sep).map(encodeURIComponent).join('/')}`;
    const record = { id, name, extension, size, workDir, inputPath, createdAt: Date.now(), lastAccessAt: Date.now() };
    uploads.set(id, record);
    if (extension === '.pdf') return sendJson(response, 200, { id, name, extension, size, pdfUrl: `/api/file/${id}` });
    const parsed = await parseDocument(inputPath, extension, { workDir, assetUrl });
    sendJson(response, 200, { id, name, extension, size, ...parsed });
  } catch (error) {
    await cleanupUpload(id);
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    sendError(response, 422, error.message || 'Не удалось обработать файл.');
  } finally {
    activeImports -= 1;
  }
}

async function parseDocument(filePath, extension, context) {
  if (['.docx', '.docm', '.dotx'].includes(extension)) return parseDocx(filePath, context);
  if (['.doc', '.dot', '.dotm', '.docb', '.rtf'].includes(extension)) return parseDocx(await convertLegacyWordToDocx(filePath, context.workDir), context);
  if (extension === '.odt') return parsedDocument(await parseOdt(filePath), 'odt');
  if (extension === '.txt') return parsedDocument(textToHtml(await fsp.readFile(filePath, 'utf8')), 'text');
  if (extension === '.md') return parsedDocument(markdownToHtml(await fsp.readFile(filePath, 'utf8')), 'markdown');
  if (extension === '.html' || extension === '.htm') return parsedDocument(await readHtmlFile(filePath), 'html');
  if (extension === '.epub') return parsedDocument(await parseEpub(filePath), 'epub');
  throw new Error('Этот формат пока не поддерживается.');
}

function removeExternalUrls(html) {
  return html.replace(/\s(?:src|srcset|href)\s*=\s*(["'])(.*?)\1/gi, (match, _quote, value) => {
    if (value.startsWith('/api/asset/') || value.startsWith('#')) return match;
    return '';
  });
}

function parsedDocument(html, format, notices = []) {
  return { html: removeExternalUrls(html), format, notices: notices.filter(Boolean) };
}

async function parseDocx(filePath, context) {
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
  if (needsWordHtml) {
    try {
      const wordHtml = await convertWordToHtml(filePath, context);
      return parsedDocument(wordHtml, 'word-html', ['Для сохранения формул и старых рисунков использовано преобразование Microsoft Word.']);
    } catch (_) {
      return parsedDocument(result.value, 'docx', [...conversionNotices, ...mammothNotices, 'Часть объектов может не отображаться без Microsoft Word.']);
    }
  }
  return parsedDocument(result.value, 'docx', conversionNotices);
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
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] || html;
  return rewriteOfficeAssetUrls(body, htmlDir, context.workDir, context.assetUrl);
}

async function runWordConversion(inputPath, outputPath, format) {
  const quote = value => value.replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop'; $word=$null; $doc=$null; try { $word=New-Object -ComObject Word.Application; $word.Visible=$false; $word.DisplayAlerts=0; $word.AutomationSecurity=3; $doc=$word.Documents.Open('${quote(inputPath)}',$false,$true,$false); $doc.SaveAs2('${quote(outputPath)}',${format}); } finally { if($doc){$doc.Close(0)}; if($word){$word.Quit()} }`;
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 90000 });
  } catch (_) {
    throw new Error('Не удалось преобразовать этот Word-файл. Установите Microsoft Word или сохраните его как DOCX.');
  }
}

async function readHtmlFile(filePath) {
  const buffer = await fsp.readFile(filePath);
  const header = buffer.subarray(0, 8192).toString('latin1');
  const declared = /charset\s*=\s*["']?([^"'\s;>]+)/i.exec(header)?.[1]?.toLowerCase();
  const encodings = { 'windows-1251': 'windows-1251', cp1251: 'windows-1251', 'windows-1252': 'windows-1252', cp1252: 'windows-1252', utf8: 'utf-8', 'utf-8': 'utf-8', unicode: 'utf-16le', 'utf-16': 'utf-16le', 'utf-16le': 'utf-16le' };
  try { return new TextDecoder(encodings[declared] || 'utf-8').decode(buffer); } catch (_) { return buffer.toString('utf8'); }
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

function markdownToHtml(text) {
  return text.replace(/\r/g, '').split('\n').map(line => {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    return heading ? `<h${heading[1].length}>${escapeHtml(heading[2])}</h${heading[1].length}>` : line.trim() ? `<p>${escapeHtml(line)}</p>` : '';
  }).join('');
}

async function parseOdt(filePath) {
  const zip = await JSZip.loadAsync(await fsp.readFile(filePath));
  validateArchive(zip, 'ODT');
  const content = await zip.file('content.xml')?.async('text');
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
  const container = await zip.file('META-INF/container.xml')?.async('text');
  const opfPath = /full-path=["']([^"']+)["']/.exec(container || '')?.[1];
  if (!opfPath) throw new Error('Не удалось прочитать структуру EPUB.');
  const opf = await zip.file(opfPath)?.async('text');
  if (!opf) throw new Error('В EPUB отсутствует пакет книги.');
  const manifest = new Map([...opf.matchAll(/<item\b[^>]*id=["']([^"']+)["'][^>]*href=["']([^"']+)["'][^>]*>/g)].map(match => [match[1], match[2]]));
  const root = path.posix.dirname(opfPath);
  const ids = [...opf.matchAll(/<itemref\b[^>]*idref=["']([^"']+)["'][^>]*>/g)].map(match => match[1]);
  const chapters = [];
  for (const id of ids.slice(0, 600)) {
    const href = manifest.get(id);
    const chapterPath = href && path.posix.normalize(path.posix.join(root, href));
    const chapter = chapterPath && zip.file(chapterPath) ? await zip.file(chapterPath).async('text') : '';
    const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(chapter)?.[1] || '';
    const plain = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain) chapters.push(`<h1>${escapeHtml(id)}</h1>${textToHtml(plain)}`);
  }
  return chapters.join('') || '<p>В EPUB не найден текст.</p>';
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'src/index.html' : pathname.replace(/^\//, '');
  const allowed = relative.startsWith('src/') || relative.startsWith('node_modules/pdfjs-dist/') || relative.startsWith('node_modules/page-flip/');
  if (!allowed) return sendError(response, 404, 'Страница не найдена.');
  const filePath = path.resolve(ROOT, relative);
  if (!isInside(ROOT, filePath)) return sendError(response, 403, 'Доступ запрещён.');
  try { await streamFile(request, response, filePath); } catch (_) { sendError(response, 404, 'Файл не найден.'); }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    if (request.method === 'GET' && url.pathname === '/api/session') return sendJson(response, 200, { token: SESSION_TOKEN });
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
