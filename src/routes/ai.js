const router = require('express').Router();
const { auth } = require('../middleware/auth');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, BorderStyle, WidthType, ShadingType, LevelFormat,
  VerticalAlign, HeadingLevel
} = require('docx');

// ── GROQ AI CALL ──────────────────────────────────────
async function callGroq(prompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if(!apiKey) throw new Error('GROQ_API_KEY not set in Railway Variables.');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
      temperature: 0.7
    })
  });
  const data = await response.json();
  if(!response.ok) throw new Error(data.error?.message || 'AI generation failed');
  return data.choices?.[0]?.message?.content || '';
}

// ── WORD DOC BUILDER ──────────────────────────────────
function buildMinutesDoc(details, aiText) {
  const ACCENT   = '1E3A5F';
  const LIGHT_BG = 'EBF2FA';
  const WHITE    = 'FFFFFF';
  const GRAY     = 'F5F5F5';

  const noBorder  = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
  const thickBorder = { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC' };
  const thinBorder  = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
  const allBorders  = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

  // Helper: header row cell
  const hCell = (text, w, shade=LIGHT_BG, bold=true, color=ACCENT, size=20, align=AlignmentType.LEFT) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      shading: { fill: shade, type: ShadingType.CLEAR },
      borders: allBorders,
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ alignment: align, children: [new TextRun({ text, bold, size, font: 'Arial', color })] })]
    });

  // Helper: data cell
  const dCell = (text, w, shade=WHITE, bold=false, size=19, color='222222', align=AlignmentType.LEFT) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      shading: { fill: shade, type: ShadingType.CLEAR },
      borders: allBorders,
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ alignment: align, children: [new TextRun({ text: text||'—', bold, size, font: 'Arial', color })] })]
    });

  // Parse AI text into structured sections
  const lines = (aiText||'').split('\n');
  const contentChildren = [];
  for(const line of lines) {
    const t = line.trim();
    if(!t) { contentChildren.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun('')] })); continue; }

    const isSection  = /^[1-9]\.\s+[A-Z]/.test(t) || (/^[A-Z][A-Z\s\/&]+:?\s*$/.test(t) && t.length < 70);
    const isBullet   = /^[-•*]\s/.test(t);
    const isNum      = /^\d+[.)]\s/.test(t) && !isSection;
    const isSub      = t.endsWith(':') && t.length < 60 && !isBullet && !isSection;

    if(isSection) {
      contentChildren.push(new Paragraph({
        spacing: { before: 200, after: 100 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ACCENT, space: 1 } },
        children: [new TextRun({ text: t.replace(/:$/, ''), bold: true, size: 22, font: 'Arial', color: ACCENT })]
      }));
    } else if(isSub) {
      contentChildren.push(new Paragraph({
        spacing: { before: 120, after: 60 },
        children: [new TextRun({ text: t, bold: true, size: 20, font: 'Arial', color: '333333' })]
      }));
    } else if(isBullet) {
      contentChildren.push(new Paragraph({
        numbering: { reference: 'bullets', level: 0 },
        spacing: { after: 60 },
        children: [new TextRun({ text: t.replace(/^[-•*]\s*/, ''), size: 19, font: 'Arial', color: '222222' })]
      }));
    } else if(isNum) {
      contentChildren.push(new Paragraph({
        numbering: { reference: 'numbers', level: 0 },
        spacing: { after: 60 },
        children: [new TextRun({ text: t.replace(/^\d+[.)]\s*/, ''), size: 19, font: 'Arial', color: '222222' })]
      }));
    } else {
      contentChildren.push(new Paragraph({
        spacing: { after: 80 },
        children: [new TextRun({ text: t, size: 19, font: 'Arial', color: '222222' })]
      }));
    }
  }

  // ── TABLE 1: Header ──────────────────────────────
  const headerTable = new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [5200, 4160],
    rows: [
      new TableRow({
        height: { value: 800, rule: 'atLeast' },
        children: [
          new TableCell({
            width: { size: 5200, type: WidthType.DXA },
            shading: { fill: ACCENT, type: ShadingType.CLEAR },
            borders: allBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 120, bottom: 120, left: 180, right: 180 },
            children: [
              new Paragraph({ children: [new TextRun({ text: 'CAREER DEVELOPMENT CENTRE', bold: true, size: 24, font: 'Arial', color: WHITE })] }),
              new Paragraph({ children: [new TextRun({ text: 'A Unit of MREI – Manav Rachna Educational Institutions', size: 17, font: 'Arial', color: 'CCDDEE', italics: true })] }),
            ]
          }),
          new TableCell({
            width: { size: 4160, type: WidthType.DXA },
            shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
            borders: allBorders,
            verticalAlign: VerticalAlign.CENTER,
            margins: { top: 120, bottom: 120, left: 180, right: 180 },
            children: [
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'MEETING MINUTES', bold: true, size: 26, font: 'Arial', color: ACCENT })] }),
              new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: details.course || '', size: 19, font: 'Arial', color: '444444' })] }),
            ]
          }),
        ]
      })
    ]
  });

  // ── TABLE 2: Date / Venue ─────────────────────────
  const infoTable = new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [1400, 3260, 1400, 3300],
    rows: [
      new TableRow({ children: [
        hCell('Date', 1400),
        dCell(details.date_display || details.date || '—', 3260, WHITE, false, 19),
        hCell('Time', 1400),
        dCell(details.time || '—', 3300, WHITE, false, 19),
      ]}),
      new TableRow({ children: [
        hCell('Venue', 1400),
        dCell(details.venue || '—', 3260, WHITE, false, 19),
        hCell('Programme', 1400),
        dCell(details.course || '—', 3300, WHITE, false, 19),
      ]}),
    ]
  });

  // ── TABLE 3: Main Content (2-col) ─────────────────
  // Left col: Agenda + Attendees + Signatures
  const agenda = details.agenda || 'Syllabus Discussion\nExamination Pattern\nCurrent Topics\nQuestion Bank\nAction Items';
  const agendaItems = agenda.split('\n').filter(l=>l.trim());

  const leftChildren = [
    new Paragraph({ spacing: { before: 60, after: 100 }, children: [new TextRun({ text: 'AGENDA', bold: true, size: 22, font: 'Arial', color: ACCENT })] }),
    ...agendaItems.map(item => new Paragraph({
      spacing: { after: 60 },
      children: [new TextRun({ text: item.trim().replace(/^[-•]\s*/,''), size: 19, font: 'Arial', color: '222222' })]
    })),
    new Paragraph({ spacing: { before: 200, after: 100 }, children: [new TextRun({ text: 'ATTENDEES', bold: true, size: 22, font: 'Arial', color: ACCENT })] }),
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: details.attendees || 'As per attendance sheet', size: 19, font: 'Arial', color: '222222' })] }),
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: `Venue: ${details.venue || '—'}`, size: 17, font: 'Arial', color: '666666', italics: true })] }),
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: '(Attendance sheet attached)', size: 17, font: 'Arial', color: '666666', italics: true })] }),
    new Paragraph({ spacing: { before: 280, after: 100 }, border: { top: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC', space: 1 } }, children: [new TextRun({ text: 'SIGNATURES', bold: true, size: 22, font: 'Arial', color: ACCENT })] }),
    new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: 'Prepared By:', bold: true, size: 19, font: 'Arial', color: '333333' })] }),
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: '____________________', size: 19, font: 'Arial', color: '777777' })] }),
    new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: 'CDC Coordinator', size: 17, font: 'Arial', color: '666666', italics: true })] }),
    new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: 'Approved By:', bold: true, size: 19, font: 'Arial', color: '333333' })] }),
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: '____________________', size: 19, font: 'Arial', color: '777777' })] }),
    new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: 'Head – CDC, MREI', size: 17, font: 'Arial', color: '666666', italics: true })] }),
  ];

  const rightChildren = [
    new Paragraph({ spacing: { before: 60, after: 100 }, children: [new TextRun({ text: 'DISCUSSION SUMMARY & KEY DECISIONS', bold: true, size: 22, font: 'Arial', color: ACCENT })] }),
    ...contentChildren
  ];

  const mainTable = new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [3000, 6360],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 3000, type: WidthType.DXA },
            shading: { fill: GRAY, type: ShadingType.CLEAR },
            borders: allBorders,
            margins: { top: 120, bottom: 120, left: 160, right: 160 },
            children: leftChildren
          }),
          new TableCell({
            width: { size: 6360, type: WidthType.DXA },
            shading: { fill: WHITE, type: ShadingType.CLEAR },
            borders: allBorders,
            margins: { top: 120, bottom: 120, left: 160, right: 160 },
            children: rightChildren
          }),
        ]
      })
    ]
  });

  // ── FOOTER ────────────────────────────────────────
  const footer = new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 100 },
    border: { top: { style: BorderStyle.SINGLE, size: 2, color: 'CCCCCC', space: 1 } },
    children: [new TextRun({ text: 'Career Development Centre  –  A Unit of Manav Rachna Educational Institutions (MREI)  |  Confidential', size: 15, font: 'Arial', color: '888888', italics: true })]
  });

  return new Document({
    numbering: { config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 560, hanging: 280 } } } }] },
      { reference: 'numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 560, hanging: 280 } } } }] },
    ]},
    styles: { default: { document: { run: { font: 'Arial', size: 20 } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 720, right: 720, bottom: 720, left: 720 } } },
      children: [headerTable, new Paragraph({ spacing: { after: 80 }, children: [new TextRun('')] }), infoTable, new Paragraph({ spacing: { after: 80 }, children: [new TextRun('')] }), mainTable, footer]
    }]
  });
}

