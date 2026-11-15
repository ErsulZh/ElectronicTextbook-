const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');
const mammoth = require('mammoth');
const JSZip = require('jszip');
const { DOMParser } = require('@xmldom/xmldom');
const execFileAsync = promisify(execFile);

const MAX_FILE_SIZE = 250 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.docx', '.docm', '.dotx', '.dotm', '.doc', '.dot', '.docb', '.odt', '.rtf', '.txt', '.md', '.html', '.htm', '.epub']);
const temporaryDirectories = new Set();
const openedFiles = new Set();
let startupFile = null;

const docxStyleMap = [
  "p[style-name='Heading 1'] => h1:fresh", "p[style-name='Заголовок 1'] => h1:fresh", "p[style-name='Тақырып 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh", "p[style-name='Заголовок 2'] => h2:fresh", "p[style-name='Тақырып 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh", "p[style-name='Заголовок 3'] => h3:fresh", "p[style-name='Тақырып 3'] => h3:fresh",
  "p[style-name='Title'] => h1.title:fresh", "p[style-name='Название'] => h1.title:fresh"
];

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 620,
    backgroundColor: '#f5eee2',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}
app.whenReady().then(async () => {
  startupFile = await getStartupFile();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('open-book', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Выберите учебный материал',
    defaultPath: app.getPath('desktop'),
    properties: ['openFile'],
    filters: [
      { name: 'Поддерживаемые материалы', extensions: ['pdf', 'docx', 'docm', 'dotx', 'dotm', 'doc', 'dot', 'docb', 'odt', 'rtf', 'txt', 'md', 'html', 'htm', 'epub'] },
      { name: 'Все файлы', extensions: ['*'] }
    ]
  });
  if (result.canceled) return null;
  const filePath = result.filePaths[0];
  return registerBookFile(filePath);
});

ipcMain.handle('get-startup-file', () => startupFile);

async function registerBookFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error('Неподдерживаемый формат. Выберите PDF, Word, ODT, RTF, EPUB, TXT, Markdown или HTML.');
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_SIZE) throw new Error('Файл больше 250 МБ. Выберите материал меньшего размера.');
  openedFiles.add(filePath);
  return { name: path.basename(filePath), extension, filePath, size: stat.size };
}

async function getStartupFile() {
  const argument = process.argv.find(value => SUPPORTED_EXTENSIONS.has(path.extname(value).toLowerCase()));
  if (!argument) return null;
  try { return await registerBookFile(path.resolve(argument)); } catch (_) { return null; }
}

ipcMain.handle('read-book', async (_event, filePath) => {
  if (!openedFiles.has(filePath)) throw new Error('Файл должен быть выбран через окно импорта.');
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_SIZE) throw new Error('Файл больше 250 МБ.');
  return (await fs.readFile(filePath)).toString('base64');
});
ipcMain.handle('parse-document', async (_event, filePath) => {
  if (!openedFiles.has(filePath)) throw new Error('Файл должен быть выбран через окно импорта.');
  const extension = path.extname(filePath).toLowerCase();
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_SIZE) throw new Error('Файл больше 250 МБ.');
  if (['.docx', '.docm', '.dotx'].includes(extension)) return parseDocx(filePath);
  if (['.doc', '.dot', '.dotm', '.docb', '.rtf'].includes(extension)) return parseDocx(await convertLegacyWordToDocx(filePath));
  if (extension === '.odt') return parsedDocument(await parseOdt(filePath), 'odt');
  if (extension === '.txt') return parsedDocument(textToHtml(await fs.readFile(filePath, 'utf8')), 'text');
  if (extension === '.md') return parsedDocument(markdownToHtml(await fs.readFile(filePath, 'utf8')), 'markdown');
  if (extension === '.html' || extension === '.htm') return parsedDocument(await readHtmlFile(filePath), 'html');
  if (extension === '.epub') return parsedDocument(await parseEpub(filePath), 'epub');
  throw new Error('Этот формат пока не поддерживается.');
});

function parsedDocument(html, format, notices = []) {
  return { html, format, notices: notices.filter(Boolean) };
}

async function parseDocx(filePath) {
  const assetDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'electronic-textbook-'));
  temporaryDirectories.add(assetDir);
  let imageNumber = 0;
  const conversionNotices = [];
  const result = await mammoth.convertToHtml({ path: filePath }, {
    styleMap: docxStyleMap,
    convertImage: mammoth.images.imgElement(async image => {
      if (imageNumber >= 1000) throw new Error('В документе больше 1000 изображений.');
      const base64 = await image.read('base64');
      const extension = { 'image/png': 'png', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/webp': 'webp', 'image/jpeg': 'jpg' }[image.contentType];
      if (!extension) conversionNotices.push(`Изображение формата ${image.contentType} требует дополнительного преобразования.`);
      const imagePath = path.join(assetDir, `image-${++imageNumber}.${extension || 'bin'}`);
      await fs.writeFile(imagePath, Buffer.from(base64, 'base64'));
      return { src: pathToFileURL(imagePath).href };
    })
  });
  const mammothNotices = result.messages.map(message => message.message);
  const needsWordHtml = conversionNotices.length || mammothNotices.some(message => /oMath|image\/x-(wmf|emf)|OLEObject/i.test(message));
  if (needsWordHtml) {
    try {
      const wordHtml = await convertWordToHtml(filePath);
      return parsedDocument(wordHtml, 'word-html', ['Для сохранения формул и старых рисунков использовано преобразование Microsoft Word.']);
    } catch (_) {
      return parsedDocument(result.value, 'docx', [...conversionNotices, ...mammothNotices, 'Часть объектов может не отображаться без Microsoft Word.']);
    }
  }
  return parsedDocument(result.value, 'docx', conversionNotices);
}

