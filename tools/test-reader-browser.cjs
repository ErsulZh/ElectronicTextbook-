'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const browserPath = process.env.TEXTBOOK_BROWSER_PATH || [
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].find(candidate => fs.existsSync(candidate));
const sourceFile = path.join(process.cwd(), 'Тест', 'Казакша электр аппараттары КІТАП 27.10.docx');
const pdfFile = path.join(process.cwd(), 'Тест', 'УМКД Android -де мобильді қосымшаларды әзірлеу 03.09.2026.pdf');
const contentsFixture = path.join(process.cwd(), 'fixtures', 'pagination-contents.html');
const semanticsFixture = path.join(process.cwd(), 'fixtures', 'pagination-semantics.html');

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: '0', TEXTBOOK_NO_BROWSER: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Сервер browser-теста не запустился. ${output}`)), 10_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (!match) return;
      clearTimeout(timeout);
      resolve({ child, url: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
  });
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  await new Promise(resolve => {
    const timeout = setTimeout(resolve, 5_000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    child.kill('SIGINT');
  });
}

async function importAndWait(page, fileInput, expectedText) {
  await page.locator('#fileInput').setInputFiles(fileInput);
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120_000 });
  await page.locator('#reader').waitFor({ state: 'visible' });
  await page.locator('.book-page').first().waitFor({ state: 'attached' });
  await page.locator('#book').waitFor({ state: 'visible' });
  await page.waitForFunction(expected => document.querySelector('#book')?.textContent.includes(expected), expectedText, { timeout: 120_000 });
  await page.waitForTimeout(350);
}

async function importPdfAndWait(page, filePath) {
  await page.locator('#fileInput').setInputFiles(filePath);
  await page.locator('#loading').waitFor({ state: 'hidden', timeout: 210_000 });
  await page.locator('#reader').waitFor({ state: 'visible' });
  await page.waitForFunction(() => /^\d+(?:\s*[–-]\s*\d+)?\s*\/\s*\d+$/.test(document.querySelector('#pageCounter')?.textContent || ''), null, { timeout: 210_000 });
  await page.waitForFunction(() => Boolean(document.querySelector('.book-content canvas')), null, { timeout: 210_000 });
  await page.waitForTimeout(300);
}

async function pageCounter(page) {
  const value = await page.locator('#pageCounter').textContent();
  const match = /^(\d+)(?:\s*[–-]\s*(\d+))?\s*\/\s*(\d+)$/.exec((value || '').trim());
  assert.ok(match, `Не удалось прочитать номер страницы: ${value}`);
  return { current: Number(match[1]), lastVisible: Number(match[2] || match[1]), total: Number(match[3]) };
}

async function assertPageVisible(page, pageNumber, message) {
  const visible = await page.locator(`.book-page[data-num="${pageNumber}"]`).evaluate(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  });
  assert.equal(visible, true, message || `Страница ${pageNumber} не показана в развороте.`);
}

async function readerReport(page) {
  return page.evaluate(() => {
    const leaves = [...document.querySelectorAll('.book-page')];
    const overflows = leaves.map((leaf, index) => {
      const content = leaf.querySelector('.book-content');
      return { page: index + 1, scrollHeight: content?.scrollHeight || 0, clientHeight: content?.clientHeight || 0 };
    }).filter(item => item.scrollHeight > item.clientHeight + 2);
    const topics = [...document.querySelectorAll('.toc-item')].map(button => button.textContent.trim());
    const badSingleWordPages = leaves.map((leaf, index) => {
      const content = leaf.querySelector('.book-content');
      const text = content?.textContent.replace(/\s+/g, ' ').trim() || '';
      return {
        page: index + 1,
        sample: text.slice(0, 140),
        titleOnly: Boolean(content?.querySelector('h1, h2, h3, h4, h5, h6')),
        structured: Boolean(content?.querySelector('li, td, th'))
      };
    }).filter(item => item.sample && item.sample.split(' ').length === 1 && !item.titleOnly && !item.structured);
    const headingOnlyPages = leaves.map((leaf, index) => {
      const content = leaf.querySelector('.book-content');
      const childNodes = [...(content?.children || [])];
      const hasHeading = childNodes.some(node => /^H[1-6]$/.test(node.tagName));
      const hasBody = childNodes.some(node => !/^H[1-6]$/.test(node.tagName) && (node.textContent.trim() || node.querySelector('img,table')));
      return { page: index + 1, sample: (content?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140), hasHeading, hasBody };
    }).filter(item => item.hasHeading && !item.hasBody);
    return { leaves: leaves.length, overflows, topics, badSingleWordPages, headingOnlyPages };
  });
}

async function assertTocNavigation(page, indexes) {
  for (const index of indexes) {
    const button = page.locator('.toc-item').nth(index);
    const expectedPage = Number(await button.getAttribute('data-page'));
    await button.click();
    await page.waitForTimeout(900);
    await assertPageVisible(page, expectedPage, `TOC пункт ${index + 1} ведёт не на свою страницу.`);
  }
}

async function main() {
  if (!browserPath || !fs.existsSync(browserPath)) throw new Error('Не найден Chromium-браузер. Укажите TEXTBOOK_BROWSER_PATH или установите Edge, Chrome либо Brave.');
  for (const file of [sourceFile, pdfFile, contentsFixture, semanticsFixture]) {
    if (!fs.existsSync(file)) throw new Error(`Нет файла для browser-теста: ${file}`);
  }
  const server = await startServer();
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--disable-gpu'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.setDefaultTimeout(120_000);
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await importAndWait(page, contentsFixture, 'Введение');
    const contentsReport = await readerReport(page);
    assert.deepEqual(contentsReport.topics, ['Введение', 'Реальная тема'], 'Напечатанное содержание ошибочно попало в TOC.');
    await assertTocNavigation(page, [0, 1]);
    await page.locator('#pageJump').fill('2');
    await page.locator('#goPage').click();
    await page.waitForTimeout(900);
    await assertPageVisible(page, 2, 'Не удалось перейти ко второй странице первой книги.');

    await importAndWait(page, semanticsFixture, 'Проверка форматирования');
    const semanticsReport = await readerReport(page);
    assert.equal((await pageCounter(page)).current, 1, 'Новая книга должна открываться с первой страницы, а не наследовать прежнюю.');
    assert.equal(semanticsReport.overflows.length, 0, 'Тестовый HTML имеет переполнение.');
    const semantics = await page.evaluate(() => ({
      strong: Boolean(document.querySelector('.book-content strong')),
      em: Boolean(document.querySelector('.book-content em')),
      code: Boolean(document.querySelector('.book-content code')),
      continuedList: Boolean(document.querySelector('.book-content ol[start="7"]')),
      firstTableRow: [...document.querySelectorAll('.book-content table')].some(table => table.textContent.includes('Первая строка без заголовка'))
    }));
    assert.deepEqual(semantics, { strong: true, em: true, code: true, continuedList: true, firstTableRow: true }, 'При разбиении потеряна разметка, нумерация либо первая строка таблицы.');

    const longListFile = {
      name: 'long-single-list-item.html',
      mimeType: 'text/html',
      buffer: Buffer.from(`<h1>Длинный список</h1><ol><li>${'учебный текст '.repeat(3000)}</li></ol>`, 'utf8')
    };
    const longListStart = Date.now();
    await importAndWait(page, longListFile, 'Длинный список');
    const longListReport = await readerReport(page);
    assert.ok(Date.now() - longListStart < 30_000, 'Один длинный пункт списка слишком долго готовит книгу.');
    assert.ok(longListReport.leaves > 3, 'Один длинный пункт списка не разбился на страницы.');
    assert.equal(longListReport.overflows.length, 0, 'Длинный пункт списка создал внутреннюю прокрутку.');

    await importPdfAndWait(page, sourceFile);
    const report = await readerReport(page);
    const wordStart = await pageCounter(page);
    assert.ok(report.leaves > 10, 'Большая Word-книга не разбилась на страницы.');
    assert.ok(wordStart.total > 10, 'Word не преобразован в постраничную книгу.');
    assert.ok(await page.locator('.pdf-page .book-content canvas').count() > 0, 'Word не открыт в режиме точной PDF-разметки.');
    assert.equal(report.overflows.length, 0, `Есть переполненные страницы: ${JSON.stringify(report.overflows.slice(0, 3))}`);
    assert.ok(report.topics.length > 1, 'TOC не содержит реальных тем.');
    const jumpIndexes = [...new Set([0, 1, 2, Math.floor(report.topics.length / 2), report.topics.length - 1])].filter(index => index >= 0 && index < report.topics.length);
    await assertTocNavigation(page, jumpIndexes);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1_100);
    const mobileReport = await readerReport(page);
    const mobileGeometry = await page.evaluate(() => {
      const book = document.querySelector('#book')?.getBoundingClientRect();
      const reader = document.querySelector('#reader')?.getBoundingClientRect();
      return {
        pageWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bookFits: Boolean(book && book.left >= -1 && book.right <= window.innerWidth + 1),
        readerFits: Boolean(reader && reader.right <= window.innerWidth + 1),
        tocHidden: document.querySelector('#tocPanel')?.hidden === true
      };
    });
    assert.equal(mobileReport.overflows.length, 0, 'После перестроения для телефона появились переполнения.');
    assert.ok(mobileGeometry.documentWidth <= mobileGeometry.pageWidth, `На телефоне появилась горизонтальная прокрутка: ${JSON.stringify(mobileGeometry)}`);
    assert.ok(mobileGeometry.bookFits && mobileGeometry.readerFits, `Книга не помещается на экран телефона: ${JSON.stringify(mobileGeometry)}`);
    assert.equal(mobileGeometry.tocHidden, true, 'На телефоне оглавление перекрывает книгу до нажатия кнопки.');
    assert.equal(await page.locator('#tocToggle').getAttribute('aria-expanded'), 'false', 'Скрытое содержание не сообщается как закрытое.');
    await page.locator('#tocToggle').click();
    await page.locator('#tocPanel').waitFor({ state: 'visible' });
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#tocToggle').getAttribute('aria-expanded'), 'true', 'Открытое содержание не сообщается как раскрытое.');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tocSearch', 'При открытии содержания фокус не переходит к поиску тем.');
    await page.locator('#closeToc').click();
    assert.equal(await page.locator('#tocPanel').isVisible(), false, 'Кнопка закрытия не скрывает содержание.');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'tocToggle', 'После закрытия содержания фокус не вернулся к кнопке открытия.');

    await page.setViewportSize({ width: 1440, height: 980 });
    await page.waitForTimeout(1_100);
    await importPdfAndWait(page, pdfFile);
    const pdfStart = await pageCounter(page);
    assert.ok(pdfStart.total > 1, 'Реальный PDF не содержит нескольких страниц.');
    assert.equal(pdfStart.current, 1, 'PDF должен открываться с первой страницы.');
    await page.locator('#next').click();
    await page.waitForTimeout(900);
    assert.ok((await pageCounter(page)).current > pdfStart.current, 'Кнопка Next не листает реальный PDF.');
    const targetPdfPage = Math.min(10, pdfStart.total);
    await page.locator('#pageJump').fill(String(targetPdfPage));
    await page.locator('#goPage').click();
    await page.waitForTimeout(900);
    await assertPageVisible(page, targetPdfPage, 'Переход по номеру страницы PDF не работает.');
    assert.ok(await page.locator('.book-content canvas').count() > 0, 'PDF не отрисовывает ни одной canvas-страницы.');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(1_100);
    const pdfMobile = await page.evaluate(() => {
      const book = document.querySelector('#book')?.getBoundingClientRect();
      return {
        pageWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bookFits: Boolean(book && book.left >= -1 && book.right <= window.innerWidth + 1),
        canvasVisible: Boolean(document.querySelector('.book-content canvas')),
        tocHidden: document.querySelector('#tocPanel')?.hidden === true
      };
    });
    assert.ok((await pageCounter(page)).current >= targetPdfPage - 1, 'Изменение размера сбросило PDF слишком далеко назад.');
    assert.ok(pdfMobile.documentWidth <= pdfMobile.pageWidth && pdfMobile.bookFits, `PDF не помещается на мобильном экране: ${JSON.stringify(pdfMobile)}`);
    assert.ok(pdfMobile.canvasVisible, 'После изменения размера PDF не отрисован.');
    assert.equal(pdfMobile.tocHidden, true, 'На телефоне PDF открывается с перекрывающим содержанием.');

    await importAndWait(page, contentsFixture, 'Введение');
    assert.equal((await pageCounter(page)).current, 1, 'Книга после PDF не открылась с первой страницы.');
    assert.equal(await page.locator('.book-content canvas').count(), 0, 'После замены PDF остались PDF-страницы в новом документе.');
    console.log(JSON.stringify({
      contentsReport,
      semanticsReport,
      longList: { leaves: longListReport.leaves, overflows: longListReport.overflows.length },
      largeDocument: { leaves: report.leaves, topics: report.topics.length, wordPages: wordStart.total, overflows: report.overflows.length },
      mobile: { leaves: mobileReport.leaves, overflows: mobileReport.overflows.length, ...mobileGeometry },
      pdf: { pages: pdfStart.total, testedPage: targetPdfPage, mobile: pdfMobile }
    }));
  } finally {
    await browser.close();
    await stopServer(server.child);
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
