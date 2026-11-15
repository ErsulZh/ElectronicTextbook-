'use strict';

const assert = require('assert/strict');
const { spawn } = require('child_process');
const JSZip = require('jszip');

function startServer(extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: '0', TEXTBOOK_NO_BROWSER: '1', ...extraEnvironment },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Сервер тестов не запустился. ${output}`)), 10_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (!match) return;
      clearTimeout(timeout);
      resolve({ child, baseUrl: `http://127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('exit', code => {
      if (!/http:\/\/127\.0\.0\.1:/.test(output)) reject(new Error(`Сервер тестов завершился с кодом ${code}. ${output}`));
    });
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

async function withServer(environment, callback) {
  const server = await startServer(environment);
  try { return await callback(server.baseUrl); } finally { await stopServer(server.child); }
}

async function session(baseUrl) {
  const response = await fetch(`${baseUrl}/api/session`);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.ok(data.token);
  return data.token;
}

async function upload(baseUrl, token, name, body) {
  const response = await fetch(`${baseUrl}/api/import?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'x-textbook-token': token },
    body
  });
  const data = await response.json();
  return { response, data };
}

async function release(baseUrl, token, id) {
  if (!id) return;
  const response = await fetch(`${baseUrl}/api/import/${id}`, { method: 'DELETE', headers: { 'x-textbook-token': token } });
  assert.equal(response.status, 200);
}

async function makeOdt() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text');
  zip.file('content.xml', '<?xml version="1.0"?><office:document-content xmlns:office="office" xmlns:text="text"><office:body><office:text><text:h text:outline-level="1">ODT title</text:h><text:p>ODT paragraph</text:p></office:text></office:body></office:document-content>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function makeEpub() {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>');
  zip.file('OPS/book.opf', '<package><manifest><item id="one" href="one.xhtml"/><item id="two" href="two.xhtml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>');
  zip.file('OPS/one.xhtml', '<html><head><title>First chapter</title></head><body><p>First text</p></body></html>');
  zip.file('OPS/two.xhtml', '<html><head><title>Second chapter</title></head><body><p>Second text</p></body></html>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function runModelTests() {
  await withServer({}, async baseUrl => {
    const token = await session(baseUrl);
    const rejectedWithoutToken = await fetch(`${baseUrl}/api/import?name=plain.txt`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('blocked')
    });
    assert.equal(rejectedWithoutToken.status, 403);
    const rejectedForeignOrigin = await fetch(`${baseUrl}/api/import?name=plain.txt`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-textbook-token': token, origin: 'https://example.invalid' }, body: Buffer.from('blocked')
    });
    assert.equal(rejectedForeignOrigin.status, 403);
    const invalidPdf = await upload(baseUrl, token, 'not-a-pdf.pdf', Buffer.from('not a PDF'));
    assert.equal(invalidPdf.response.status, 422);
    const validPdf = await upload(baseUrl, token, 'range.pdf', Buffer.from('%PDF-1.4\n%%EOF'));
    assert.equal(validPdf.response.status, 200);
    const range = await fetch(`${baseUrl}${validPdf.data.pdfUrl}`, { headers: { Range: 'bytes=0-4' } });
    assert.equal(range.status, 206);
    await release(baseUrl, token, validPdf.data.id);
    const cases = [
      ['guide.md', Buffer.from('# Heading\n\n**bold** *italic* [link](https://example.com)\n\n- one\n- two\n\n1. first\n2. second\n\n`code`\n\n```js\nconst x = 1;\n```'), result => {
        assert.equal(result.response.status, 200);
        assert.ok(result.data.document.blocks.some(block => block.type === 'heading'));
        assert.ok(result.data.document.blocks.some(block => block.type === 'list'));
        assert.match(JSON.stringify(result.data.document), /<strong>bold<\/strong>/);
        assert.doesNotMatch(JSON.stringify(result.data.document), /https:\/\/example\.com/);
      }],
      ['cp1251.txt', Buffer.from([0xCF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2]), result => {
        assert.equal(result.response.status, 200);
        assert.equal(result.data.document.blocks[0].text, 'Привет');
        assert.match(result.data.notices.join(' '), /Windows-1251/);
      }],
      ['utf16.txt', Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('Привет', 'utf16le')]), result => {
        assert.equal(result.response.status, 200);
        assert.equal(result.data.document.blocks[0].text, 'Привет');
      }],
      ['unsafe.html', Buffer.from('<script>alert(1)</script><h1>Safe</h1><img src="https://example.com/pixel.png">'), result => {
        assert.equal(result.response.status, 200);
        assert.doesNotMatch(JSON.stringify(result.data.document), /example\.com|script/);
      }],
      ['sample.odt', await makeOdt(), result => {
        assert.equal(result.response.status, 200);
        assert.deepEqual(result.data.document.blocks.map(block => block.type), ['heading', 'paragraph']);
      }],
      ['sample.epub', await makeEpub(), result => {
        assert.equal(result.response.status, 200);
        assert.deepEqual(result.data.document.tocHints.map(item => item.title), ['First chapter', 'Second chapter']);
      }]
    ];
    for (const [name, body, verify] of cases) {
      const result = await upload(baseUrl, token, name, body);
      try { verify(result); } finally { await release(baseUrl, token, result.data.id); }
    }
  });

  await withServer({ TEXTBOOK_DISABLE_WORD: '1' }, async baseUrl => {
    const token = await session(baseUrl);
    const capabilities = await (await fetch(`${baseUrl}/api/capabilities`)).json();
    assert.equal(capabilities.wordConversionAvailable, false);
    const legacyWord = await upload(baseUrl, token, 'legacy.doc', Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(legacyWord.response.status, 422);
    assert.match(legacyWord.data.error, /Microsoft Word/);
  });
}

runModelTests().then(() => console.log('Document-model format tests passed.')).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
