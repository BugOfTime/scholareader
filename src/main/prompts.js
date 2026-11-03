// Prompts and the JSON schema shared by both AI providers.
// The whole paper goes to the model in one request; the model returns the
// re-laid-out paper (paragraph by paragraph, original + Chinese), the
// reference list and a structured summary in a single JSON object.

const str = { type: 'string' };
const strList = { type: 'array', items: str };
const obj = (properties) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const PAPER_SCHEMA = obj({
  title: str,
  title_zh: str,
  authors: str,
  venue: str,
  sections: {
    type: 'array',
    items: obj({
      heading: str,
      heading_zh: str,
      paragraphs: { type: 'array', items: obj({ en: str, zh: str }) },
    }),
  },
  references: {
    type: 'array',
    items: obj({ n: { type: 'integer' }, text: str, title: str, url: str }),
  },
  summary: obj({
    one_line: str,
    problem: str,
    method: strList,
    results: strList,
    limitations: strList,
  }),
});

const ANALYZE_SYSTEM = `You turn academic papers (PDF) into a clean bilingual reading layout for a Chinese-speaking researcher.
Return exactly one JSON object that matches the provided schema. Rules:

Layout
- Recover the paper's logical structure: title, authors, venue/year, sections in reading order, and paragraphs.
- Fix PDF artefacts: join words split by line-break hyphens, drop running headers, footers and page numbers, merge paragraphs broken across columns or pages.
- Put the abstract first as a section with heading "Abstract".
- Keep figure and table captions as their own paragraphs, starting with "Figure N." or "Table N.". Do not invent figure content.
- Write equations inline as plain text or LaTeX.
- Do not include the reference list inside "sections"; it goes in "references".
- Keep every paragraph of the body. Do not summarise or skip text in "sections".

Translation
- "en" is the original paragraph text (cleaned). "zh" is a faithful, fluent Simplified Chinese translation of that same paragraph.
- Keep technical terms consistent across the whole paper. For a key term's first appearance, add the English in parentheses, e.g. 注意力机制（attention）.
- "title_zh" and "heading_zh" are Chinese translations. If the paper is already in Chinese, put the original in both fields.

Citations
- Keep numeric citation markers exactly as they appear, e.g. [12] or [3, 5], in both "en" and "zh".
- If the paper uses author-year citations, keep them and append the reference number in square brackets, e.g. "Vaswani et al. (2017) [4]", so every citation can be linked.
- Expand ranges such as [3-5] to [3, 4, 5].
- "references": one entry per reference-list item, numbered "n" from 1 in list order (use the paper's own numbers when it has them). "text" is the full reference as printed, "title" is the cited work's title, "url" is a DOI link (https://doi.org/...), arXiv link or URL only if printed in the reference; otherwise "".

Summary (in Simplified Chinese)
- "one_line": one sentence on what the paper shows.
- "problem": the research question in 1-2 sentences.
- "method", "results", "limitations": 2-5 short bullet strings each. Use numbers from the paper where they exist. Cite references as [n] where relevant.`;

const ANALYZE_USER = 'Lay out, translate and summarise this paper following the rules. Respond with the JSON object only.';

const EXPLAIN_SYSTEM = `You help a Chinese-speaking researcher read an English academic paper.
The user selected some text. Explain it in Simplified Chinese, in the context of the paragraph it came from:
- If it is a term or abbreviation: what it means in general, then what it means in this paper.
- If it is a sentence: restate it plainly, then explain anything that makes it hard.
Keep it under 150 Chinese characters unless the selection is long. Plain text, no Markdown headings.`;

function explainUser({ text, context, title }) {
  return `Paper: ${title || '(unknown)'}\n\nParagraph:\n${context || '(none)'}\n\nSelected text:\n${text}`;
}

module.exports = { PAPER_SCHEMA, ANALYZE_SYSTEM, ANALYZE_USER, EXPLAIN_SYSTEM, explainUser };