// ── ROUTE: Generate AI text only ──────────────────────
router.post('/minutes', auth, async (req, res) => {
  try {
    const { prompt } = req.body;
    if(!prompt) return res.status(400).json({ error: 'Prompt required' });
    const text = await callGroq(prompt);
    res.json({ text });
  } catch(e) {
    console.error('AI minutes error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── ROUTE: Generate + Download Word doc ───────────────
router.post('/minutes/download', auth, async (req, res) => {
  try {
    const { prompt, details } = req.body;
    if(!prompt || !details) return res.status(400).json({ error: 'Prompt and details required' });

    // Get AI text
    const aiText = await callGroq(prompt);

    // Build Word doc on backend
    const doc = buildMinutesDoc(details, aiText);
    const buffer = await Packer.toBuffer(doc);

    const filename = `CC_Minutes_${(details.title||'Meeting').replace(/\s+/g,'_')}_${details.date||'date'}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch(e) {
    console.error('Download error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── ROUTE: Download Word from existing AI text ────────
router.post('/minutes/download-only', auth, async (req, res) => {
  try {
    const { aiText, details } = req.body;
    if(!aiText || !details) return res.status(400).json({ error: 'aiText and details required' });

    const doc = buildMinutesDoc(details, aiText);
    const buffer = await Packer.toBuffer(doc);

    const filename = `CC_Minutes_${(details.title||'Meeting').replace(/\s+/g,'_')}_${details.date||'date'}.docx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch(e) {
    console.error('Download error:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
