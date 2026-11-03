// Plain-text extraction for providers that cannot read a PDF directly (Codex).
// Lines are rebuilt from pdf.js text items; the model then repairs the layout.
async function extractText(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '', lastY = null;
    const lines = [];
    for (const it of content.items) {
      if (!('str' in it)) continue;
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line); line = ''; }
      line += it.str;
      if (it.hasEOL) { lines.push(line); line = ''; lastY = null; continue; }
      lastY = y;
    }
    if (line) lines.push(line);
    pages.push(`--- page ${i} ---\n` + lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'));
    page.cleanup();
  }
  await doc.cleanup();
  if (typeof doc.destroy === "function") await doc.destroy();
  return pages.join('\n\n');
}

module.exports = { extractText };
