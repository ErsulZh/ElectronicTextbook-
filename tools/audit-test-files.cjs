const fs = require('fs/promises');
const path = require('path');
const mammoth = require('mammoth');

const inputDir = process.argv[2] || path.join(process.cwd(), 'Тест');
const htmlStats = html => {
  const blocks = [...html.matchAll(/<(p|h[1-6]|li|tr|table|img)\b[^>]*>([\s\S]*?)<\/\1>|<img\b[^>]*>/gi)];
  const plain = value => value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const paragraphLengths = blocks.filter(match => /^(p|li)$/i.test(match[1] || '')).map(match => plain(match[0]).length);
  return {
    htmlCharacters: html.length,
    headings: (html.match(/<h[1-6]\b/gi) || []).length,
    paragraphs: (html.match(/<p\b/gi) || []).length,
    listItems: (html.match(/<li\b/gi) || []).length,
    tables: (html.match(/<table\b/gi) || []).length,
    rows: (html.match(/<tr\b/gi) || []).length,
    images: (html.match(/<img\b/gi) || []).length,
    longestParagraph: Math.max(0, ...paragraphLengths),
  };
};

async function inspectWord(filePath, extension) {
  if (extension !== '.docx') return { status: 'requires Word conversion before HTML normalization' };
  const result = await mammoth.convertToHtml({ path: filePath });
  return { status: 'parsed', ...htmlStats(result.value), warnings: result.messages.map(item => item.message) };
}

async function main() {
  const files = (await fs.readdir(inputDir, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'ru'));
  const report = [];
  for (const name of files) {
    const filePath = path.join(inputDir, name);
    const extension = path.extname(name).toLowerCase();
    const size = (await fs.stat(filePath)).size;
    if (['.doc', '.docx'].includes(extension)) report.push({ name, extension, size, ...(await inspectWord(filePath, extension)) });
    else report.push({ name, extension, size, status: 'inspect with PDF parser' });
  }
  process.stdout.write(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