async function convertLegacyWordToDocx(inputPath) {
  const outputDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'electronic-textbook-doc-'));
  temporaryDirectories.add(outputDir);
  const outputPath = path.join(outputDir, `${path.basename(inputPath, path.extname(inputPath))}.docx`);
  const quote = value => value.replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop'; $word=$null; $doc=$null; try { $word=New-Object -ComObject Word.Application; $word.Visible=$false; $word.DisplayAlerts=0; $word.AutomationSecurity=3; $doc=$word.Documents.Open('${quote(inputPath)}',$false,$true,$false); $doc.SaveAs2('${quote(outputPath)}',16); } finally { if($doc){$doc.Close(0)}; if($word){$word.Quit()} }`;
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 60000 });
  } catch (_) {
    throw new Error('Не удалось преобразовать этот Word-файл. Установите Microsoft Word или сохраните его как DOCX.');
  }
  return outputPath;
}

async function convertWordToHtml(inputPath) {
  const outputDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'electronic-textbook-word-html-'));
  temporaryDirectories.add(outputDir);
  const outputPath = path.join(outputDir, 'document.html');
  const quote = value => value.replace(/'/g, "''");
  const script = `$ErrorActionPreference='Stop'; $word=$null; $doc=$null; try { $word=New-Object -ComObject Word.Application; $word.Visible=$false; $word.DisplayAlerts=0; $word.AutomationSecurity=3; $doc=$word.Documents.Open('${quote(inputPath)}',$false,$true,$false); $doc.SaveAs2('${quote(outputPath)}',10); } finally { if($doc){$doc.Close(0)}; if($word){$word.Quit()} }`;
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 90000 });
    const html = await readHtmlFile(outputPath);
    const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] || html;
    return rewriteOfficeAssetUrls(body, outputDir);
  } catch (_) {
    throw new Error('Microsoft Word не смог преобразовать документ в HTML.');
  }
}

async function readHtmlFile(filePath) {
  const buffer = await fs.readFile(filePath);
  const header = buffer.subarray(0, 8192).toString('latin1');
  const declared = /charset\s*=\s*["']?([^"'\s;>]+)/i.exec(header)?.[1]?.toLowerCase();
  const encodings = { 'windows-1251': 'windows-1251', cp1251: 'windows-1251', 'windows-1252': 'windows-1252', cp1252: 'windows-1252', utf8: 'utf-8', 'utf-8': 'utf-8', unicode: 'utf-16le', 'utf-16': 'utf-16le', 'utf-16le': 'utf-16le' };
  try { return new TextDecoder(encodings[declared] || 'utf-8').decode(buffer); } catch (_) { return buffer.toString('utf8'); }
}

function rewriteOfficeAssetUrls(html, directory) {
  return html.replace(/\bsrc\s*=\s*(["'])(.*?)\1/gi, (_match, quote, value) => {
    if (/^(?:https?:|data:|file:|#)/i.test(value)) return `src=${quote}${value}${quote}`;
    const target = path.resolve(directory, decodeURIComponent(value.replace(/\//g, path.sep)));
    if (!target.startsWith(directory)) return '';
    return `src=${quote}${pathToFileURL(target).href}${quote}`;
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
function parseRtf(rtf) {
  return rtf.replace(/\\par[d]?\s?/g, '\n').replace(/\\line\s?/g, '\n').replace(/\\u(-?\d+)\??/g, (_match, code) => String.fromCharCode(Number(code) < 0 ? Number(code) + 65536 : Number(code))).replace(/\\'[0-9a-fA-F]{2}/g, '').replace(/\\[^\s{}]+(?:-?\d+)?\s?/g, '').replace(/[{}]/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

async function parseOdt(filePath) {
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
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
  const zip = await JSZip.loadAsync(await fs.readFile(filePath));
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
    const chapter = href && zip.file(path.posix.normalize(path.posix.join(root, href))) ? await zip.file(path.posix.normalize(path.posix.join(root, href))).async('text') : '';
    const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(chapter)?.[1] || '';
    const plain = body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (plain) chapters.push(`<h1>${escapeHtml(id)}</h1>${textToHtml(plain)}`);
  }
  return chapters.join('') || '<p>В EPUB не найден текст.</p>';
}

app.on('before-quit', () => {
  for (const directory of temporaryDirectories) fs.rm(directory, { recursive: true, force: true }).catch(() => {});
});
