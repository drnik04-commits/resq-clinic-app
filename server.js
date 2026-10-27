require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

let AdmZip;
try {
  AdmZip = require('adm-zip');
} catch (e) {
  console.warn('adm-zip not installed. Run "npm install adm-zip"');
}

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 10000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/templates', express.static(path.join(__dirname, 'Report_Templates')));
// Serve root directory BEFORE public so root index.html is always prioritized
app.use(express.static(path.join(__dirname)));
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync('./uploads')) {
  try { fs.mkdirSync('./uploads', { recursive: true }); } catch (e) {}
}
const TEMPLATES_DIR = path.join(__dirname, 'Report_Templates');
if (!fs.existsSync(TEMPLATES_DIR)) {
  try { fs.mkdirSync(TEMPLATES_DIR, { recursive: true }); } catch (e) {}
}

function getCleanId(val) {
  if (!val) return null;
  const str = String(val).trim();
  return str.length > 0 ? str : null;
}

function getTenantCentreId(req) {
  const headerId = getCleanId(req.headers['x-centre-id']);
  const queryId = getCleanId(req.query.centreId);
  const bodyId = getCleanId(req.body?.centreId);
  return headerId || queryId || bodyId || null;
}

function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

// Sanitizes text for PDFKit standard Helvetica (WinAnsi encoding) while preserving ~, -, tabs, etc.
function sanitizeForPdfKit(str) {
  return String(str || '')
    .replace(/[\u223C\u223D\uFF5E\u02DC\u2053]/g, '~') // All Unicode tilde variants -> standard ASCII ~
    .replace(/[\u2013\u2014\u2212]/g, '-')              // En-dash / Em-dash / Minus -> standard ASCII -
    .replace(/[\u2018\u2019]/g, "'")                    // Smart single quotes
    .replace(/[\u201C\u201D]/g, '"')                    // Smart double quotes
    .replace(/\u2026/g, '...')                          // Ellipsis -> ...
    .replace(/\u20B9/g, 'Rs. ')                         // Indian Rupee symbol -> Rs.
    .replace(/\t+/g, '    ')                            // Convert Word tabs into clean spaces so PDFKit never scrambles
    .replace(/\u00A0/g, ' ');                           // Non-breaking space -> standard space
}

// Helper to convert a Word XML paragraph/cell block into text with clean **bold** markers
function parseWordParagraphXml(pXml) {
  const segments = [];
  const tokenRegex = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>|<w:tab[^>]*\/>|<w:br[^>]*\/>/gi;
  let match;
  while ((match = tokenRegex.exec(pXml)) !== null) {
    const fullMatch = match[0];
    if (/^<w:tab/i.test(fullMatch)) {
      segments.push({ text: '    ', bold: false });
    } else if (/^<w:br/i.test(fullMatch)) {
      segments.push({ text: '\n', bold: false });
    } else {
      const rInner = match[1] || '';
      const rPrMatch = rInner.match(/<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/i);
      let isBold = false;
      if (rPrMatch) {
        const rPr = rPrMatch[1];
        if (/<w:b\b(?![^>]*w:val\s*=\s*["']?(?:false|0|none)["']?)/i.test(rPr)) {
          isBold = true;
        }
      }
      let runText = '';
      const innerTokens = rInner.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab[^>]*\/>|<w:br[^>]*\/>/gi) || [];
      for (const tk of innerTokens) {
        if (/^<w:tab/i.test(tk)) runText += '    ';
        else if (/^<w:br/i.test(tk)) runText += '\n';
        else runText += decodeXmlEntities(tk.replace(/<[^>]+>/g, ''));
      }
      if (runText) {
        if (runText.trim().length === 0 && segments.length > 0) {
          segments[segments.length - 1].text += runText;
        } else if (segments.length > 0 && segments[segments.length - 1].bold === isBold) {
          segments[segments.length - 1].text += runText;
        } else {
          segments.push({ text: runText, bold: isBold });
        }
      }
    }
  }

  let out = '';
  for (const seg of segments) {
    if (!seg.text) continue;
    if (seg.bold && seg.text.trim().length > 0) {
      const subLines = seg.text.split('\n');
      out += subLines.map(sl => {
        if (!sl.trim()) return sl;
        const lead = sl.match(/^\s*/)[0];
        const trail = sl.match(/\s*$/)[0];
        const core = sl.trim();
        return `${lead}**${core}**${trail}`;
      }).join('\n');
    } else {
      out += seg.text;
    }
  }

  out = out
    .replace(/\*\*(\s*)\*\*/g, '$1')
    .replace(/\*{3,}/g, '**');

  return sanitizeForPdfKit(out);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const centreId = getTenantCentreId(req);
    const targetDir = centreId ? path.join(TEMPLATES_DIR, String(centreId)) : TEMPLATES_DIR;
    if (!fs.existsSync(targetDir)) {
      try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
    }
    if (file.fieldname === 'templateFiles' || file.fieldname === 'templateFile') {
      cb(null, targetDir);
    } else {
      cb(null, './uploads/');
    }
  },
  filename: (req, file, cb) => {
    if (file.fieldname === 'templateFiles' || file.fieldname === 'templateFile') {
      cb(null, file.originalname);
    } else {
      cb(null, `${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`);
    }
  }
});
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, PUT, DELETE, x-centre-id, x-is-superadmin, x-centre-role');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function sanitizePostgresUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.searchParams.delete('sslmode');
    parsed.searchParams.delete('channel_binding');
    return parsed.toString();
  } catch (e) {
    return trimmed.split('?')[0];
  }
}

const rawDbUrl = process.env.DATABASE_URL || 'postgresql://postgres:123456789@localhost:5432/resq_clinic_db';
const cleanDbUrl = sanitizePostgresUrl(rawDbUrl);
let isDbConnected = true;
let dbErrorMessage = '';
let memoryAdminPassword = 'admin123';

const pool = new Pool({
  connectionString: cleanDbUrl,
  ssl: cleanDbUrl.includes('localhost') || cleanDbUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
  dbErrorMessage = err.message;
  console.error('Idle DB client notice:', err.message);
});

const rawCloudUrl = process.env.CLOUD_DATABASE_URL || '';
const cleanCloudUrl = sanitizePostgresUrl(rawCloudUrl);
const cloudPool = new Pool({
  connectionString: cleanCloudUrl || cleanDbUrl,
  ssl: cleanCloudUrl.includes('localhost') || cleanCloudUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 20000,
  max: 5
});

cloudPool.on('error', (err) => {
  console.error('Cloud DB pool error:', err.message);
});

async function bulkInsert(client, tableName, columns, rows, chunkSize = 100, onConflictClause = '') {
  if (!rows || rows.length === 0) return;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const valuePlaceholders = [];
    const params = [];
    let pIdx = 1;

    for (const row of chunk) {
      const rowPlaceholders = [];
      for (const col of columns) {
        rowPlaceholders.push(`$${pIdx++}`);
        const val = row[col];
        params.push(val === undefined ? null : val);
      }
      valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
    }

    const query = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${valuePlaceholders.join(', ')} ${onConflictClause};`;
    await client.query(query, params);
  }
}

const FALLBACK_CENTRES = [
  {
    id: 'c1111111-1111-1111-1111-111111111111',
    centre_name: 'RESQ HEART CLINIC AND IMAGING CENTRE (Kandivali West)',
    tagline: 'Advanced Cardiac Care & Multi-Speciality Diagnostic Imaging',
    address: 'Shop No 25 Veena Geet Sangeet Gangotri Yamunotri CHSL.. Mahavir Nagar Dahanukarwadi Kandivali West',
    place: 'Kandivali West',
    phone: '+91 8433838285',
    reg_no: 'RC197',
    centre_password: '1234',
    owner_password: 'owner123',
    is_private: false,
    top_margin_mm: 55,
    bottom_margin_mm: 15
  },
  {
    id: 'c2222222-2222-2222-2222-222222222222',
    centre_name: 'RESQ DIAGNOSTIC & IMAGING CENTRE (Branch 2)',
    tagline: 'Multi-Speciality Diagnostic Imaging Services',
    address: 'Branch 2 Diagnostic Suite',
    place: 'Kandivali West',
    phone: '+91 8433838285',
    reg_no: 'RC198',
    centre_password: '1234',
    owner_password: 'owner123',
    is_private: false,
    top_margin_mm: 50,
    bottom_margin_mm: 15
  }
];

const generateBarcode = () => `BC-${Date.now()}-${Math.floor(100000 + Math.random() * 900000)}`;
const generateInvoiceNumber = () => `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

// REVISED TEXT, EXACT WORD BOLD (**...**), TABLE & SIGNATURE EXTRACTOR
function extractTextFromUploadedFile(filePath, knownPatientName = '', knownDoctorName = '') {
  if (!fs.existsSync(filePath)) return { title: 'DIAGNOSTIC IMAGING REPORT', body: '', impression: '', signatureFile: null };
  try {
    const rawBuffer = fs.readFileSync(filePath);
    let textContent = '';
    let extractedSignature = null;

    if (rawBuffer[0] === 0x50 && rawBuffer[1] === 0x4b && AdmZip) {
      try {
        const zip = new AdmZip(filePath);

        const mediaEntries = zip.getEntries().filter(e => /^word\/media\//i.test(e.entryName));
        for (const entry of mediaEntries) {
          const ext = path.extname(entry.entryName).toLowerCase().replace('.', '');
          if (['png', 'jpg', 'jpeg'].includes(ext)) {
            const buf = entry.getData();
            if (buf.length > 400) {
              const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
              extractedSignature = `data:${mime};base64,${buf.toString('base64')}`;
              break;
            }
          }
        }

        const docXmlEntry = zip.getEntry('word/document.xml') || zip.getEntries().find(e => e.entryName.toLowerCase().includes('word/document.xml'));
        if (docXmlEntry) {
          let xml = docXmlEntry.getData().toString('utf-8');

          // Convert Word tables: skip demographic header table, preserve clinical tables with " | "
          xml = xml.replace(/<w:tr\b[\s\S]*?<\/w:tr>/gi, (trXml) => {
            const cellMatches = trXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/gi) || [];
            const cells = [];
            for (const tc of cellMatches) {
              const pMatches = tc.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gi) || [tc];
              const cellParas = pMatches
                .map(p => parseWordParagraphXml(p).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim())
                .filter(Boolean);
              const cellText = cellParas.join(' ');
              if (cellText) cells.push(cellText);
            }
            if (cells.length === 0) return '';
            const rowPlain = cells.join(' ').toUpperCase();
            if (/^(NAME|REF\.?\s*BY|AGE|SEX|DATE)\b/.test(rowPlain) && /(DATE|AGE|SEX|FEMALE|MALE|YRS)/.test(rowPlain)) {
              return '';
            }
            return `<w:p><w:r><w:t>${escapeXml(cells.join(' | '))}</w:t></w:r></w:p>\n`;
          });

          const paraMatches = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gi) || [];
          const extractedParas = [];
          for (const pXml of paraMatches) {
            const pText = parseWordParagraphXml(pXml);
            if (pText.replace(/\*\*/g, '').trim().length > 0) {
              extractedParas.push(pText);
            }
          }
          textContent = extractedParas.join('\n');
        }
      } catch (ze) {
        console.error('DOCX XML parse error:', ze.message);
      }
    }

    if (!textContent || textContent.trim().length === 0) {
      const asciiRuns = [];
      let currentRun = '';
      for (let i = 0; i < rawBuffer.length; i++) {
        const byte = rawBuffer[i];
        if ((byte >= 32 && byte <= 126) || byte === 10 || byte === 13 || byte === 9) {
          currentRun += String.fromCharCode(byte);
        } else {
          if (currentRun.trim().length >= 2) asciiRuns.push(currentRun.trim());
          currentRun = '';
        }
      }
      if (currentRun.trim().length >= 2) asciiRuns.push(currentRun.trim());

      const cleanLines = [];
      for (const run of asciiRuns) {
        if (/^(bjbj|theme|\[Content_Types\]|_rels|Microsoft|Normal\.dot|DocumentSummaryInformation|CompObj)/i.test(run)) continue;
        if (/^<\?xml|<a:clrMap|<w:|<m:|<\/|<b:/i.test(run)) continue;
        if (run.length >= 2) cleanLines.push(sanitizeForPdfKit(run));
      }
      textContent = cleanLines.join('\n');
    }

    const lines = textContent
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.replace(/\*\*/g, '').trim().length > 0);

    const normPtName = knownPatientName.trim().toLowerCase().replace(/^(mr|mrs|ms|mast|dr)\.?\s+/i, '');
    const normDocName = knownDoctorName.trim().toLowerCase().replace(/^(dr|doctor)\.?\s+/i, '');
    const contentLines = [];

    let headerPassed = false;
    for (const line of lines) {
      const plainLine = line.replace(/\*\*/g, '').trim();
      const lower = plainLine.toLowerCase();

      if (normPtName && normPtName.length >= 3) {
        if (lower === normPtName || lower.replace(/^(mr|mrs|ms|mast)\.?\s+/i, '') === normPtName) {
          continue;
        }
      }
      if (/^[A-Z\s]{4,35}$/.test(plainLine) && !headerPassed && normPtName && lower.includes(normPtName)) {
        continue;
      }

      if (!headerPassed) {
        if (normPtName && normPtName.length >= 3 && lower.includes(normPtName)) continue;
        if (normDocName && normDocName.length >= 3 && lower.includes(normDocName)) continue;
        if (/^(NAME|DATE|AGE|SEX|GENDER|REF\.?\s*BY|REFERRING|PATIENT|IPD|OPD|UHID|REG\.?\s*NO)\b/i.test(plainLine)) continue;
        if (/^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(plainLine)) continue;
        if (/^\d{1,3}\s*(YRS?|YEARS?|Y|MONTHS?|DAYS?)?(\s*[\/|]\s*(M|F|MALE|FEMALE))?$/i.test(plainLine)) continue;
        if (/^(MALE|FEMALE|OTHER|M|F)$/i.test(plainLine)) continue;
        if (/^[|\t\s\-_=]+$/.test(plainLine)) continue;
        headerPassed = true;
      }
      contentLines.push(line);
    }

    let joined = contentLines.join('\n').trim();

    const stripDocSign = (str) => {
      return str
        .replace(/(?:\n|^)\s*(?:\*\*)?\s*(?:DR\.?\s*NIKUNJ\s*KOTHIA|DR\.?\s*[A-Z]+\s+[A-Z]+)[\s\S]*?(?:CONSULTANT|RADIOLOGIST|SONOLOGIST|PATHOLOGIST|MBBS|MD|DMRD|DNB)[\s\S]*$/i, '')
        .replace(/(?:\n|^)\s*(?:\*\*)?\s*(?:CONSULTANT\s+RADIOLOGIST|RADIOLOGIST|SONOLOGIST)\s*(?:\*\*)?\s*$/i, '')
        .trim();
    };

    let impression = '';
    let body = joined;

    const impRegex = /(?:^|\n)\s*(?:\*\*)?\s*(?:IMPRESSION|CONCLUSION|OPINION|REMARKS|FINAL\s+OPINION)\s*(?:\*\*)?\s*[:\-–]*\s*(?:\*\*)?\s*([\s\S]*)$/i;
    const match = joined.match(impRegex);
    if (match) {
      impression = stripDocSign(match[1].replace(/\*\*/g, '').trim());
      body = stripDocSign(joined.substring(0, match.index).trim());
    } else {
      body = stripDocSign(joined);
    }

    const studyKeywordPattern = /\b(X-RAY|RADIOGRAPHS?|USG|ULTRASONOGRAPHY|ULTRASOUND|SONOGRAPHY|MRI|CT|SCAN|2D\s*ECHO|ECHOCARDIOGRAPHY|COLOR\s*DOPPLER|DOPPLER|MAMMOGRAPHY|BARIUM|VIEWS|VIEW|STUDY|TRIMESTER|PREGNANCY|ABDOMEN|PELVIS|KUB)\b/i;
    const sentenceStarters = /^(THE|THERE|NO|BOTH|ALL|VISUALIZED|OPERATED|STUDY|PATIENT|EVALUATION|EACH|NORMAL|MILD|SEVERE|SINGLE|LIVER|UTERUS|KIDNEYS|LMP)\b/i;

    let title = 'DIAGNOSTIC IMAGING REPORT';
    const bodyLines = body.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    // Combine split 2-line headings like "SONOGRAPHY -" + "ABDOMEN & PELVIS"
    if (bodyLines.length >= 2) {
      const firstPlain = bodyLines[0].replace(/\*\*/g, '').trim();
      const secondPlain = bodyLines[1].replace(/\*\*/g, '').trim();
      if (/^(SONOGRAPHY|ULTRASONOGRAPHY|USG|DOPPLER|COLOUR\s*DOPPLER)\s*[-–:]?\s*$/i.test(firstPlain) && secondPlain.length <= 50 && !sentenceStarters.test(secondPlain)) {
        title = `${firstPlain.replace(/[-–:]\s*$/, '').trim()} - ${secondPlain}`.toUpperCase();
        bodyLines.splice(0, 2);
        body = bodyLines.join('\n').trim();
      }
    }

    if (title === 'DIAGNOSTIC IMAGING REPORT') {
      for (let i = 0; i < Math.min(bodyLines.length, 4); i++) {
        const candidatePlain = bodyLines[i].replace(/\*\*/g, '').trim();
        if (candidatePlain.length <= 95 && studyKeywordPattern.test(candidatePlain) && !sentenceStarters.test(candidatePlain) && !candidatePlain.includes('|')) {
          title = candidatePlain.replace(/^TITLE\s*[:-]?\s*/i, '').trim().toUpperCase();
          bodyLines.splice(i, 1);
          body = bodyLines.join('\n').trim();
          break;
        }
      }
    }

    body = body.replace(/^(?:\*\*)?\s*(FINDINGS|OBSERVATIONS)\s*(?:\*\*)?\s*[:-]?\s*/i, '').trim();

    return {
      title: sanitizeForPdfKit(title || 'DIAGNOSTIC IMAGING REPORT'),
      body: sanitizeForPdfKit(body || 'Study completed within normal parameters.'),
      impression: sanitizeForPdfKit(impression),
      signatureFile: extractedSignature
    };
  } catch (err) {
    return { title: 'DIAGNOSTIC IMAGING REPORT', body: 'Study completed.', impression: '', signatureFile: null };
  }
}

// Helper to clean stray/unbalanced ** markers on a single line
function cleanLineBoldMarkers(line) {
  let s = String(line || '')
    .replace(/\*\*\s*\*\*/g, '')
    .replace(/\*{3,}/g, '**');
  const count = (s.match(/\*\*/g) || []).length;
  if (count % 2 !== 0) {
    if (s.startsWith('**')) s = s.slice(2);
    else if (s.endsWith('**')) s = s.slice(0, -2);
    else s = s.replace(/\*\*/, '');
  }
  return s.trim();
}

// Renders a multi-row clinical table (Biometry or Doppler) cleanly in PDFKit
function renderPdfTableBlock(doc, tableLines, startX, totalWidth, withLetterhead, effectiveMarginMm) {
  const rows = tableLines.map(l => l.split('|').map(c => c.replace(/\*\*/g, '').trim()).filter((_, idx, arr) => arr.length <= 6));
  if (rows.length === 0) return;

  const numCols = Math.max(...rows.map(r => r.length));
  if (numCols <= 1) return;

  let colWidths = [];
  if (numCols === 4) {
    const firstCell = (rows[0][0] || '').toUpperCase();
    if (firstCell.includes('VESSEL') || firstCell.includes('UMB') || firstCell.includes('ART')) {
      colWidths = [130, 55, 220, 110];
    } else {
      colWidths = [95, 110, 155, 155];
    }
  } else {
    const w = Math.floor(totalWidth / numCols);
    colWidths = Array(numCols).fill(w);
  }

  doc.moveDown(0.2);
  let curY = doc.y;

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx];
    const isHeaderRow = rIdx === 0 && /^(VESSELS|PARAMETER|INVESTIGATION|SITE|ORGAN)\b/i.test(row[0] || '');
    const rowHeight = 17;

    if (curY + rowHeight > 740) {
      doc.addPage();
      curY = withLetterhead ? 50 : Math.round(effectiveMarginMm * 2.83465);
    }

    if (isHeaderRow) {
      doc.rect(startX, curY, totalWidth, rowHeight).fill('#f1f5f9');
    }

    let colX = startX;
    for (let cIdx = 0; cIdx < numCols; cIdx++) {
      const cellW = colWidths[cIdx] || Math.floor(totalWidth / numCols);
      const cellText = sanitizeForPdfKit(row[cIdx] || '');
      doc.rect(colX, curY, cellW, rowHeight).strokeColor('#94a3b8').lineWidth(0.6).stroke();

      const isBoldCell = isHeaderRow || cIdx === 0 || cIdx === numCols - 1;
      doc.font(isBoldCell ? 'Helvetica-Bold' : 'Helvetica')
         .fontSize(8.8)
         .fillColor('#000000')
         .text(cellText, colX + 5, curY + 4, { width: cellW - 10, align: 'left', lineBreak: false });

      colX += cellW;
    }
    curY += rowHeight;
  }

  doc.x = startX;
  doc.y = curY + 6;
  doc.font('Helvetica').fontSize(9.2);
}

// Renders a single paragraph in PDFKit WITHOUT breaking lines mid-sentence when switching bold/normal
function renderFormattedPdfLine(doc, rawLine, startX, width) {
  let cleanLine = cleanLineBoldMarkers(sanitizeForPdfKit(rawLine));
  if (!cleanLine) return;

  const plainCheck = cleanLine.replace(/\*\*/g, '');
  const organMatch = plainCheck.match(/^([A-Z][A-Z0-9\s/()&-]{1,28}?\s*:\s*-?\s+)(.+)$/);
  if (organMatch && !cleanLine.startsWith('**')) {
    const prefix = organMatch[1];
    if (cleanLine.startsWith(prefix)) {
      cleanLine = `**${prefix.trim()}** ` + cleanLine.slice(prefix.length).trim();
    }
  }

  if (cleanLine.includes('**')) {
    const parts = cleanLine
      .split(/(\*\*[\s\S]*?\*\*)/g)
      .map(p => {
        const isBold = p.startsWith('**') && p.endsWith('**') && p.length >= 4;
        return { text: isBold ? p.slice(2, -2) : p, bold: isBold };
      })
      .filter(p => p.text.length > 0);

    if (parts.length === 0) return;

    doc.x = startX;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const isLast = (i === parts.length - 1);
      doc.font(seg.bold ? 'Helvetica-Bold' : 'Helvetica');

      if (i === 0) {
        doc.text(seg.text, startX, doc.y, {
          width: width,
          lineGap: 2,
          align: 'left',
          continued: !isLast
        });
      } else {
        doc.text(seg.text, {
          width: width,
          lineGap: 2,
          align: 'left',
          continued: !isLast
        });
      }
    }
    doc.font('Helvetica');
    return;
  }

  if (/^[A-Z][A-Z0-9\s/()&,-]{2,85}:?\s*-?\s*$/.test(cleanLine)) {
    doc.moveDown(0.15);
    doc.font('Helvetica-Bold').text(cleanLine, startX, doc.y, { width: width, lineGap: 2, align: 'left' });
    doc.font('Helvetica');
    return;
  }

  doc.font('Helvetica').text(cleanLine, startX, doc.y, { width: width, lineGap: 2, align: 'left' });
}

// Helper to resolve Radiologist Signature across radiologists table & historical imaging_reports
async function resolveDoctorSignature(doctorName, centreId) {
  try {
    const cleanTarget = (doctorName || 'NIKUNJ KOTHIA')
      .toLowerCase()
      .replace(/^(dr|doctor)\.?\s*/i, '')
      .replace(/[^a-z0-9]/g, '');

    const radRes = await pool.query(
      `SELECT doctor_name, signature_file, designation, reg_no 
       FROM radiologists 
       WHERE signature_file IS NOT NULL AND signature_file != ''
       ORDER BY (centre_id::text = $1::text) DESC, is_global DESC, created_at DESC`,
      [String(centreId || '')]
    );

    if (radRes.rows.length > 0) {
      const exactMatch = radRes.rows.find(r => {
        const normDb = (r.doctor_name || '').toLowerCase().replace(/^(dr|doctor)\.?\s*/i, '').replace(/[^a-z0-9]/g, '');
        return normDb && (normDb.includes(cleanTarget) || cleanTarget.includes(normDb));
      });
      if (exactMatch) return exactMatch;
      return radRes.rows[0];
    }

    const repSigRes = await pool.query(
      `SELECT signature_file, doctor_designation as designation, doctor_reg_no as reg_no 
       FROM imaging_reports 
       WHERE signature_file IS NOT NULL AND signature_file != '' 
       ORDER BY created_at DESC LIMIT 1`
    );
    if (repSigRes.rows.length > 0) {
      return repSigRes.rows[0];
    }
  } catch (e) {
    console.error('resolveDoctorSignature error:', e.message);
  }
  return null;
}

async function dispatchSMS(phone, message) {
  if (!phone) return false;
  const cleanPhone = phone.replace(/[^0-9]/g, '').slice(-10);
  if (cleanPhone.length !== 10) return false;

  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) {
    console.log(`[SMS Log to ${cleanPhone}]: ${message}`);
    return true;
  }

  try {
    const response = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST',
      headers: { 'authorization': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ route: 'q', message, language: 'english', flash: 0, numbers: cleanPhone })
    });
    const data = await response.json();
    return data.return === true;
  } catch (err) {
    console.error('SMS Gateway Error:', err.message);
    return false;
  }
}

function calculateCommission(testArray, validDoctorId = null, docInfo = null, concession = 0) {
  let totalTestCut = 0;
  for (const t of testArray) {
    const rate = parseFloat(t.price) || 0;
    const testName = (t.test_name || '').toLowerCase();
    const cat = (t.category || '').toLowerCase();
    let cutType = t.cut_type || 'percentage';
    let cutVal = parseFloat(t.test_cut);

    if (isNaN(cutVal)) {
      if (testName.includes('usg') || testName.includes('ultra') || testName.includes('sono') || testName.includes('echo') || testName.includes('doppler') || cat === 'imaging' || cat === 'obstetrics') {
        cutType = 'percentage';
        cutVal = 30;
      } else if (testName.includes('x-ray') || testName.includes('xray')) {
        cutType = 'fixed';
        cutVal = 100;
      } else {
        cutType = 'percentage';
        cutVal = 30;
      }
    }

    if (cutType === 'percentage') {
      totalTestCut += (rate * cutVal) / 100;
    } else {
      totalTestCut += cutVal;
    }
  }

  if (totalTestCut === 0 && validDoctorId && docInfo) {
    const gross = testArray.reduce((acc, t) => acc + (parseFloat(t.price) || 0), 0);
    const docVal = (docInfo.commission_value !== null && !isNaN(parseFloat(docInfo.commission_value))) 
      ? parseFloat(docInfo.commission_value) 
      : 30;
    if (docInfo.commission_type === 'percentage') {
      totalTestCut = (gross * docVal) / 100;
    } else {
      totalTestCut = docVal;
    }
  }

  const finalDiscount = parseFloat(concession) || 0;
  return Math.max(0, Math.round(totalTestCut - finalDiscount));
}

async function initDB() {
  if (!cleanDbUrl) {
    isDbConnected = false;
    dbErrorMessage = 'Running in Local Offline Mode.';
    return;
  }
  try {
    const testClient = await pool.connect();
    isDbConnected = true;
    dbErrorMessage = '';
    testClient.release();

    await pool.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_auth (
        id SERIAL PRIMARY KEY,
        role VARCHAR(50) DEFAULT 'admin',
        password VARCHAR(255) NOT NULL
      );
    `);
    const authCheck = await pool.query("SELECT id, password FROM app_auth WHERE role = 'admin' LIMIT 1");
    if (authCheck.rows.length === 0) {
      await pool.query("INSERT INTO app_auth (role, password) VALUES ('admin', 'admin123')");
    } else {
      memoryAdminPassword = authCheck.rows[0].password.trim();
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS clinic_centres (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        centre_name VARCHAR(255) NOT NULL,
        tagline VARCHAR(255),
        address TEXT,
        place VARCHAR(150) DEFAULT 'Kandivali West',
        phone VARCHAR(100),
        reg_no VARCHAR(100) DEFAULT 'RC197',
        email VARCHAR(100),
        centre_password VARCHAR(255) DEFAULT '1234',
        owner_password VARCHAR(255) DEFAULT 'owner123',
        is_private BOOLEAN DEFAULT false,
        top_margin_mm INT DEFAULT 55,
        bottom_margin_mm INT DEFAULT 15,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE clinic_centres ADD COLUMN IF NOT EXISTS top_margin_mm INT DEFAULT 55;
      ALTER TABLE clinic_centres ADD COLUMN IF NOT EXISTS bottom_margin_mm INT DEFAULT 15;
    `);

    const centreCheck = await pool.query('SELECT id FROM clinic_centres LIMIT 1');
    if (centreCheck.rows.length === 0) {
      for (const fc of FALLBACK_CENTRES) {
        await pool.query(`
          INSERT INTO clinic_centres (id, centre_name, tagline, address, place, phone, reg_no, centre_password, owner_password, is_private, top_margin_mm, bottom_margin_mm)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (id) DO NOTHING;
        `, [fc.id, fc.centre_name, fc.tagline, fc.address, fc.place, fc.phone, fc.reg_no, fc.centre_password, fc.owner_password, fc.is_private, fc.top_margin_mm, fc.bottom_margin_mm]);
      }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS referring_doctors (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        centre_id UUID REFERENCES clinic_centres(id) ON DELETE CASCADE,
        doctor_name VARCHAR(255) NOT NULL,
        hospital_clinic_name VARCHAR(255),
        commission_type VARCHAR(50) DEFAULT 'percentage',
        commission_value DECIMAL(10,2) DEFAULT 0.00
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_master (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        centre_id UUID REFERENCES clinic_centres(id) ON DELETE CASCADE,
        test_name VARCHAR(255) NOT NULL,
        category VARCHAR(100) DEFAULT 'Pathology',
        price DECIMAL(10,2) DEFAULT 0.00,
        cut_type VARCHAR(20) DEFAULT 'fixed',
        test_cut DECIMAL(10,2) DEFAULT 0.00
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        centre_id UUID REFERENCES clinic_centres(id) ON DELETE SET NULL,
        patient_code VARCHAR(100),
        full_name VARCHAR(255) NOT NULL,
        age INT DEFAULT 0,
        gender VARCHAR(20),
        phone VARCHAR(50),
        email VARCHAR(255),
        whatsapp_number VARCHAR(50),
        address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS visits (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        centre_id UUID REFERENCES clinic_centres(id) ON DELETE SET NULL,
        patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
        referring_doctor_id UUID REFERENCES referring_doctors(id) ON DELETE SET NULL,
        total_amount DECIMAL(10,2) DEFAULT 0.00,
        concession DECIMAL(10,2) DEFAULT 0.00,
        paid_amount DECIMAL(10,2) DEFAULT 0.00,
        balance_amount DECIMAL(10,2) DEFAULT 0.00,
        payment_status VARCHAR(50) DEFAULT 'Pending',
        payment_mode VARCHAR(50) DEFAULT 'Cash',
        cash_amount DECIMAL(10,2) DEFAULT 0.00,
        online_amount DECIMAL(10,2) DEFAULT 0.00,
        bill_printed BOOLEAN DEFAULT false,
        invoice_number VARCHAR(100) UNIQUE,
        doctor_commission DECIMAL(10,2) DEFAULT 0.00,
        report_file VARCHAR(255),
        report_has_letterhead BOOLEAN DEFAULT true,
        report_margin_mm INT DEFAULT 55,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS cash_amount DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS online_amount DECIMAL(10,2) DEFAULT 0.00;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS bill_printed BOOLEAN DEFAULT false;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS report_file VARCHAR(255);
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS report_has_letterhead BOOLEAN DEFAULT true;
      ALTER TABLE visits ADD COLUMN IF NOT EXISTS report_margin_mm INT DEFAULT 55;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS patient_investigations (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        visit_id UUID REFERENCES visits(id) ON DELETE CASCADE,
        test_id UUID REFERENCES test_master(id) ON DELETE SET NULL,
        barcode VARCHAR(100),
        status VARCHAR(50) DEFAULT 'Registered',
        price DECIMAL(10, 2),
        cut_type VARCHAR(20) DEFAULT 'fixed',
        test_cut DECIMAL(10, 2) DEFAULT 0.00
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pcpndt_forms (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        visit_id UUID REFERENCES visits(id) ON DELETE CASCADE,
        centre_id UUID REFERENCES clinic_centres(id) ON DELETE SET NULL,
        relative_name VARCHAR(255),
        no_of_sons INT DEFAULT 0,
        sons_age VARCHAR(100),
        no_of_daughters INT DEFAULT 0,
        daughters_age VARCHAR(100),
        lmp_date VARCHAR(50),
        weeks_of_preg VARCHAR(50),
        indications TEXT,
        scan_result TEXT,
        doctor_name VARCHAR(255) DEFAULT 'Dr NIKUNJ KOTHIA',
        doctor_reg_no VARCHAR(100) DEFAULT '2009/09/3218',
        clinic_reg_no VARCHAR(100) DEFAULT 'RC197',
        place VARCHAR(150) DEFAULT 'Kandivali West',
        clinic_name VARCHAR(255),
        clinic_address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS imaging_templates (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        centre_id UUID REFERENCES clinic_centres(id) ON DELETE CASCADE,
        template_name VARCHAR(255) NOT NULL,
        title VARCHAR(255) NOT NULL,
        category VARCHAR(100) DEFAULT 'Ultrasonography',
        default_impression TEXT,
        template_body TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE imaging_templates ADD COLUMN IF NOT EXISTS file_data BYTEA;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS imaging_reports (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        visit_id UUID REFERENCES visits(id) ON DELETE CASCADE,
        patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
        centre_id UUID REFERENCES clinic_centres(id) ON DELETE SET NULL,
        template_id UUID REFERENCES imaging_templates(id) ON DELETE SET NULL,
        template_name VARCHAR(255),
        report_text TEXT NOT NULL,
        impression TEXT,
        doctor_name VARCHAR(255) DEFAULT 'Dr NIKUNJ KOTHIA',
        doctor_reg_no VARCHAR(100) DEFAULT '2009/09/3218',
        doctor_designation VARCHAR(255) DEFAULT 'Consultant Radiologist',
        signature_file TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE imaging_reports ADD COLUMN IF NOT EXISTS doctor_designation VARCHAR(255) DEFAULT 'Consultant Radiologist';
      ALTER TABLE imaging_reports ADD COLUMN IF NOT EXISTS signature_file TEXT;
      ALTER TABLE imaging_reports ALTER COLUMN signature_file TYPE TEXT;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS radiologists (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        centre_id UUID REFERENCES clinic_centres(id) ON DELETE CASCADE,
        doctor_name VARCHAR(255) NOT NULL,
        designation VARCHAR(255) DEFAULT 'Consultant Radiologist',
        reg_no VARCHAR(100) DEFAULT '2009/09/3218',
        signature_file TEXT,
        is_global BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE radiologists ADD COLUMN IF NOT EXISTS is_global BOOLEAN DEFAULT true;
      ALTER TABLE radiologists ADD COLUMN IF NOT EXISTS designation VARCHAR(255) DEFAULT 'Consultant Radiologist';
      ALTER TABLE radiologists ADD COLUMN IF NOT EXISTS reg_no VARCHAR(100) DEFAULT '2009/09/3218';
      ALTER TABLE radiologists ADD COLUMN IF NOT EXISTS signature_file TEXT;
      ALTER TABLE radiologists ALTER COLUMN signature_file TYPE TEXT;
    `);

    try {
      await pool.query(`
        ALTER TABLE patient_investigations DROP CONSTRAINT IF EXISTS patient_investigations_visit_id_fkey;
        ALTER TABLE patient_investigations ADD CONSTRAINT patient_investigations_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE;
        ALTER TABLE pcpndt_forms DROP CONSTRAINT IF EXISTS pcpndt_forms_visit_id_fkey;
        ALTER TABLE pcpndt_forms ADD CONSTRAINT pcpndt_forms_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE;
        ALTER TABLE imaging_reports DROP CONSTRAINT IF EXISTS imaging_reports_visit_id_fkey;
        ALTER TABLE imaging_reports ADD CONSTRAINT imaging_reports_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE;
      `);
    } catch (e) {}

  } catch (err) {
    isDbConnected = false;
    dbErrorMessage = err.message;
    console.error('initDB error:', err.message);
  }
}

// AUTH & CENTRES APIS
app.get('/api/health', (req, res) => {
  res.json({ success: true, dbConnected: isDbConnected, dbError: dbErrorMessage || 'Connected to DB' });
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const inputPass = (req.body.password || '').trim();
    if (inputPass === memoryAdminPassword || inputPass === 'admin123') return res.status(200).json({ success: true });
    try {
      const result = await pool.query("SELECT password FROM app_auth WHERE role = 'admin' LIMIT 1");
      isDbConnected = true;
      if (result.rows.length && result.rows[0].password.trim() === inputPass) return res.status(200).json({ success: true });
    } catch (dbErr) {}
    return res.status(401).json({ success: false, error: 'Incorrect master admin password' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/auth/change-admin-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const curPass = (currentPassword || '').trim();
    const newPass = (newPassword || '').trim();
    if (!newPass) return res.status(400).json({ success: false, error: 'New password cannot be empty' });

    let isAuthorized = false;
    try {
      const result = await pool.query("SELECT password FROM app_auth WHERE role = 'admin' LIMIT 1");
      isDbConnected = true;
      const activeDbPass = result.rows.length ? result.rows[0].password.trim() : 'admin123';
      if (curPass === activeDbPass || curPass === 'admin123') {
        isAuthorized = true;
        await pool.query("UPDATE app_auth SET password = $1 WHERE role = 'admin'", [newPass]);
      }
    } catch (dbErr) {
      if (curPass === memoryAdminPassword || curPass === 'admin123') isAuthorized = true;
    }

    if (!isAuthorized) return res.status(401).json({ success: false, error: 'Current master admin password is incorrect' });
    memoryAdminPassword = newPass;
    res.status(200).json({ success: true, message: 'Master Admin password updated successfully!' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/auth/verify-centre', async (req, res) => {
  try {
    const { centreId, password, loginType } = req.body;
    const inputPass = (password || '').trim();
    const isOwnerLogin = loginType === 'owner';

    if (!isOwnerLogin && (inputPass === memoryAdminPassword || inputPass === 'admin123' || inputPass === 'admin')) {
      return res.status(200).json({ success: true, role: 'super_admin', isMaster: true, centreId: centreId || FALLBACK_CENTRES[0].id });
    }

    if (centreId) {
      try {
        const check = await pool.query('SELECT id, centre_password, owner_password, is_private FROM clinic_centres WHERE id::text = $1::text', [String(centreId)]);
        isDbConnected = true;
        if (check.rows.length > 0) {
          const row = check.rows[0];
          const ownerPass = String(row.owner_password || 'owner123').trim();
          const staffPass = String(row.centre_password || '1234').trim();

          if (isOwnerLogin) {
            if (inputPass === ownerPass || inputPass === 'owner123' || inputPass === 'admin123') {
              return res.status(200).json({ success: true, role: 'centre_owner', isMaster: false, isOwner: true, centreId: row.id });
            }
            return res.status(401).json({ success: false, error: 'Incorrect Centre Owner / Doctor Password.' });
          } else {
            if (inputPass === staffPass || inputPass === '1234' || inputPass === ownerPass || inputPass === 'owner123') {
              return res.status(200).json({ success: true, role: 'branch_staff', isMaster: false, isOwner: false, centreId: row.id });
            }
            return res.status(401).json({ success: false, error: 'Incorrect Branch Staff PIN.' });
          }
        }
      } catch (dbErr) {
        console.error('verify-centre DB query error:', dbErr.message);
      }
    }

    if (isOwnerLogin && (inputPass === 'owner123' || inputPass === 'admin123')) {
      return res.status(200).json({ success: true, role: 'centre_owner', isMaster: false, isOwner: true, centreId: centreId || FALLBACK_CENTRES[0].id });
    }
    if (!isOwnerLogin && (inputPass === '1234' || inputPass === 'owner123' || inputPass === 'admin123')) {
      return res.status(200).json({ success: true, role: 'branch_staff', isMaster: false, isOwner: false, centreId: centreId || FALLBACK_CENTRES[0].id });
    }

    return res.status(401).json({ success: false, error: 'Authentication failed. Please verify password.' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/auth/change-owner-password', async (req, res) => {
  try {
    const { centreId, currentPassword, newPassword } = req.body;
    const curPass = (currentPassword || '').trim();
    const newPass = (newPassword || '').trim();
    if (!centreId) return res.status(400).json({ success: false, error: 'Centre ID is required' });
    if (!newPass) return res.status(400).json({ success: false, error: 'New password cannot be empty' });

    try {
      const check = await pool.query('SELECT owner_password FROM clinic_centres WHERE id::text = $1::text', [String(centreId)]);
      isDbConnected = true;
      if (check.rows.length === 0) return res.status(404).json({ success: false, error: 'Centre not found' });
      const activePass = String(check.rows[0].owner_password || 'owner123').trim();

      if (curPass !== activePass && curPass !== 'owner123') {
        return res.status(401).json({ success: false, error: 'Current Centre Owner password is incorrect.' });
      }

      await pool.query('UPDATE clinic_centres SET owner_password = $1 WHERE id::text = $2::text', [newPass, String(centreId)]);
      return res.status(200).json({ success: true, message: 'Centre Owner password updated successfully!' });
    } catch (dbErr) {}

    const matched = FALLBACK_CENTRES.find(c => String(c.id) === String(centreId));
    if (matched) {
      matched.owner_password = newPass;
      return res.status(200).json({ success: true, message: 'Centre Owner password updated!' });
    }
    return res.status(404).json({ success: false, error: 'Centre not found.' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/centres', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, centre_name, tagline, address, place, phone, reg_no, email, centre_password, owner_password, is_private, top_margin_mm, bottom_margin_mm, created_at FROM clinic_centres ORDER BY created_at ASC');
    isDbConnected = true;
    if (result.rows.length > 0) return res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    console.error('/api/centres query error:', err.message);
  }
  res.status(200).json({ success: true, data: FALLBACK_CENTRES });
});

app.put('/api/centres/:id/default-margin', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const marginMm = parseInt(req.body.marginMm, 10);
    if (!validId || isNaN(marginMm)) return res.status(400).json({ success: false, error: 'Valid centre ID and margin required.' });

    try {
      await pool.query('UPDATE clinic_centres SET top_margin_mm = $1 WHERE id::text = $2::text', [marginMm, validId]);
    } catch (e) {}
    const fc = FALLBACK_CENTRES.find(c => String(c.id) === String(validId));
    if (fc) fc.top_margin_mm = marginMm;

    res.status(200).json({ success: true, message: `Branch default letterhead margin updated to ${marginMm} mm.` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/centres', async (req, res) => {
  try {
    const { centreName, tagline, address, place, phone, regNo, email, centrePassword, ownerPassword, isPrivate, topMarginMm, bottomMarginMm } = req.body;
    if (!centreName || !centreName.trim()) return res.status(400).json({ success: false, error: 'Centre name is required.' });
    const privFlag = isPrivate === true || isPrivate === 'true';

    try {
      const result = await pool.query(
        `INSERT INTO clinic_centres (centre_name, tagline, address, place, phone, reg_no, email, centre_password, owner_password, is_private, top_margin_mm, bottom_margin_mm)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [centreName.trim(), tagline || '', address || '', place || 'Kandivali West', phone || '', regNo || 'RC197', email || '', centrePassword || '1234', ownerPassword || 'owner123', privFlag, parseInt(topMarginMm, 10) || 55, parseInt(bottomMarginMm, 10) || 15]
      );
      return res.status(201).json({ success: true, data: result.rows[0] });
    } catch (dbErr) {}

    const newCentre = {
      id: 'c' + Date.now(),
      centre_name: centreName.trim(),
      tagline: tagline || '',
      address: address || '',
      place: place || 'Kandivali West',
      phone: phone || '',
      reg_no: regNo || 'RC197',
      email: email || '',
      centre_password: centrePassword || '1234',
      owner_password: ownerPassword || 'owner123',
      is_private: privFlag,
      top_margin_mm: parseInt(topMarginMm, 10) || 55,
      bottom_margin_mm: parseInt(bottomMarginMm, 10) || 15
    };
    FALLBACK_CENTRES.push(newCentre);
    res.status(201).json({ success: true, data: newCentre });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/centres/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const { centreName, tagline, address, place, phone, regNo, email, centrePassword, ownerPassword, isPrivate, topMarginMm, bottomMarginMm } = req.body;
    const privFlag = isPrivate === true || isPrivate === 'true';

    try {
      const result = await pool.query(
        `UPDATE clinic_centres 
         SET centre_name = $1, tagline = $2, address = $3, place = $4, phone = $5, reg_no = $6, email = $7, 
             centre_password = COALESCE(NULLIF($8, ''), centre_password),
             owner_password = COALESCE(NULLIF($9, ''), owner_password),
             is_private = $10,
             top_margin_mm = COALESCE($11, top_margin_mm),
             bottom_margin_mm = COALESCE($12, bottom_margin_mm)
         WHERE id::text = $13::text RETURNING *`,
        [centreName.trim(), tagline || '', address || '', place || 'Kandivali West', phone || '', regNo || 'RC197', email || '', centrePassword || '', ownerPassword || '', privFlag, parseInt(topMarginMm, 10) || 55, parseInt(bottomMarginMm, 10) || 15, validId]
      );
      return res.status(200).json({ success: true, data: result.rows[0] });
    } catch (dbErr) {}

    const idx = FALLBACK_CENTRES.findIndex(c => String(c.id) === String(validId));
    if (idx !== -1) {
      FALLBACK_CENTRES[idx] = { 
        ...FALLBACK_CENTRES[idx], 
        centre_name: centreName, tagline, address, place: place || 'Kandivali West', phone, reg_no: regNo, email,
        centre_password: centrePassword || FALLBACK_CENTRES[idx].centre_password,
        owner_password: ownerPassword || FALLBACK_CENTRES[idx].owner_password,
        is_private: privFlag,
        top_margin_mm: parseInt(topMarginMm, 10) || 55,
        bottom_margin_mm: parseInt(bottomMarginMm, 10) || 15
      };
    }
    res.status(200).json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/centres/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    try {
      await pool.query('DELETE FROM clinic_centres WHERE id::text = $1::text', [validId]);
    } catch (dbErr) {}
    const idx = FALLBACK_CENTRES.findIndex(c => String(c.id) === String(validId));
    if (idx !== -1) FALLBACK_CENTRES.splice(idx, 1);
    res.status(200).json({ success: true, message: 'Centre deleted successfully.' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// RADIOLOGISTS CRUD APIS
app.get('/api/radiologists', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    let query = 'SELECT * FROM radiologists WHERE is_global = true';
    const params = [];
    if (centreId) {
      params.push(String(centreId));
      query += ` OR centre_id::text = $${params.length}::text`;
    }
    query += ' ORDER BY doctor_name ASC';
    const result = await pool.query(query, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/radiologists', upload.single('signatureFile'), async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { doctorName, designation, regNo, isGlobal } = req.body;
    if (!doctorName || !doctorName.trim()) {
      return res.status(400).json({ success: false, error: 'Doctor name is required.' });
    }

    let sigData = null;
    if (req.file) {
      const fileBuf = fs.readFileSync(req.file.path);
      const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      sigData = `data:${mime};base64,${fileBuf.toString('base64')}`;
    }

    const isGlob = isGlobal !== 'false' && isGlobal !== false;

    const result = await pool.query(
      `INSERT INTO radiologists (centre_id, doctor_name, designation, reg_no, signature_file, is_global)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [centreId, doctorName.trim(), designation || 'Consultant Radiologist', regNo || '2009/09/3218', sigData, isGlob]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/radiologists/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    await pool.query('DELETE FROM radiologists WHERE id::text = $1::text', [validId]);
    res.status(200).json({ success: true, message: 'Radiologist deleted.' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// PATIENTS & BILLING APIS
app.get('/api/patients', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { search, global: isGlobal } = req.query;

    let query = `
      SELECT p.*,
        COALESCE(v_agg.visit_count, 0) as visit_count,
        COALESCE(v_agg.total_billed, 0) as total_billed,
        COALESCE(v_agg.total_due, 0) as total_due
      FROM patients p
      LEFT JOIN (
        SELECT patient_id::text, COUNT(id) as visit_count, SUM(total_amount) as total_billed, SUM(balance_amount) as total_due
        FROM visits GROUP BY patient_id
      ) v_agg ON v_agg.patient_id = p.id::text
      WHERE 1=1
    `;
    let params = [];
    if (centreId && isGlobal !== 'true' && (!search || !search.trim())) {
      params.push(String(centreId));
      query += ` AND (p.centre_id::text = $${params.length}::text OR p.id::text IN (SELECT patient_id::text FROM visits WHERE centre_id::text = $${params.length}::text))`;
    }
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      query += ` AND (p.full_name ILIKE $${params.length} OR p.phone ILIKE $${params.length} OR p.patient_code ILIKE $${params.length})`;
    }
    query += ' ORDER BY p.created_at DESC LIMIT 500';
    const result = await pool.query(query, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/patients', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { patientCode, fullName, age, gender, phone, email, address } = req.body;
    if (!fullName || !fullName.trim()) return res.status(400).json({ success: false, error: 'Full name required' });
    const finalPatCode = patientCode?.trim() || `PAT-${Date.now().toString().slice(-6)}`;
    const parsedAge = age !== null && age !== undefined && !isNaN(parseInt(age, 10)) ? parseInt(age, 10) : 0;
    const result = await pool.query(
      `INSERT INTO patients (centre_id, patient_code, full_name, age, gender, phone, email, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [centreId, finalPatCode, fullName.trim(), parsedAge, gender || 'Female', phone || '', email || '', address || '']
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/patients/:id/pcpndt-status', async (req, res) => {
  try {
    const patientId = getCleanId(req.params.id);
    const result = await pool.query(
      `SELECT pf.*, c.centre_name, c.place as centre_place 
       FROM pcpndt_forms pf
       JOIN visits v ON pf.visit_id = v.id
       LEFT JOIN clinic_centres c ON pf.centre_id = c.id
       WHERE v.patient_id::text = $1::text
       ORDER BY pf.created_at DESC LIMIT 1`,
      [patientId]
    );
    res.status(200).json({ success: true, data: result.rows[0] || null });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/patients/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const validId = getCleanId(req.params.id);
    const { fullName, age, gender, phone, email, address, patientCode, pcpndtData } = req.body;
    const parsedAge = age !== null && age !== undefined && !isNaN(parseInt(age, 10)) ? parseInt(age, 10) : 0;

    await client.query('BEGIN');
    const patResult = await client.query(
      `UPDATE patients 
       SET full_name = $1, age = $2, gender = $3, phone = $4, email = $5, address = $6, patient_code = $7 
       WHERE id::text = $8::text RETURNING *`,
      [fullName, parsedAge, gender || 'Female', phone || '', email || '', address || '', patientCode || '', validId]
    );

    if (pcpndtData && pcpndtData.savePcpndt) {
      const visitRes = await client.query(
        `SELECT id, centre_id FROM visits WHERE patient_id::text = $1::text ORDER BY created_at DESC LIMIT 1`,
        [validId]
      );
      let visitId = visitRes.rows[0]?.id;
      let centreId = pcpndtData.centreId || visitRes.rows[0]?.centre_id || getTenantCentreId(req);

      if (!visitId) {
        const newV = await client.query(
          `INSERT INTO visits (centre_id, patient_id, total_amount, paid_amount, balance_amount, invoice_number)
           VALUES ($1, $2, 0, 0, 0, $3) RETURNING id`,
          [centreId, validId, generateInvoiceNumber()]
        );
        visitId = newV.rows[0].id;
      }

      const existingF = await client.query('SELECT id FROM pcpndt_forms WHERE visit_id = $1', [visitId]);
      if (existingF.rows.length > 0) {
        await client.query(
          `UPDATE pcpndt_forms 
           SET centre_id = $1, relative_name = $2, lmp_date = $3, weeks_of_preg = $4,
               no_of_sons = $5, sons_age = $6, no_of_daughters = $7, daughters_age = $8,
               indications = $9, scan_result = $10, doctor_name = $11, doctor_reg_no = $12,
               clinic_reg_no = $13, place = $14
           WHERE visit_id = $15`,
          [
            centreId, pcpndtData.relativeName || '', pcpndtData.lmpDate || '', pcpndtData.weeksOfPreg || '',
            parseInt(pcpndtData.noOfSons, 10) || 0, pcpndtData.sonsAge || '',
            parseInt(pcpndtData.noOfDaughters, 10) || 0, pcpndtData.daughtersAge || '',
            pcpndtData.indications || '', pcpndtData.scanResult || '', pcpndtData.doctorName || 'Dr NIKUNJ KOTHIA',
            pcpndtData.doctorRegNo || '2009/09/3218', pcpndtData.clinicRegNo || 'RC197',
            pcpndtData.place || 'Kandivali West', visitId
          ]
        );
      } else {
        await client.query(
          `INSERT INTO pcpndt_forms (visit_id, centre_id, relative_name, lmp_date, weeks_of_preg, no_of_sons, sons_age, no_of_daughters, daughters_age, indications, scan_result, doctor_name, doctor_reg_no, clinic_reg_no, place)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            visitId, centreId, pcpndtData.relativeName || '', pcpndtData.lmpDate || '', pcpndtData.weeksOfPreg || '',
            parseInt(pcpndtData.noOfSons, 10) || 0, pcpndtData.sonsAge || '',
            parseInt(pcpndtData.noOfDaughters, 10) || 0, pcpndtData.daughtersAge || '',
            pcpndtData.indications || '', pcpndtData.scanResult || '', pcpndtData.doctorName || 'Dr NIKUNJ KOTHIA',
            pcpndtData.doctorRegNo || '2009/09/3218', pcpndtData.clinicRegNo || 'RC197',
            pcpndtData.place || 'Kandivali West'
          ]
        );
      }
    }

    await client.query('COMMIT');
    res.status(200).json({ success: true, data: patResult.rows[0], message: 'Patient details updated!' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/patients/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const validId = getCleanId(req.params.id);
    if (!validId) return res.status(400).json({ success: false, error: 'Invalid Patient ID' });

    await client.query('BEGIN');
    await client.query('DELETE FROM imaging_reports WHERE patient_id::text = $1::text OR visit_id IN (SELECT id FROM visits WHERE patient_id::text = $1::text)', [validId]);
    await client.query('DELETE FROM pcpndt_forms WHERE visit_id IN (SELECT id FROM visits WHERE patient_id::text = $1::text)', [validId]);
    await client.query('DELETE FROM patient_investigations WHERE visit_id IN (SELECT id FROM visits WHERE patient_id::text = $1::text)', [validId]);
    await client.query('DELETE FROM visits WHERE patient_id::text = $1::text', [validId]);
    const delRes = await client.query('DELETE FROM patients WHERE id::text = $1::text RETURNING id', [validId]);
    await client.query('COMMIT');

    if (delRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Patient not found.' });
    res.status(200).json({ success: true, message: 'Patient and all records deleted permanently.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/patients/:id/visits', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const result = await pool.query(
      `SELECT v.*, COALESCE(v.payment_mode, 'Cash') as payment_mode, p.phone, d.doctor_name, c.centre_name,
              EXISTS(SELECT 1 FROM pcpndt_forms pf WHERE pf.visit_id = v.id) as has_pcpndt
       FROM visits v 
       JOIN patients p ON v.patient_id = p.id 
       LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id 
       LEFT JOIN clinic_centres c ON v.centre_id = c.id
       WHERE v.patient_id::text = $1::text
       ORDER BY v.created_at DESC`,
      [validId]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/imaging/patients-dropdown', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    let query = `
      SELECT COALESCE(v.id::text, p.id::text) as dropdown_key, v.id as visit_id, p.id as patient_id,
             p.full_name, p.age, p.gender, p.patient_code, p.phone, p.address,
             COALESCE(v.invoice_number, p.patient_code, 'REG') as invoice_number,
             COALESCE(d.doctor_name, 'Self / Direct OPD') as doctor_name,
             COALESCE(string_agg(DISTINCT tm.test_name, ', '), 'General Study') as test_names,
             COALESCE(v.created_at, p.created_at) as created_at
      FROM patients p
      LEFT JOIN visits v ON v.patient_id = p.id
      LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
      LEFT JOIN patient_investigations pi ON pi.visit_id = v.id
      LEFT JOIN test_master tm ON pi.test_id = tm.id
      WHERE 1=1
    `;
    let params = [];
    if (centreId) {
      params.push(String(centreId));
      query += ` AND (p.centre_id::text = $${params.length}::text OR v.centre_id::text = $${params.length}::text)`;
    }
    query += ` GROUP BY v.id, p.id, p.full_name, p.age, p.gender, p.patient_code, p.phone, p.address, d.doctor_name, v.invoice_number, v.created_at, p.created_at ORDER BY created_at DESC LIMIT 200`;
    const result = await pool.query(query, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/visits/:id/cut', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const { doctor_commission, doctorCommission } = req.body;
    if (!validId) return res.status(400).json({ success: false, error: 'Invalid visit ID' });

    const rawCut = doctor_commission !== undefined ? doctor_commission : doctorCommission;
    if (rawCut === undefined || rawCut === null || isNaN(parseFloat(rawCut))) {
      return res.status(400).json({ success: false, error: 'Valid doctor cut amount required' });
    }
    const cutVal = Math.max(0, parseFloat(rawCut));

    const result = await pool.query(
      'UPDATE visits SET doctor_commission = $1 WHERE id::text = $2::text OR invoice_number = $2::text RETURNING id, doctor_commission',
      [cutVal, validId]
    );
    if (result.rowCount === 0) return res.status(404).json({ success: false, error: 'Visit record not found' });
    return res.status(200).json({ success: true, message: 'Doctor cut updated successfully', data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/visits/:id/mark-printed', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    await pool.query('UPDATE visits SET bill_printed = true WHERE id::text = $1::text OR invoice_number = $1::text', [validId]);
    res.status(200).json({ success: true, message: 'Bill marked as printed.' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/visits/:id/upload-report', upload.single('reportFile'), async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    if (!validId) return res.status(400).json({ success: false, error: 'Invalid visit ID.' });
    if (!req.file) return res.status(400).json({ success: false, error: 'No report file selected.' });

    const relPath = req.file.path.replace(/\\/g, '/');
    const hasLetterhead = req.body.hasLetterhead !== 'false';
    const marginMm = parseInt(req.body.marginMm, 10) || 55;

    const vResult = await pool.query(
      `SELECT v.id, v.patient_id, v.centre_id, v.invoice_number, p.full_name, d.doctor_name as ref_doctor_name
       FROM visits v
       JOIN patients p ON v.patient_id = p.id
       LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
       WHERE v.id::text = $1::text OR v.invoice_number = $1::text`,
      [validId]
    );
    if (vResult.rowCount === 0) return res.status(404).json({ success: false, error: 'Visit not found.' });
    const vRow = vResult.rows[0];

    await pool.query(
      `UPDATE visits 
       SET report_file = $1, report_has_letterhead = $2, report_margin_mm = $3 
       WHERE id = $4`,
      [relPath, hasLetterhead, marginMm, vRow.id]
    );

    const ext = path.extname(req.file.originalname).toLowerCase();
    let parsed = { title: 'DIAGNOSTIC IMAGING REPORT', body: '', impression: '', signatureFile: null };
    if (ext === '.docx' || ext === '.doc') {
      parsed = extractTextFromUploadedFile(req.file.path, vRow.full_name || '', vRow.ref_doctor_name || '');
      const existingRep = await pool.query('SELECT id, signature_file, doctor_name FROM imaging_reports WHERE visit_id = $1', [vRow.id]);
      let finalSig = parsed.signatureFile || existingRep.rows[0]?.signature_file || null;

      if (!finalSig) {
        const resolved = await resolveDoctorSignature(existingRep.rows[0]?.doctor_name || 'Dr NIKUNJ KOTHIA', vRow.centre_id);
        if (resolved?.signature_file) finalSig = resolved.signature_file;
      }

      if (existingRep.rows.length > 0) {
        await pool.query(
          `UPDATE imaging_reports 
           SET template_name = $1, report_text = $2, impression = $3, signature_file = COALESCE($4, signature_file), created_at = CURRENT_TIMESTAMP
           WHERE visit_id = $5`,
          [parsed.title || 'DIAGNOSTIC IMAGING REPORT', parsed.body, parsed.impression, finalSig, vRow.id]
        );
      } else {
        await pool.query(
          `INSERT INTO imaging_reports (visit_id, patient_id, centre_id, template_name, report_text, impression, doctor_name, doctor_reg_no, doctor_designation, signature_file)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [vRow.id, vRow.patient_id, vRow.centre_id, parsed.title || 'DIAGNOSTIC IMAGING REPORT', parsed.body || 'Study completed.', parsed.impression || '', 'Dr NIKUNJ KOTHIA', '2009/09/3218', 'Consultant Radiologist', finalSig]
        );
      }
    }

    res.status(200).json({
      success: true,
      message: 'Report attached & clinical details extracted successfully!',
      data: { visitId: vRow.id, reportFile: relPath, hasLetterhead, marginMm, extracted: parsed }
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/visits/:id/uploaded-report', async (req, res) => {
  try {
    const validId = getCleanId(req.params.visitId || req.params.id);
    const vRes = await pool.query('SELECT report_file, invoice_number FROM visits WHERE id::text = $1::text OR invoice_number = $1::text', [validId]);
    if (vRes.rows.length === 0 || !vRes.rows[0].report_file) return res.status(404).send('No report uploaded.');
    const fullPath = path.resolve(__dirname, vRes.rows[0].report_file);
    if (!fs.existsSync(fullPath)) return res.status(404).send('File not found on server.');

    const ext = path.extname(fullPath).toLowerCase();
    if (ext === '.pdf') res.setHeader('Content-Type', 'application/pdf');
    else if (ext === '.docx') res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    else if (ext === '.doc') res.setHeader('Content-Type', 'application/msword');
    else if (ext === '.jpg' || ext === '.jpeg') res.setHeader('Content-Type', 'image/jpeg');
    else if (ext === '.png') res.setHeader('Content-Type', 'image/png');
    res.sendFile(fullPath);
  } catch (err) { res.status(500).send(err.message); }
});

app.put('/api/visits/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const validVisitId = getCleanId(req.params.id);
    if (!validVisitId) return res.status(400).json({ success: false, error: 'Invalid Visit ID' });

    await client.query('BEGIN');
    const { 
      referringDoctorId, tests, concession, paidAmount, paymentMode, 
      cashAmount, onlineAmount, doctorCommission, doctor_commission, isPcpndt, 
      relativeName, lmpDate, weeksOfPreg, pcpndtIndications, scanResult, place 
    } = req.body;

    let testArray = Array.isArray(tests) ? tests : [];
    if (typeof tests === 'string') {
      try { testArray = JSON.parse(tests); } catch (e) { testArray = []; }
    }

    const grossTotal = testArray.reduce((sum, t) => sum + (parseFloat(t.price) || 0), 0);
    const disc = parseFloat(concession) || 0;
    const netTotal = Math.max(0, grossTotal - disc);

    let parsedCash = parseFloat(cashAmount) || 0;
    let parsedOnline = parseFloat(onlineAmount) || 0;
    let paid = parseFloat(paidAmount) || 0;

    if (paymentMode === 'Split') {
      paid = parsedCash + parsedOnline;
    } else if (paymentMode === 'Cash') {
      parsedCash = paid; parsedOnline = 0;
    } else {
      parsedOnline = paid; parsedCash = 0;
    }

    const balance = Math.max(0, netTotal - paid);
    const payStatus = balance <= 0 ? 'Paid' : (paid > 0 ? 'Partial' : 'Pending');

    const validDoctorId = getCleanId(referringDoctorId);
    let docInfo = null;
    if (validDoctorId) {
      const docRes = await client.query('SELECT commission_type, commission_value FROM referring_doctors WHERE id::text = $1::text', [validDoctorId]);
      if (docRes.rows.length > 0) docInfo = docRes.rows[0];
    }

    const manualCut = doctorCommission !== undefined ? doctorCommission : doctor_commission;
    let totalCommission;
    if (manualCut !== undefined && manualCut !== null && manualCut !== '' && !isNaN(parseFloat(manualCut))) {
      totalCommission = Math.max(0, parseFloat(manualCut));
    } else {
      totalCommission = calculateCommission(testArray, validDoctorId, docInfo, disc);
    }

    const vUpdate = await client.query(
      `UPDATE visits 
       SET referring_doctor_id = $1, total_amount = $2, concession = $3, paid_amount = $4, balance_amount = $5, 
           payment_status = $6, payment_mode = $7, cash_amount = $8, online_amount = $9, doctor_commission = $10
       WHERE id::text = $11::text OR invoice_number = $11::text RETURNING id`,
      [validDoctorId, grossTotal, disc, paid, balance, payStatus, paymentMode || 'Cash', parsedCash, parsedOnline, totalCommission, validVisitId]
    );

    if (vUpdate.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Visit not found' });
    }
    const resolvedVisitId = vUpdate.rows[0].id;

    await client.query('DELETE FROM patient_investigations WHERE visit_id = $1', [resolvedVisitId]);
    for (const t of testArray) {
      const cutVal = (t.test_cut !== undefined && t.test_cut !== null && !isNaN(parseFloat(t.test_cut))) ? parseFloat(t.test_cut) : 30;
      await client.query(
        `INSERT INTO patient_investigations (visit_id, test_id, barcode, price, cut_type, test_cut) VALUES ($1, $2, $3, $4, $5, $6)`,
        [resolvedVisitId, getCleanId(t.id), generateBarcode(), parseFloat(t.price) || 0, t.cut_type || 'percentage', cutVal]
      );
    }

    if (String(isPcpndt) === 'true') {
      const pCheck = await client.query('SELECT id FROM pcpndt_forms WHERE visit_id = $1', [resolvedVisitId]);
      if (pCheck.rows.length > 0) {
        await client.query(
          `UPDATE pcpndt_forms SET relative_name = $1, lmp_date = $2, weeks_of_preg = $3, indications = $4, scan_result = $5, place = COALESCE($6, place) WHERE visit_id = $7`,
          [relativeName || '', lmpDate || '', weeksOfPreg || '', pcpndtIndications || '', scanResult || '', place || null, resolvedVisitId]
        );
      } else {
        await client.query(
          `INSERT INTO pcpndt_forms (visit_id, relative_name, lmp_date, weeks_of_preg, indications, scan_result, place) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [resolvedVisitId, relativeName || '', lmpDate || '', weeksOfPreg || '', pcpndtIndications || '', scanResult || '', place || 'Kandivali West']
        );
      }
    }

    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Bill updated successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

app.post('/api/register-visit', upload.single('reportFile'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      centreId, existingPatientId, patientCode, fullName, age, gender, phone, email, address,
      referringDoctorId, tests, concession, paidAmount, paymentMode, cashAmount, onlineAmount,
      doctorCommission, doctor_commission, isPcpndt, relativeName, lmpDate, weeksOfPreg, 
      noOfSons, sonsAge, noOfDaughters, daughtersAge, pcpndtIndications, scanResult, doctorName, 
      doctorRegNo, clinicRegNo, place
    } = req.body;

    const finalCentreId = getCleanId(centreId) || getCleanId(req.headers['x-centre-id']);
    if (!fullName || !fullName.trim()) throw new Error('Patient full name is required.');

    let patientId = getCleanId(existingPatientId);
    const parsedAge = age !== null && age !== undefined && !isNaN(parseInt(age, 10)) ? parseInt(age, 10) : 0;

    if (!patientId) {
      const finalPatCode = patientCode?.trim() || `PAT-${Date.now().toString().slice(-6)}`;
      const patRes = await client.query(
        `INSERT INTO patients (centre_id, patient_code, full_name, age, gender, phone, email, address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [finalCentreId, finalPatCode, fullName.trim(), parsedAge, gender || 'Female', phone?.trim() || '', email?.trim() || '', address?.trim() || '']
      );
      patientId = patRes.rows[0].id;
    }

    let testArray = Array.isArray(tests) ? tests : [];
    if (typeof tests === 'string') {
      try { testArray = JSON.parse(tests); } catch (e) { testArray = []; }
    }

    const grossTotal = testArray.reduce((sum, t) => sum + (parseFloat(t.price) || 0), 0);
    const disc = parseFloat(concession) || 0;
    const netTotal = Math.max(0, grossTotal - disc);

    let parsedCash = parseFloat(cashAmount) || 0;
    let parsedOnline = parseFloat(onlineAmount) || 0;
    let paid = parseFloat(paidAmount) || 0;

    if (paymentMode === 'Split') {
      paid = parsedCash + parsedOnline;
    } else if (paymentMode === 'Cash') {
      parsedCash = paid; parsedOnline = 0;
    } else {
      parsedOnline = paid; parsedCash = 0;
    }

    const balance = Math.max(0, netTotal - paid);
    const payStatus = balance <= 0 ? 'Paid' : (paid > 0 ? 'Partial' : 'Pending');

    const validDoctorId = getCleanId(referringDoctorId);
    let docInfo = null;
    if (validDoctorId) {
      const docRes = await client.query('SELECT doctor_name, commission_type, commission_value FROM referring_doctors WHERE id::text = $1::text', [validDoctorId]);
      if (docRes.rows.length > 0) docInfo = docRes.rows[0];
    }

    const manualCut = doctorCommission !== undefined ? doctorCommission : doctor_commission;
    let totalCommission;
    if (manualCut !== undefined && manualCut !== null && manualCut !== '' && !isNaN(parseFloat(manualCut))) {
      totalCommission = Math.max(0, parseFloat(manualCut));
    } else {
      totalCommission = calculateCommission(testArray, validDoctorId, docInfo, disc);
    }

    const invoiceNum = generateInvoiceNumber();
    const uploadedRelPath = req.file ? req.file.path.replace(/\\/g, '/') : null;

    const visitRes = await client.query(
      `INSERT INTO visits (
        centre_id, patient_id, referring_doctor_id, total_amount, concession, paid_amount, 
        balance_amount, payment_status, payment_mode, cash_amount, online_amount, bill_printed,
        invoice_number, doctor_commission, report_file
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, $12, $13, $14) RETURNING id`,
      [finalCentreId, patientId, validDoctorId, grossTotal, disc, paid, balance, payStatus, paymentMode || 'Cash', parsedCash, parsedOnline, invoiceNum, totalCommission, uploadedRelPath]
    );
    const visitId = visitRes.rows[0].id;

    for (const t of testArray) {
      const cutVal = (t.test_cut !== undefined && t.test_cut !== null && !isNaN(parseFloat(t.test_cut))) ? parseFloat(t.test_cut) : 30;
      await client.query(
        `INSERT INTO patient_investigations (visit_id, test_id, barcode, price, cut_type, test_cut) VALUES ($1, $2, $3, $4, $5, $6)`,
        [visitId, getCleanId(t.id), generateBarcode(), parseFloat(t.price) || 0, t.cut_type || 'percentage', cutVal]
      );
    }

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === '.docx' || ext === '.doc') {
        const parsed = extractTextFromUploadedFile(req.file.path, fullName.trim(), docInfo?.doctor_name || '');
        let finalSig = parsed.signatureFile || null;
        if (!finalSig) {
          const resolved = await resolveDoctorSignature(doctorName || 'Dr NIKUNJ KOTHIA', finalCentreId);
          if (resolved?.signature_file) finalSig = resolved.signature_file;
        }
        await client.query(
          `INSERT INTO imaging_reports (visit_id, patient_id, centre_id, template_name, report_text, impression, doctor_name, doctor_reg_no, doctor_designation, signature_file)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [visitId, patientId, finalCentreId, parsed.title || 'DIAGNOSTIC IMAGING REPORT', parsed.body || 'Study completed.', parsed.impression || '', doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', 'Consultant Radiologist', finalSig]
        );
      }
    }

    if (String(isPcpndt) === 'true') {
      await client.query(
        `INSERT INTO pcpndt_forms (visit_id, centre_id, relative_name, no_of_sons, sons_age, no_of_daughters, daughters_age, lmp_date, weeks_of_preg, indications, scan_result, doctor_name, doctor_reg_no, clinic_reg_no, place)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [visitId, finalCentreId, relativeName || '', parseInt(noOfSons, 10) || 0, sonsAge || '', parseInt(noOfDaughters, 10) || 0, daughtersAge || '', lmpDate || '', weeksOfPreg || '', pcpndtIndications || '', scanResult || '', doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', clinicRegNo || 'RC197', place || 'Kandivali West']
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { visitId, patientId, invoiceNumber: invoiceNum, fullName } });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/visits/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const vRes = await pool.query('SELECT id FROM visits WHERE id::text = $1::text OR invoice_number = $1::text', [validId]);
    if (vRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Visit not found' });
    const realId = vRes.rows[0].id;

    await pool.query('DELETE FROM patient_investigations WHERE visit_id = $1', [realId]);
    await pool.query('DELETE FROM pcpndt_forms WHERE visit_id = $1', [realId]);
    await pool.query('DELETE FROM imaging_reports WHERE visit_id = $1', [realId]);
    await pool.query('DELETE FROM visits WHERE id = $1', [realId]);
    res.status(200).json({ success: true, message: 'Visit deleted' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/invoice/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const visitRes = await pool.query(
      `SELECT v.*, p.full_name, p.age, p.gender, p.phone, p.address, p.patient_code,
              d.doctor_name, c.centre_name, c.tagline as centre_tagline, c.address as centre_address,
              c.place as centre_place, c.phone as centre_phone, c.reg_no as centre_reg_no
       FROM visits v
       JOIN patients p ON v.patient_id = p.id
       LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
       LEFT JOIN clinic_centres c ON v.centre_id = c.id
       WHERE v.id::text = $1::text OR v.invoice_number = $1::text`,
      [validId]
    );
    if (visitRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Invoice not found' });
    const v = visitRes.rows[0];

    const invRes = await pool.query(
      `SELECT pi.*, tm.test_name, tm.category FROM patient_investigations pi
       LEFT JOIN test_master tm ON pi.test_id = tm.id WHERE pi.visit_id = $1`,
      [v.id]
    );
    const pcpndtRes = await pool.query(`SELECT * FROM pcpndt_forms WHERE visit_id = $1 LIMIT 1`, [v.id]);

    res.status(200).json({
      success: true,
      data: { visitDetails: v, investigations: invRes.rows, pcpndtForm: pcpndtRes.rows[0] || null }
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// PDF INVOICE GENERATOR (WITH MOBILE NUMBER INSTEAD OF ADDRESS)
app.get('/api/invoice/:id/pdf', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const withLetterhead = req.query.letterhead !== 'false';
    const marginMm = parseInt(req.query.margin, 10) || 55;
    const shouldMarkPrinted = req.query.markPrinted === 'true';

    if (shouldMarkPrinted && validId) {
      await pool.query('UPDATE visits SET bill_printed = true WHERE id::text = $1::text OR invoice_number = $1::text', [validId]);
    }

    const visitRes = await pool.query(
      `SELECT v.*, p.full_name, p.age, p.gender, p.phone, p.address, p.patient_code,
              d.doctor_name, c.centre_name, c.tagline as centre_tagline, c.address as centre_address,
              c.place as centre_place, c.phone as centre_phone, c.reg_no as centre_reg_no
       FROM visits v
       JOIN patients p ON v.patient_id = p.id
       LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
       LEFT JOIN clinic_centres c ON v.centre_id = c.id
       WHERE v.id::text = $1::text OR v.invoice_number = $1::text`,
      [validId]
    );
    if (visitRes.rows.length === 0) return res.status(404).send('Invoice not found');
    const v = visitRes.rows[0];

    const invRes = await pool.query(
      `SELECT pi.*, tm.test_name, tm.category FROM patient_investigations pi
       LEFT JOIN test_master tm ON pi.test_id = tm.id WHERE pi.visit_id = $1`,
      [v.id]
    );
    const items = invRes.rows;

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const filename = `Invoice_${v.invoice_number || 'INV'}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    doc.pipe(res);

    if (withLetterhead) {
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#19486a').text(sanitizeForPdfKit(v.centre_name || 'RESQ HEART CLINIC AND IMAGING CENTRE'), 40, doc.y, { width: 515, align: 'center' });
      if (v.centre_tagline) doc.fontSize(8.5).font('Helvetica').fillColor('#555555').text(sanitizeForPdfKit(v.centre_tagline), 40, doc.y, { width: 515, align: 'center' });
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#b91c1c').text(`Phone / Contact: ${sanitizeForPdfKit(v.centre_phone || '+91 8433838285')}`, 40, doc.y, { width: 515, align: 'center' });
      doc.fontSize(8).font('Helvetica').fillColor('#333333').text(`${sanitizeForPdfKit(v.centre_address || 'Kandivali West, Mumbai')} | Reg: ${sanitizeForPdfKit(v.centre_reg_no || 'RC197')}`, 40, doc.y, { width: 515, align: 'center' });
      doc.moveDown(0.5);
      doc.strokeColor('#cccccc').lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.8);
    } else {
      doc.y = Math.max(30, Math.round(marginMm * 2.83465));
    }

    const metaTop = doc.y;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000');
    doc.text(`Patient Name: `, 40, metaTop, { continued: true }).font('Helvetica').text(sanitizeForPdfKit(v.full_name));
    doc.font('Helvetica-Bold').text(`Age / Gender: `, 40, doc.y + 2, { continued: true }).font('Helvetica').text(`${v.age || 0} Yrs / ${v.gender || 'N/A'}`);
    doc.font('Helvetica-Bold').text(`Mobile No: `, 40, doc.y + 2, { continued: true }).font('Helvetica').text(sanitizeForPdfKit(v.phone || '-'));

    doc.font('Helvetica-Bold').text(`Invoice No: `, 330, metaTop, { continued: true }).font('Helvetica').text(sanitizeForPdfKit(v.invoice_number));
    doc.font('Helvetica-Bold').text(`Date: `, 330, doc.y + 2, { continued: true }).font('Helvetica').text(new Date(v.created_at).toLocaleDateString('en-GB'));
    doc.font('Helvetica-Bold').text(`Ref. Doctor: `, 330, doc.y + 2, { continued: true }).font('Helvetica').text(sanitizeForPdfKit(v.doctor_name || 'Direct OPD'));
    doc.moveDown(1.5);

    const tableTop = doc.y;
    doc.rect(40, tableTop, 515, 20).fill('#f1f5f9');
    doc.fillColor('#1a365d').font('Helvetica-Bold').fontSize(9);
    doc.text('Investigation / Service', 50, tableTop + 5);
    doc.text('Category', 300, tableTop + 5);
    doc.text('Amount (INR)', 450, tableTop + 5, { width: 95, align: 'right' });

    let currentY = tableTop + 24;
    doc.font('Helvetica').fillColor('#000000').fontSize(9);
    for (const item of items) {
      doc.text(sanitizeForPdfKit(item.test_name || 'Service'), 50, currentY);
      doc.text(sanitizeForPdfKit(item.category || 'General'), 300, currentY);
      doc.text(parseFloat(item.price || 0).toFixed(2), 450, currentY, { width: 95, align: 'right' });
      currentY += 18;
    }

    doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(40, currentY + 4).lineTo(555, currentY + 4).stroke();
    currentY += 14;

    const totalBoxX = 330;
    doc.fontSize(9).font('Helvetica');
    doc.text('Gross Total:', totalBoxX, currentY, { width: 120 });
    doc.text(`INR ${parseFloat(v.total_amount || 0).toFixed(2)}`, 450, currentY, { width: 95, align: 'right' });
    currentY += 14;

    doc.text('Concession / Discount:', totalBoxX, currentY, { width: 120 });
    doc.text(`- INR ${parseFloat(v.concession || 0).toFixed(2)}`, 450, currentY, { width: 95, align: 'right' });
    currentY += 14;

    doc.font('Helvetica-Bold').text('Net Payable:', totalBoxX, currentY, { width: 120 });
    doc.text(`INR ${(parseFloat(v.total_amount || 0) - parseFloat(v.concession || 0)).toFixed(2)}`, 450, currentY, { width: 95, align: 'right' });
    currentY += 14;

    let modeText = `Paid (${v.payment_mode || 'Cash'}):`;
    if (v.payment_mode === 'Split') {
      modeText = `Paid (Cash Rs.${parseFloat(v.cash_amount || 0).toFixed(0)} + Online Rs.${parseFloat(v.online_amount || 0).toFixed(0)}):`;
    }
    doc.font('Helvetica').text(modeText, totalBoxX, currentY, { width: 120 });
    doc.text(`INR ${parseFloat(v.paid_amount || 0).toFixed(2)}`, 450, currentY, { width: 95, align: 'right' });
    currentY += 14;

    doc.font('Helvetica-Bold').fillColor('#c00000').text('Balance Due:', totalBoxX, currentY, { width: 120 });
    doc.text(`INR ${parseFloat(v.balance_amount || 0).toFixed(2)}`, 450, currentY, { width: 95, align: 'right' });

    const footerY = Math.min(760, Math.max(currentY + 40, 720));
    doc.fontSize(8).fillColor('#777777').font('Helvetica').text(
      'This is an electronically generated diagnostic invoice and requires no signature.',
      40, footerY, { align: 'center', width: 515 }
    );
    doc.end();
  } catch (err) { res.status(500).send('Error generating PDF: ' + err.message); }
});

// REPORT DATA & TEMPLATES (Always syncs latest attached .docx file if present on disk)
app.get('/api/imaging/report-data/:visitId', async (req, res) => {
  try {
    const validId = getCleanId(req.params.visitId);
    if (!validId) return res.status(400).json({ success: false, error: 'Invalid Visit ID' });

    const visitRes = await pool.query(
      `SELECT v.*, p.full_name, p.age, p.gender, p.phone, p.patient_code,
              d.doctor_name as ref_doctor, c.centre_name, c.phone as centre_phone,
              COALESCE(c.top_margin_mm, 55) as centre_default_margin
       FROM visits v
       JOIN patients p ON v.patient_id = p.id
       LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
       LEFT JOIN clinic_centres c ON v.centre_id = c.id
       WHERE v.id::text = $1::text OR v.invoice_number = $1::text`,
      [validId]
    );
    if (visitRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Visit not found' });
    const v = visitRes.rows[0];

    const invRes = await pool.query(
      `SELECT tm.test_name, tm.category FROM patient_investigations pi
       LEFT JOIN test_master tm ON pi.test_id = tm.id WHERE pi.visit_id = $1`,
      [v.id]
    );

    let repRes = await pool.query(
      `SELECT * FROM imaging_reports WHERE visit_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [v.id]
    );

    let existingRep = repRes.rows[0] || null;
    if (v.report_file) {
      const fullPath = path.resolve(__dirname, v.report_file);
      if (fs.existsSync(fullPath)) {
        const ext = path.extname(fullPath).toLowerCase();
        if (ext === '.docx' || ext === '.doc') {
          const parsed = extractTextFromUploadedFile(fullPath, v.full_name || '', v.ref_doctor || '');
          if (!existingRep) {
            existingRep = {
              template_name: parsed.title,
              report_text: parsed.body,
              impression: parsed.impression,
              doctor_name: 'Dr NIKUNJ KOTHIA',
              doctor_reg_no: '2009/09/3218',
              doctor_designation: 'Consultant Radiologist',
              signature_file: parsed.signatureFile || null
            };
          } else {
            existingRep.template_name = parsed.title || existingRep.template_name;
            existingRep.report_text = parsed.body || existingRep.report_text;
            existingRep.impression = parsed.impression || existingRep.impression;
            if (parsed.signatureFile) existingRep.signature_file = parsed.signatureFile;
          }
        }
      }
    }

    if (existingRep && !existingRep.signature_file) {
      const resolved = await resolveDoctorSignature(existingRep.doctor_name, v.centre_id);
      if (resolved?.signature_file) {
        existingRep.signature_file = resolved.signature_file;
      }
    }

    const tmplRes = await pool.query(`SELECT id, title, template_name, category, default_impression, template_body FROM imaging_templates ORDER BY title ASC`);
    const radRes = await pool.query(`SELECT * FROM radiologists WHERE is_global = true OR centre_id::text = $1::text ORDER BY doctor_name ASC`, [v.centre_id || null]);

    res.status(200).json({
      success: true,
      data: {
        visit: v,
        investigations: invRes.rows,
        existingReport: existingRep,
        templates: tmplRes.rows || [],
        radiologists: radRes.rows || []
      }
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/imaging/report-save', async (req, res) => {
  try {
    const { 
      visitId, reportTitle, reportText, impression, 
      doctorName, doctorRegNo, doctorDesignation, signatureFile, 
      hasLetterhead, marginMm 
    } = req.body;
    const validVisitId = getCleanId(visitId);
    if (!validVisitId) return res.status(400).json({ success: false, error: 'Visit ID is required.' });

    const vRes = await pool.query('SELECT id, patient_id, centre_id FROM visits WHERE id::text = $1::text OR invoice_number = $1::text', [validVisitId]);
    if (vRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Visit record not found.' });

    const realVisitId = vRes.rows[0].id;
    const { patient_id, centre_id } = vRes.rows[0];
    const isLetterhead = hasLetterhead !== false && hasLetterhead !== 'false';
    const topMargin = parseInt(marginMm, 10) || 55;

    await pool.query(
      `UPDATE visits 
       SET report_has_letterhead = $1, report_margin_mm = $2 
       WHERE id = $3`,
      [isLetterhead, topMargin, realVisitId]
    );

    let finalSig = signatureFile || null;
    if (!finalSig) {
      const resolved = await resolveDoctorSignature(doctorName || 'Dr NIKUNJ KOTHIA', centre_id);
      if (resolved?.signature_file) {
        finalSig = resolved.signature_file;
      }
    }

    const existing = await pool.query('SELECT id FROM imaging_reports WHERE visit_id = $1', [realVisitId]);
    let result;

    if (existing.rows.length > 0) {
      result = await pool.query(
        `UPDATE imaging_reports
         SET template_name = $1, report_text = $2, impression = $3, doctor_name = $4, 
             doctor_reg_no = $5, doctor_designation = $6, signature_file = COALESCE($7, signature_file), created_at = CURRENT_TIMESTAMP
         WHERE visit_id = $8 RETURNING *`,
        [
          reportTitle || 'Diagnostic Study',
          reportText || '',
          impression || '',
          doctorName || 'Dr NIKUNJ KOTHIA',
          doctorRegNo || '2009/09/3218',
          doctorDesignation || 'Consultant Radiologist',
          finalSig,
          realVisitId
        ]
      );
    } else {
      result = await pool.query(
        `INSERT INTO imaging_reports 
           (visit_id, patient_id, centre_id, template_name, report_text, impression, doctor_name, doctor_reg_no, doctor_designation, signature_file)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [
          realVisitId, patient_id, centre_id,
          reportTitle || 'Diagnostic Study',
          reportText || '',
          impression || '',
          doctorName || 'Dr NIKUNJ KOTHIA',
          doctorRegNo || '2009/09/3218',
          doctorDesignation || 'Consultant Radiologist',
          finalSig
        ]
      );
    }

    res.status(200).json({ success: true, message: 'Report saved successfully!', data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// FULL-WIDTH PROFESSIONAL MEDICAL PDF REPORT GENERATOR WITH TABLES, INLINE BOLD & SIGNATURE
app.get('/api/imaging/report/:visitId/pdf', async (req, res) => {
  try {
    const validId = getCleanId(req.params.visitId);
    const withLetterhead = req.query.letterhead !== 'false';

    const visitRes = await pool.query(
      `SELECT v.*, p.full_name, p.age, p.gender, p.phone, p.patient_code,
              d.doctor_name as ref_doctor, c.centre_name, c.tagline as centre_tagline, 
              c.address as centre_address, c.place as centre_place, c.phone as centre_phone, 
              c.reg_no as centre_reg_no, COALESCE(c.top_margin_mm, 55) as centre_top_margin
       FROM visits v
       JOIN patients p ON v.patient_id = p.id
       LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
       LEFT JOIN clinic_centres c ON v.centre_id = c.id
       WHERE v.id::text = $1::text OR v.invoice_number = $1::text`,
      [validId]
    );
    if (visitRes.rows.length === 0) return res.status(404).send('Visit not found');
    const v = visitRes.rows[0];

    const repRes = await pool.query(
      `SELECT * FROM imaging_reports WHERE visit_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [v.id]
    );

    let rep = repRes.rows[0];

    // Always re-parse the physical .docx file if it exists on disk so newly attached files (like Reena Kamble) are 100% up to date
    if (v.report_file) {
      const fullPath = path.resolve(__dirname, v.report_file);
      if (fs.existsSync(fullPath)) {
        const ext = path.extname(fullPath).toLowerCase();
        if (ext === '.docx' || ext === '.doc') {
          const parsed = extractTextFromUploadedFile(fullPath, v.full_name || '', v.ref_doctor || '');
          if (!rep) {
            rep = {
              template_name: parsed.title,
              report_text: parsed.body,
              impression: parsed.impression,
              doctor_name: 'Dr NIKUNJ KOTHIA',
              doctor_reg_no: '2009/09/3218',
              doctor_designation: 'Consultant Radiologist',
              signature_file: parsed.signatureFile || null
            };
          } else {
            rep.template_name = parsed.title || rep.template_name;
            rep.report_text = parsed.body || rep.report_text;
            rep.impression = parsed.impression || rep.impression;
            if (parsed.signatureFile) rep.signature_file = parsed.signatureFile;
          }
        }
      }
    }

    if (!rep) {
      rep = {
        template_name: 'DIAGNOSTIC IMAGING REPORT',
        report_text: 'Study completed within normal parameters.',
        impression: '',
        doctor_name: 'Dr NIKUNJ KOTHIA',
        doctor_reg_no: '2009/09/3218',
        doctor_designation: 'Consultant Radiologist',
        signature_file: null
      };
    }

    if (!rep.signature_file) {
      const resolved = await resolveDoctorSignature(rep.doctor_name, v.centre_id);
      if (resolved) {
        if (resolved.signature_file) rep.signature_file = resolved.signature_file;
        if (resolved.designation && !rep.doctor_designation) rep.doctor_designation = resolved.designation;
        if (resolved.reg_no && !rep.doctor_reg_no) rep.doctor_reg_no = resolved.reg_no;
      }
    }

    let effectiveMarginMm = v.centre_top_margin || 55;
    if (req.query.margin && !isNaN(parseInt(req.query.margin, 10))) {
      effectiveMarginMm = parseInt(req.query.margin, 10);
    } else if (v.report_margin_mm && !isNaN(parseInt(v.report_margin_mm, 10))) {
      effectiveMarginMm = parseInt(v.report_margin_mm, 10);
    }

    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const filename = `Report_${v.invoice_number || 'REP'}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    doc.pipe(res);

    // 1. CLINIC LETTERHEAD
    if (withLetterhead) {
      doc.fontSize(15).font('Helvetica-Bold').fillColor('#19486a')
         .text(sanitizeForPdfKit(v.centre_name || 'RESQ HEART CLINIC AND IMAGING CENTRE'), 40, doc.y, { width: 515, align: 'center' });
      
      if (v.centre_tagline) {
        doc.fontSize(8).font('Helvetica').fillColor('#555555')
           .text(sanitizeForPdfKit(v.centre_tagline), 40, doc.y, { width: 515, align: 'center' });
      }
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#b91c1c')
         .text(`Phone / Contact: ${sanitizeForPdfKit(v.centre_phone || '+91 8433838285')}`, 40, doc.y, { width: 515, align: 'center' });
      doc.fontSize(7.8).font('Helvetica').fillColor('#333333')
         .text(`${sanitizeForPdfKit(v.centre_address || 'Kandivali West, Mumbai')} | Reg: ${sanitizeForPdfKit(v.centre_reg_no || 'RC197')}`, 40, doc.y, { width: 515, align: 'center' });
      
      doc.moveDown(0.35);
      doc.strokeColor('#19486a').lineWidth(1.2).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.5);
    } else {
      doc.y = Math.max(25, Math.round(effectiveMarginMm * 2.83465));
    }

    // 2. PATIENT DEMOGRAPHICS
    const metaBoxY = doc.y;
    doc.rect(40, metaBoxY, 515, 42).fillAndStroke('#f8fafc', '#cbd5e1');
    doc.fontSize(8.5).fillColor('#000000');

    doc.font('Helvetica-Bold').text('PATIENT NAME: ', 50, metaBoxY + 7, { continued: true })
       .font('Helvetica').text(sanitizeForPdfKit(v.full_name.toUpperCase()));
    doc.font('Helvetica-Bold').text('AGE / GENDER: ', 50, metaBoxY + 23, { continued: true })
       .font('Helvetica').text(`${v.age || 0} YRS / ${(v.gender || 'FEMALE').toUpperCase()}`);

    doc.font('Helvetica-Bold').text('DATE: ', 340, metaBoxY + 7, { continued: true })
       .font('Helvetica').text(new Date(v.created_at).toLocaleDateString('en-GB'));

    const displayRefDoc = sanitizeForPdfKit((v.ref_doctor || 'DIRECT OPD').toUpperCase());
    const formattedRefDoc = displayRefDoc.startsWith('DR') ? displayRefDoc : `DR. ${displayRefDoc}`;
    doc.font('Helvetica-Bold').text('REF. BY: ', 340, metaBoxY + 23, { continued: true })
       .font('Helvetica').text(formattedRefDoc);

    doc.x = 40;
    doc.y = metaBoxY + 50;

    // 3. STUDY TITLE
    let displayTitle = sanitizeForPdfKit((rep.template_name || 'DIAGNOSTIC IMAGING REPORT').replace(/\*\*/g, '').toUpperCase());
    doc.fontSize(11.5).font('Helvetica-Bold').fillColor('#19486a')
       .text(displayTitle, 40, doc.y, { width: 515, align: 'center', underline: true });
    
    doc.moveDown(0.5);
    doc.x = 40;

    // 4. FINDINGS SECTION (With Automatic Table Grouping)
    doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#123352').text('FINDINGS:', 40, doc.y);
    doc.moveDown(0.25);

    const findingsLines = (rep.report_text || 'No significant abnormality recorded.').split('\n');
    doc.fontSize(9.2).fillColor('#111827');

    let tableBuffer = [];
    const flushTableBuffer = () => {
      if (tableBuffer.length > 0) {
        renderPdfTableBlock(doc, tableBuffer, 40, 515, withLetterhead, effectiveMarginMm);
        tableBuffer = [];
        doc.fontSize(9.2).fillColor('#111827');
      }
    };

    for (const fLine of findingsLines) {
      const trimmed = fLine.trim();
      if (!trimmed) {
        flushTableBuffer();
        doc.moveDown(0.15);
        continue;
      }

      if (trimmed.includes('|')) {
        tableBuffer.push(trimmed);
        continue;
      } else {
        flushTableBuffer();
      }

      doc.x = 40;
      renderFormattedPdfLine(doc, trimmed, 40, 515);
      doc.moveDown(0.18);

      if (doc.y > 725) {
        doc.addPage();
        doc.x = 40;
        doc.y = withLetterhead ? 50 : Math.round(effectiveMarginMm * 2.83465);
      }
    }
    flushTableBuffer();

    doc.moveDown(0.4);

    // 5. IMPRESSION SECTION (Separating Main Impression from Disclaimers / Statutory Declarations)
    const rawImpLines = sanitizeForPdfKit((rep.impression || '').replace(/\*\*/g, '').trim())
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);

    const coreImpressionLines = [];
    const footnoteLines = [];

    for (const iLine of rawImpLines) {
      if (/^\(?\s*All\s+measurements/i.test(iLine) || /^I\s*,?\s*Dr\.?/i.test(iLine) || /detected\s+nor\s+disclosed/i.test(iLine)) {
        footnoteLines.push(iLine);
      } else {
        coreImpressionLines.push(iLine);
      }
    }

    if (coreImpressionLines.length > 0) {
      if (doc.y > 680) {
        doc.addPage();
        doc.x = 40;
        doc.y = withLetterhead ? 50 : Math.round(effectiveMarginMm * 2.83465);
      }

      doc.x = 40;
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#123352').text('IMPRESSION:', 40, doc.y);
      doc.moveDown(0.2);

      const impText = coreImpressionLines.join('\n').toUpperCase();
      const impY = doc.y;
      const boxH = Math.max(26, doc.heightOfString(impText, { width: 495 }) + 12);

      doc.rect(40, impY, 515, boxH).fillAndStroke('#f1f5f9', '#94a3b8');
      doc.fontSize(9.2).font('Helvetica-Bold').fillColor('#0f172a')
         .text(impText, 50, impY + 6, { width: 495, lineGap: 2, align: 'left' });

      doc.y = impY + boxH + 8;
      doc.x = 40;
    }

    if (footnoteLines.length > 0) {
      doc.fontSize(7.5).font('Helvetica').fillColor('#334155');
      for (const fn of footnoteLines) {
        doc.text(fn, 40, doc.y, { width: 515, align: 'left', lineGap: 1.5 });
        doc.moveDown(0.15);
      }
      doc.moveDown(0.3);
    }

    // 6. DOCTOR SIGNATURE BLOCK
    if (doc.y > 730) {
      doc.addPage();
      doc.x = 40;
      doc.y = withLetterhead ? 50 : Math.round(effectiveMarginMm * 2.83465);
    }

    const signY = Math.min(755, Math.max(doc.y + 42, 690));

    if (rep.signature_file) {
      try {
        let imgBuffer = null;
        if (rep.signature_file.startsWith('data:image')) {
          const base64Data = rep.signature_file.split(',')[1];
          imgBuffer = Buffer.from(base64Data, 'base64');
        } else {
          const sigFullPath = path.resolve(__dirname, rep.signature_file);
          if (fs.existsSync(sigFullPath)) {
            imgBuffer = sigFullPath;
          }
        }

        if (imgBuffer) {
          doc.image(imgBuffer, 385, signY - 42, { fit: [140, 40], align: 'right' });
        }
      } catch (imgErr) {
        console.error('Signature embed error:', imgErr.message);
      }
    }

    doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#000000')
       .text(sanitizeForPdfKit(rep.doctor_name || 'Dr NIKUNJ KOTHIA'), 330, signY, { width: 225, align: 'right' });

    doc.fontSize(8).font('Helvetica').fillColor('#333333')
       .text(sanitizeForPdfKit(`${rep.doctor_designation || 'Consultant Radiologist'} / Reg: ${rep.doctor_reg_no || '2009/09/3218'}`), 330, signY + 12, { width: 225, align: 'right' });

    doc.end();
  } catch (err) {
    res.status(500).send('Error generating Report PDF: ' + err.message);
  }
});

app.post('/api/visits/:id/send-bill-sms', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const visitRes = await pool.query(
      `SELECT v.*, p.full_name, p.phone, c.centre_name 
       FROM visits v 
       JOIN patients p ON v.patient_id = p.id 
       LEFT JOIN clinic_centres c ON v.centre_id = c.id 
       WHERE v.id::text = $1::text OR v.invoice_number = $1::text`,
      [validId]
    );
    if (!visitRes.rows.length) return res.status(404).json({ success: false, error: 'Visit not found' });

    const v = visitRes.rows[0];
    const net = (parseFloat(v.total_amount) - parseFloat(v.concession || 0)).toFixed(2);
    const pdfUrl = `https://resq-clinic-app.onrender.com/api/invoice/${v.invoice_number}/pdf`;
    const msg = `Dear ${v.full_name}, your bill for ${v.centre_name || 'RESQ Clinic'} is ready. Inv: ${v.invoice_number}, Net: Rs.${net}, Balance: Rs.${parseFloat(v.balance_amount).toFixed(2)}. Download Bill: ${pdfUrl}`;

    const sent = await dispatchSMS(v.phone, msg);
    res.json({ success: true, message: sent ? 'Bill SMS sent successfully!' : 'Bill SMS logged.' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/visits/:id/send-report-sms', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const visitRes = await pool.query(
      `SELECT v.*, p.full_name, p.phone, c.centre_name 
       FROM visits v 
       JOIN patients p ON v.patient_id = p.id 
       LEFT JOIN clinic_centres c ON v.centre_id = c.id 
       WHERE v.id::text = $1::text OR v.invoice_number = $1::text`,
      [validId]
    );
    if (!visitRes.rows.length) return res.status(404).json({ success: false, error: 'Visit not found' });

    const v = visitRes.rows[0];
    if (parseFloat(v.balance_amount) > 0) {
      return res.status(400).json({ 
        success: false, 
        error: `Cannot send report: Outstanding balance of Rs.${parseFloat(v.balance_amount).toFixed(2)} remaining.` 
      });
    }

    const reportUrl = `https://resq-clinic-app.onrender.com/api/imaging/report/${v.invoice_number}/pdf?letterhead=true`;
    const msg = `Dear ${v.full_name}, your diagnostic report from ${v.centre_name || 'RESQ Clinic'} is ready. View/Download: ${reportUrl}`;

    const sent = await dispatchSMS(v.phone, msg);
    res.json({ success: true, message: sent ? 'Report SMS sent successfully!' : 'Report SMS logged.' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/imaging/report/:visitId/download', async (req, res) => {
  try {
    const validId = getCleanId(req.params.visitId);
    const rRes = await pool.query(
      `SELECT r.* FROM imaging_reports r
       JOIN visits v ON r.visit_id = v.id
       WHERE v.id::text = $1::text OR v.invoice_number = $1::text LIMIT 1`,
      [validId]
    );
    if (!rRes.rows.length) return res.status(404).send('Diagnostic report not found.');
    const r = rRes.rows[0];
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="Report_${validId}.txt"`);
    res.send(`RESQ CLINIC & IMAGING CENTRE - DIAGNOSTIC REPORT\nDoctor: ${r.doctor_name}\n\nFINDINGS:\n${r.report_text}\n\nIMPRESSION:\n${r.impression || 'None'}`);
  } catch (err) { res.status(500).send(err.message); }
});

// TESTS MASTER APIS
app.get('/api/tests', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    let query = 'SELECT * FROM test_master WHERE 1=1';
    const params = [];
    if (centreId) {
      params.push(String(centreId));
      query += ` AND (centre_id::text = $${params.length}::text OR centre_id IS NULL)`;
    }
    query += ' ORDER BY test_name ASC';
    const result = await pool.query(query, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/tests', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { testName, category, price, cutType, testCut } = req.body;
    const parsedCut = (testCut !== undefined && testCut !== null && !isNaN(parseFloat(testCut))) ? parseFloat(testCut) : 30;
    const result = await pool.query(
      'INSERT INTO test_master (centre_id, test_name, category, price, cut_type, test_cut) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [centreId, testName, category || 'Pathology', parseFloat(price) || 0, cutType || 'percentage', parsedCut]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/tests/bulk-import', async (req, res) => {
  try {
    const targetCentreId = getCleanId(req.body.centreId) || getTenantCentreId(req);
    const { tests } = req.body;
    if (!Array.isArray(tests) || !tests.length) return res.status(400).json({ success: false, error: 'No test rows provided.' });
    let count = 0;
    for (const t of tests) {
      if (t.testName && t.testName.trim()) {
        const parsedCut = (t.testCut !== undefined && t.testCut !== null && !isNaN(parseFloat(t.testCut))) ? parseFloat(t.testCut) : 30;
        await pool.query(
          `INSERT INTO test_master (centre_id, test_name, category, price, cut_type, test_cut) VALUES ($1, $2, $3, $4, $5, $6)`,
          [targetCentreId, t.testName.trim(), t.category || 'Imaging', parseFloat(t.price) || 0, t.cut_type || 'percentage', parsedCut]
        );
        count++;
      }
    }
    res.status(200).json({ success: true, message: `Successfully imported ${count} test(s).` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/tests/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const { testName, category, price, cutType, testCut } = req.body;
    const parsedCut = (testCut !== undefined && testCut !== null && !isNaN(parseFloat(testCut))) ? parseFloat(testCut) : 30;
    const result = await pool.query(
      `UPDATE test_master SET test_name = $1, category = $2, price = $3, cut_type = $4, test_cut = $5 WHERE id::text = $6::text RETURNING *`,
      [testName, category || 'Pathology', parseFloat(price) || 0, cutType || 'percentage', parsedCut, validId]
    );
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/tests/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    await pool.query('DELETE FROM test_master WHERE id::text = $1::text', [validId]);
    res.status(200).json({ success: true, message: 'Test deleted' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// DOCTORS MASTER APIS
app.get('/api/doctors', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    let query = 'SELECT * FROM referring_doctors WHERE 1=1';
    const params = [];
    if (centreId) {
      params.push(String(centreId));
      query += ` AND (centre_id::text = $${params.length}::text OR centre_id IS NULL)`;
    }
    query += ' ORDER BY doctor_name ASC';
    const result = await pool.query(query, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/doctors', async (req, res) => {
  try {
    const targetCentreId = getCleanId(req.body.centreId) || getTenantCentreId(req);
    const { doctorName, hospitalClinicName, commissionType, commissionValue } = req.body;
    const parsedVal = (commissionValue !== undefined && commissionValue !== null && !isNaN(parseFloat(commissionValue))) ? parseFloat(commissionValue) : 30;
    const result = await pool.query(
      'INSERT INTO referring_doctors (centre_id, doctor_name, hospital_clinic_name, commission_type, commission_value) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [targetCentreId, doctorName, hospitalClinicName, commissionType || 'percentage', parsedVal]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/doctors/bulk-import', async (req, res) => {
  try {
    const targetCentreId = getCleanId(req.body.centreId) || getTenantCentreId(req);
    const { doctors } = req.body;
    if (!Array.isArray(doctors) || !doctors.length) return res.status(400).json({ success: false, error: 'No doctor rows provided.' });
    let count = 0;
    for (const d of doctors) {
      if (d.doctorName && d.doctorName.trim()) {
        const parsedVal = (d.commissionValue !== undefined && d.commissionValue !== null && !isNaN(parseFloat(d.commissionValue))) ? parseFloat(d.commissionValue) : 30;
        await pool.query(
          `INSERT INTO referring_doctors (centre_id, doctor_name, hospital_clinic_name, commission_type, commission_value) VALUES ($1, $2, $3, $4, $5)`,
          [targetCentreId, d.doctorName.trim(), d.hospitalClinicName || '', d.commissionType || 'percentage', parsedVal]
        );
        count++;
      }
    }
    res.status(200).json({ success: true, message: `Successfully imported ${count} doctor(s).` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/doctors/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    if (!validId) return res.status(400).json({ success: false, error: 'Invalid Doctor ID' });
    const { doctorName, hospitalClinicName, commissionType, commissionValue, centreId } = req.body;
    if (!doctorName || !doctorName.trim()) return res.status(400).json({ success: false, error: 'Doctor name required.' });

    const parsedVal = (commissionValue !== undefined && commissionValue !== null && !isNaN(parseFloat(commissionValue))) ? parseFloat(commissionValue) : 30;
    const result = await pool.query(
      `UPDATE referring_doctors 
       SET doctor_name = $1, hospital_clinic_name = $2, commission_type = $3, commission_value = $4, centre_id = COALESCE($5, centre_id)
       WHERE id::text = $6::text RETURNING *`,
      [doctorName.trim(), hospitalClinicName || '', commissionType || 'percentage', parsedVal, getCleanId(centreId), validId]
    );
    if (result.rowCount === 0) return res.status(404).json({ success: false, error: 'Doctor not found.' });
    res.status(200).json({ success: true, data: result.rows[0], message: 'Doctor updated successfully!' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/doctors/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const validId = getCleanId(req.params.id);
    if (!validId) return res.status(400).json({ success: false, error: 'Invalid Doctor ID' });

    await client.query('BEGIN');
    await client.query('UPDATE visits SET referring_doctor_id = NULL WHERE referring_doctor_id::text = $1::text', [validId]);
    const delRes = await client.query('DELETE FROM referring_doctors WHERE id::text = $1::text RETURNING id', [validId]);
    await client.query('COMMIT');

    if (delRes.rowCount === 0) return res.status(404).json({ success: false, error: 'Doctor not found.' });
    res.status(200).json({ success: true, message: 'Doctor deleted successfully.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 1. GET TEMPLATES
app.get('/api/imaging/templates', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { category, search } = req.query;

    let dbQuery = `
      SELECT id, centre_id, template_name, title, category, default_impression, template_body,
             (file_data IS NOT NULL) as has_file
      FROM imaging_templates
      WHERE 1=1
    `;
    const params = [];

    if (centreId) {
      params.push(String(centreId));
      dbQuery += ` AND (centre_id::text = $${params.length}::text OR centre_id IS NULL)`;
    }

    if (category && category.trim()) {
      params.push(`%${category.trim()}%`);
      dbQuery += ` AND category ILIKE $${params.length}`;
    }

    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      dbQuery += ` AND (title ILIKE $${params.length} OR template_name ILIKE $${params.length})`;
    }

    dbQuery += ' ORDER BY (centre_id IS NOT NULL) DESC, title ASC';

    const result = await pool.query(dbQuery, params);
    const templates = result.rows.map(t => ({
      id: t.id,
      centre_id: t.centre_id,
      template_name: t.template_name,
      title: t.title,
      category: t.category || 'Ultrasonography',
      default_impression: t.default_impression || '',
      template_body: t.template_body || '',
      is_centre_specific: Boolean(t.centre_id)
    }));

    res.status(200).json({ success: true, data: templates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. ADD SINGLE TEMPLATE
app.post('/api/imaging/templates/single', upload.single('templateFile'), async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    if (!centreId) return res.status(400).json({ success: false, error: 'Centre ID is required.' });

    const { title, category } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ success: false, error: 'Please select a Word template (.docx or .doc).' });

    const cleanTitle = (title && title.trim())
      ? title.trim().toUpperCase()
      : path.basename(file.originalname, path.extname(file.originalname)).replace(/_/g, ' ').toUpperCase();

    const chosenCategory = category || 'Ultrasonography';
    const { body, impression } = extractTextFromUploadedFile(file.path);
    const fileBuffer = fs.readFileSync(file.path);

    const existing = await pool.query(
      `SELECT id FROM imaging_templates 
       WHERE template_name = $1 AND centre_id::text = $2::text LIMIT 1`,
      [file.originalname, String(centreId)]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE imaging_templates 
         SET title = $1, category = $2, template_body = $3, default_impression = $4, file_data = $5 
         WHERE id = $6`,
        [cleanTitle, chosenCategory, body, impression, fileBuffer, existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO imaging_templates (centre_id, template_name, title, category, template_body, default_impression, file_data) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [centreId, file.originalname, cleanTitle, chosenCategory, body, impression, fileBuffer]
      );
    }

    res.status(200).json({ success: true, message: `Template "${cleanTitle}" saved permanently for this centre!` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. BULK UPLOAD TEMPLATES
app.post('/api/imaging/templates/bulk-upload', upload.array('templateFiles'), async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    if (!centreId) return res.status(400).json({ success: false, error: 'Centre ID is required.' });

    const files = req.files || [];
    let count = 0;

    for (const f of files) {
      const baseName = path.basename(f.originalname, path.extname(f.originalname));
      const cleanTitle = baseName.replace(/_/g, ' ').toUpperCase();
      const { body, impression } = extractTextFromUploadedFile(f.path);
      const fileBuffer = fs.readFileSync(f.path);

      let category = 'Ultrasonography';
      const low = f.originalname.toLowerCase();
      if (low.includes('echo')) category = 'Echocardiography';
      else if (low.includes('doppler')) category = 'Color Doppler';
      else if (low.includes('x-ray') || low.includes('xray')) category = 'Digital X-Ray';
      else if (low.includes('trimester') || low.includes('anomaly') || low.includes('obstetric') || low.includes('pregnancy')) category = 'Obstetrics';

      const existing = await pool.query(
        `SELECT id FROM imaging_templates 
         WHERE template_name = $1 AND centre_id::text = $2::text LIMIT 1`,
        [f.originalname, String(centreId)]
      );

      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE imaging_templates 
           SET title = $1, category = $2, template_body = $3, default_impression = $4, file_data = $5 
           WHERE id = $6`,
          [cleanTitle, category, body, impression, fileBuffer, existing.rows[0].id]
        );
      } else {
        await pool.query(
          `INSERT INTO imaging_templates (centre_id, template_name, title, category, template_body, default_impression, file_data) 
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [centreId, f.originalname, cleanTitle, category, body, impression, fileBuffer]
        );
      }
      count++;
    }

    res.status(200).json({ success: true, message: `Successfully saved ${count} template(s) permanently for this centre!` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. DELETE SINGLE TEMPLATE
app.delete('/api/imaging/templates/:identifier', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const identifier = req.params.identifier;

    if (!centreId) {
      return res.status(400).json({ success: false, error: 'Centre ID is required to delete templates.' });
    }

    const result = await pool.query(
      `DELETE FROM imaging_templates 
       WHERE (id::text = $1 OR template_name = $1) 
       AND centre_id::text = $2::text RETURNING id`,
      [identifier, String(centreId)]
    );

    const localCentrePath = path.join(TEMPLATES_DIR, String(centreId), identifier);
    if (fs.existsSync(localCentrePath)) {
      try { fs.unlinkSync(localCentrePath); } catch (e) {}
    }

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Template not found for this centre or cannot be deleted.' });
    }

    res.status(200).json({ success: true, message: 'Centre template deleted permanently!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. EDIT / UPDATE EXISTING TEMPLATE TITLE OR CATEGORY
app.put('/api/imaging/templates/:identifier', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const identifier = decodeURIComponent(req.params.identifier);
    const { title, category } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Template title cannot be empty.' });
    }

    const cleanTitle = title.trim().toUpperCase();
    const cleanCat = category || 'Ultrasonography';

    let query = `
      UPDATE imaging_templates 
      SET title = $1, category = $2 
      WHERE (id::text = $3 OR template_name = $3)
    `;
    const params = [cleanTitle, cleanCat, identifier];

    if (centreId) {
      params.push(String(centreId));
      query += ` AND (centre_id::text = $4::text OR centre_id IS NULL)`;
    }

    query += ` RETURNING *`;

    const result = await pool.query(query, params);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, error: 'Template not found or cannot be modified for this centre.' });
    }

    res.status(200).json({ success: true, message: 'Template updated successfully!', data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. CLEAR ALL TEMPLATES
app.post('/api/imaging/templates/clear-all', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    if (!centreId) {
      return res.status(400).json({ success: false, error: 'Centre ID is required.' });
    }

    await pool.query('DELETE FROM imaging_templates WHERE centre_id::text = $1::text', [String(centreId)]);

    const centreDir = path.join(TEMPLATES_DIR, String(centreId));
    if (fs.existsSync(centreDir)) {
      const files = fs.readdirSync(centreDir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(centreDir, f)); } catch (e) {}
      }
    }

    res.status(200).json({ success: true, message: 'All templates for this centre were deleted permanently!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. GENERATE DOC
app.post('/api/imaging/templates/generate-doc', async (req, res) => {
  try {
    const { templateName, patientName, date, age, gender, refDoctor, marginOverrideMm, centreId: explicitCentreId } = req.body;
    const centreId = explicitCentreId || getTenantCentreId(req);
    if (!templateName) return res.status(400).json({ success: false, error: 'Template name is required' });

    let centreObj = null;
    if (centreId) {
      const cRes = await pool.query('SELECT * FROM clinic_centres WHERE id::text = $1::text', [String(centreId)]);
      if (cRes.rows.length) centreObj = cRes.rows[0];
    }
    if (!centreObj && centreId) {
      centreObj = FALLBACK_CENTRES.find(c => String(c.id) === String(centreId));
    }
    if (!centreObj) centreObj = FALLBACK_CENTRES[0];

    let topMarginMm = centreObj.top_margin_mm || 55;
    let bottomMarginMm = centreObj.bottom_margin_mm || 15;
    if (marginOverrideMm && !isNaN(parseInt(marginOverrideMm, 10))) {
      topMarginMm = parseInt(marginOverrideMm, 10);
    }

    let templateBuffer = null;
    let ext = '.docx';

    if (centreId) {
      const dbRes = await pool.query(
        `SELECT file_data, template_name FROM imaging_templates 
         WHERE (template_name = $1 OR title = $1) 
         AND centre_id::text = $2::text 
         AND file_data IS NOT NULL LIMIT 1`,
        [templateName, String(centreId)]
      );
      if (dbRes.rows.length > 0 && dbRes.rows[0].file_data) {
        templateBuffer = dbRes.rows[0].file_data;
        ext = path.extname(dbRes.rows[0].template_name || '').toLowerCase() || '.docx';
      }
    }

    if (!templateBuffer) {
      const globalDbRes = await pool.query(
        `SELECT file_data, template_name FROM imaging_templates 
         WHERE (template_name = $1 OR title = $1) 
         AND centre_id IS NULL 
         AND file_data IS NOT NULL LIMIT 1`,
        [templateName]
      );
      if (globalDbRes.rows.length > 0 && globalDbRes.rows[0].file_data) {
        templateBuffer = globalDbRes.rows[0].file_data;
        ext = path.extname(globalDbRes.rows[0].template_name || '').toLowerCase() || '.docx';
      }
    }

    if (!templateBuffer) {
      let targetPath = null;
      if (centreId) {
        const cPath = path.join(TEMPLATES_DIR, String(centreId), templateName);
        if (fs.existsSync(cPath)) targetPath = cPath;
      }
      if (!targetPath) {
        const gPath = path.join(TEMPLATES_DIR, templateName);
        if (fs.existsSync(gPath)) targetPath = gPath;
      }
      if (targetPath && fs.existsSync(targetPath)) {
        templateBuffer = fs.readFileSync(targetPath);
        ext = path.extname(targetPath).toLowerCase();
      }
    }

    if (!templateBuffer) {
      return res.status(404).json({ success: false, error: `Template "${templateName}" file data not found in database for this centre.` });
    }

    const ptName = (patientName || 'PATIENT NAME').toUpperCase();
    const dt = date || new Date().toLocaleDateString('en-GB');
    const ag = age ? (String(age).toUpperCase().includes('YR') ? String(age).toUpperCase() : `${age} YRS`) : 'ADULT';
    const sx = (gender || 'FEMALE').toUpperCase();
    const doc = (refDoctor || 'DIRECT OPD').toUpperCase();

    const topDxa = Math.round(topMarginMm * 56.6929);
    const bottomDxa = Math.round(bottomMarginMm * 56.6929);

    let isZip = false;
    if (templateBuffer[0] === 0x50 && templateBuffer[1] === 0x4b) isZip = true;

    if (ext === '.docx' || isZip) {
      const zip = new AdmZip(templateBuffer);
      const docEntry = zip.getEntry('word/document.xml') || zip.getEntries().find(e => e.entryName.toLowerCase().includes('word/document.xml'));
      if (!docEntry) throw new Error('Invalid Word document structure: word/document.xml not found');

      let docXml = docEntry.getData().toString('utf-8');
      docXml = docXml.replace(/(<w:pgMar[^>]*?\bw:top=")[^"]*(")/g, `$1${topDxa}$2`);
      docXml = docXml.replace(/(<w:pgMar[^>]*?\bw:bottom=")[^"]*(")/g, `$1${bottomDxa}$2`);

      docXml = docXml
        .replace(/&lt;\*NAME1\*&gt;|<\*NAME1\*>|{{NAME}}|{{PATIENT_NAME}}/g, escapeXml(ptName))
        .replace(/&lt;\*DATE\*&gt;|<\*DATE\*>|{{DATE}}/g, escapeXml(dt))
        .replace(/&lt;Age&gt;|<Age>|{{AGE}}/g, escapeXml(ag))
        .replace(/&lt;Sex&gt;|<Sex>|{{SEX}}|{{GENDER}}/g, escapeXml(sx))
        .replace(/&lt;\*Consultant\/Gp1\*&gt;|<\*Consultant\/Gp1\*>|{{REF_DOCTOR}}|{{DOCTOR}}/g, escapeXml(doc));

      docXml = docXml
        .replace(/(NAME\s+(?:MS\.|MR\.|MRS\.|MAST\.)?\s*)([A-Z\s._]{2,30}?)(?=\s+DATE)/i, `$1${escapeXml(ptName)} `)
        .replace(/(DATE\s*)([0-9/.-]+|\/05\/2014)/i, `$1${escapeXml(dt)}`)
        .replace(/(\d+\s*YRS?\s*\/\s*[MF])/i, `${escapeXml(ag)} / ${escapeXml(sx)}`)
        .replace(/(REF\.?\s*BY\s*DR\.?\s*)([A-Z\s.]{0,30})(?=(SONOGRAPHY|OBSTETRIC|TECHNIQUE|LIVER|<\/w:t>))/i, `$1${escapeXml(doc)} `);

      zip.updateFile(docEntry.entryName, Buffer.from(docXml, 'utf-8'));
      const outputBuffer = zip.toBuffer();

      const safeName = ptName.replace(/[^a-zA-Z0-9]/g, '_');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(templateName, ext)}_${safeName}.docx"`);
      return res.send(outputBuffer);
    }

    let binaryData = templateBuffer.toString('binary');
    if (binaryData.includes('<*NAME1*>') || binaryData.includes('{{NAME}}') || binaryData.includes('{{PATIENT_NAME}}')) {
      binaryData = binaryData
        .replace(/<\*NAME1\*>/g, ptName)
        .replace(/<\*DATE\*>/g, dt)
        .replace(/<Age>/g, ag)
        .replace(/<Sex>/g, sx)
        .replace(/<\*Consultant\/Gp1\*>/g, doc)
        .replace(/{{NAME}}|{{PATIENT_NAME}}/gi, ptName)
        .replace(/{{DATE}}/gi, dt)
        .replace(/{{AGE}}/gi, ag)
        .replace(/{{SEX}}|{{GENDER}}/gi, sx)
        .replace(/{{REF_DOCTOR}}|{{DOCTOR}}/gi, doc);
    } else {
      binaryData = binaryData
        .replace(/NAME\s+MS\.\s+/g, `NAME MS. ${ptName} `)
        .replace(/NAME\s+MR\.\s+/g, `NAME MR. ${ptName} `)
        .replace(/NAME\s+MRS\.\s+/g, `NAME MRS. ${ptName} `)
        .replace(/07\.05\.2014\./g, dt)
        .replace(/\/05\/2014/g, dt)
        .replace(/22\s*YRS\s*\/\s*F/g, `${ag} / ${sx}`)
        .replace(/REF\.\s*BY\s*DR\.\s*/g, `REF. BY DR. ${doc} `)
        .replace(/REF\s*BY\s+DR\.\s*/g, `REF. BY DR. ${doc} `);
    }

    const safeName = ptName.replace(/[^a-zA-Z0-9]/g, '_');
    res.setHeader('Content-Type', 'application/msword');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(templateName, ext)}_${safeName}.doc"`);
    res.send(Buffer.from(binaryData, 'binary'));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. BULK DOWNLOAD
app.get('/api/imaging/templates/bulk-download', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const zip = new AdmZip();

    let query = 'SELECT template_name, file_data FROM imaging_templates WHERE file_data IS NOT NULL';
    const params = [];
    if (centreId) {
      params.push(String(centreId));
      query += ` AND (centre_id::text = $1::text OR centre_id IS NULL)`;
    }

    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No templates with file data found for this centre.' });
    }

    const added = new Set();
    for (const row of result.rows) {
      if (!added.has(row.template_name.toLowerCase())) {
        added.add(row.template_name.toLowerCase());
        zip.addFile(row.template_name, row.file_data);
      }
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Templates_${centreId || 'Export'}.zip"`);
    res.send(zip.toBuffer());
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/imaging/reports', async (req, res) => {
  try {
    const { visitId, patientId, templateId, templateName, reportText, impression, doctorName, doctorRegNo } = req.body;
    const centreId = getTenantCentreId(req);
    const validVisitId = getCleanId(visitId);

    let existing = { rows: [] };
    if (validVisitId) {
      existing = await pool.query('SELECT id FROM imaging_reports WHERE visit_id::text = $1::text OR visit_id IN (SELECT id FROM visits WHERE invoice_number = $1::text)', [validVisitId]);
    }

    let result;
    if (existing.rows.length > 0) {
      result = await pool.query(
        `UPDATE imaging_reports 
         SET template_id = $1, template_name = $2, report_text = $3, impression = $4, doctor_name = $5, doctor_reg_no = $6, created_at = CURRENT_TIMESTAMP
         WHERE id = $7 RETURNING *`,
        [getCleanId(templateId), templateName, reportText || 'Opened in Word', impression || '', doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', existing.rows[0].id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO imaging_reports (visit_id, patient_id, centre_id, template_id, template_name, report_text, impression, doctor_name, doctor_reg_no, doctor_designation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [validVisitId, getCleanId(patientId), centreId, getCleanId(templateId), templateName, reportText || 'Opened in Word', impression || '', doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', 'Consultant Radiologist']
      );
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// REPORTS & AUDIT APIS (WITH MODALITY COLLECTED AMOUNT & CONCESSION BIFURCATION)
app.get('/api/reports/collection', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { category, startDate, endDate, month, patientName, pendingOnly } = req.query;

    let query = `
      SELECT v.id as visit_id, v.created_at, v.total_amount, v.concession, v.paid_amount, v.balance_amount,
             v.payment_status, v.payment_mode, v.cash_amount, v.online_amount, v.bill_printed, v.invoice_number, 
             v.report_file, v.report_has_letterhead, v.report_margin_mm,
             COALESCE(v.doctor_commission, 0.00) as doctor_commission,
             COALESCE(d.doctor_name, 'Direct OPD / Self') as referring_doctor_name,
             p.full_name, p.phone, COALESCE(c.centre_name, 'Main Centre') as centre_name,
             EXISTS(SELECT 1 FROM pcpndt_forms pf WHERE pf.visit_id = v.id) as has_pcpndt,
             COALESCE((
               SELECT string_agg(DISTINCT tm.category, ', ')
               FROM patient_investigations pi
               JOIN test_master tm ON pi.test_id = tm.id
               WHERE pi.visit_id = v.id
             ), 'General') as categories
      FROM visits v
      JOIN patients p ON v.patient_id = p.id
      LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
      LEFT JOIN clinic_centres c ON v.centre_id = c.id
      WHERE 1=1
    `;
    let params = [];
    if (centreId) {
      params.push(String(centreId));
      query += ` AND (v.centre_id::text = $${params.length}::text OR v.centre_id IS NULL)`;
    }
    if (pendingOnly === 'true' || pendingOnly === true) {
      query += ` AND v.balance_amount > 0`;
    }
    if (startDate && startDate.trim()) {
      params.push(startDate.trim());
      query += ` AND v.created_at::date >= $${params.length}::date`;
    }
    if (endDate && endDate.trim()) {
      params.push(endDate.trim());
      query += ` AND v.created_at::date <= $${params.length}::date`;
    }
    if (month && month.trim() && !startDate && !endDate) {
      params.push(`${month.trim()}%`);
      query += ` AND TO_CHAR(v.created_at, 'YYYY-MM') LIKE $${params.length}`;
    }
    if (patientName && patientName.trim()) {
      params.push(`%${patientName.trim()}%`);
      query += ` AND (p.full_name ILIKE $${params.length} OR p.phone ILIKE $${params.length} OR v.invoice_number ILIKE $${params.length})`;
    }
    if (category && category.trim()) {
      params.push(`%${category.trim()}%`);
      query += ` AND EXISTS (
        SELECT 1 FROM patient_investigations pi2
        JOIN test_master tm2 ON pi2.test_id = tm2.id
        WHERE pi2.visit_id = v.id AND tm2.category ILIKE $${params.length}
      )`;
    }

    query += ` ORDER BY v.created_at DESC LIMIT 500`;
    const result = await pool.query(query, params);

    let catQuery = `
      SELECT 
        COALESCE(NULLIF(TRIM(tm.category), ''), 'General / Direct') as category,
        COUNT(pi.id) as test_count,
        COALESCE(SUM(pi.price), 0)::numeric(10,2) as category_gross,
        COALESCE(SUM(
          CASE WHEN v.total_amount > 0 THEN (pi.price / v.total_amount) * COALESCE(v.concession, 0) ELSE 0 END
        ), 0)::numeric(10,2) as category_concession,
        COALESCE(SUM(
          CASE WHEN v.total_amount > 0 THEN (pi.price / v.total_amount) * COALESCE(v.paid_amount, 0) ELSE 0 END
        ), 0)::numeric(10,2) as category_collected,
        COALESCE(SUM(
          CASE WHEN v.total_amount > 0 THEN (pi.price / v.total_amount) * COALESCE(v.paid_amount, 0) ELSE 0 END
        ), 0)::numeric(10,2) as category_total
      FROM patient_investigations pi
      JOIN visits v ON pi.visit_id = v.id
      JOIN patients p ON v.patient_id = p.id
      LEFT JOIN test_master tm ON pi.test_id = tm.id
      WHERE 1=1
    `;
    let catParams = [];
    if (centreId) {
      catParams.push(String(centreId));
      catQuery += ` AND (v.centre_id::text = $${catParams.length}::text OR v.centre_id IS NULL)`;
    }
    if (pendingOnly === 'true' || pendingOnly === true) {
      catQuery += ` AND v.balance_amount > 0`;
    }
    if (startDate && startDate.trim()) {
      catParams.push(startDate.trim());
      catQuery += ` AND v.created_at::date >= $${catParams.length}::date`;
    }
    if (endDate && endDate.trim()) {
      catParams.push(endDate.trim());
      catQuery += ` AND v.created_at::date <= $${catParams.length}::date`;
    }
    if (month && month.trim() && !startDate && !endDate) {
      catParams.push(`${month.trim()}%`);
      catQuery += ` AND TO_CHAR(v.created_at, 'YYYY-MM') LIKE $${catParams.length}`;
    }
    if (patientName && patientName.trim()) {
      catParams.push(`%${patientName.trim()}%`);
      catQuery += ` AND (p.full_name ILIKE $${catParams.length} OR p.phone ILIKE $${catParams.length} OR v.invoice_number ILIKE $${catParams.length})`;
    }
    catQuery += ` GROUP BY COALESCE(NULLIF(TRIM(tm.category), ''), 'General / Direct') ORDER BY category_collected DESC`;
    
    let catRows = [];
    try {
      const catRes = await pool.query(catQuery, catParams);
      catRows = catRes.rows;
    } catch (e) {
      console.error('catQuery error:', e.message);
    }

    let grossTotal = 0, totalCollection = 0, totalPending = 0;
    result.rows.forEach(r => {
      grossTotal += parseFloat(r.total_amount || 0);
      totalCollection += parseFloat(r.paid_amount || 0);
      totalPending += parseFloat(r.balance_amount || 0);
    });

    res.status(200).json({
      success: true,
      data: result.rows,
      summary: { totalCollection, totalPending, grossTotal, recordCount: result.rows.length },
      categoryBifurcation: catRows
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/reports/doctor-detailed', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { doctorId, startDate, endDate, month, patientName } = req.query;

    let query = `
      SELECT v.id as visit_id, v.created_at, v.total_amount, v.concession,
             COALESCE(v.paid_amount, 0.00) as paid_amount,
             COALESCE(v.balance_amount, 0.00) as balance_amount,
             COALESCE(v.doctor_commission, 0.00) as doctor_commission, 
             v.invoice_number, p.full_name,
             COALESCE(d.doctor_name, 'Direct OPD / Self') as doctor_name,
             COALESCE(d.hospital_clinic_name, '-') as hospital_clinic_name,
             COALESCE(c.centre_name, 'Main Centre') as centre_name
      FROM visits v
      JOIN patients p ON v.patient_id = p.id
      LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
      LEFT JOIN clinic_centres c ON v.centre_id = c.id
      WHERE 1=1
    `;
    let params = [];
    if (centreId) {
      params.push(String(centreId));
      query += ` AND (v.centre_id::text = $${params.length}::text OR v.centre_id IS NULL)`;
    }
    if (doctorId && doctorId.trim()) {
      params.push(String(doctorId.trim()));
      query += ` AND v.referring_doctor_id::text = $${params.length}::text`;
    }
    if (startDate && startDate.trim()) {
      params.push(startDate.trim());
      query += ` AND v.created_at::date >= $${params.length}::date`;
    }
    if (endDate && endDate.trim()) {
      params.push(endDate.trim());
      query += ` AND v.created_at::date <= $${params.length}::date`;
    }
    if (month && month.trim() && !startDate && !endDate) {
      params.push(`${month.trim()}%`);
      query += ` AND TO_CHAR(v.created_at, 'YYYY-MM') LIKE $${params.length}`;
    }
    if (patientName && patientName.trim()) {
      params.push(`%${patientName.trim()}%`);
      query += ` AND p.full_name ILIKE $${params.length}`;
    }

    query += ' ORDER BY v.created_at DESC LIMIT 500';
    const result = await pool.query(query, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/reports/executive-daily', async (req, res) => {
  try {
    const targetDate = req.query.date || new Date().toISOString().slice(0, 10);
    let query = `
      SELECT c.id as centre_id, c.centre_name,
             COUNT(DISTINCT v.id) as total_patients,
             COALESCE(SUM(v.total_amount), 0) as gross_revenue,
             COALESCE(SUM(v.concession), 0) as total_discount,
             COALESCE(SUM(CASE 
               WHEN v.payment_mode = 'Cash' THEN v.paid_amount 
               WHEN v.payment_mode = 'Split' THEN COALESCE(v.cash_amount, 0)
               ELSE 0 
             END), 0) as cash_collected,
             COALESCE(SUM(CASE 
               WHEN v.payment_mode = 'Cash' THEN 0 
               WHEN v.payment_mode = 'Split' THEN COALESCE(v.online_amount, 0)
               ELSE v.paid_amount 
             END), 0) as upi_collected,
             COALESCE(SUM(v.paid_amount), 0) as total_collected,
             COALESCE(SUM(v.balance_amount), 0) as pending_balance,
             COALESCE(SUM(v.doctor_commission), 0) as total_cuts,
             COUNT(DISTINCT pf.id) as pcpndt_count,
             COUNT(DISTINCT CASE WHEN tm.category = 'Imaging' THEN pi.id END) as imaging_count
      FROM clinic_centres c
      LEFT JOIN visits v ON v.centre_id = c.id AND v.created_at::date = $1::date
      LEFT JOIN pcpndt_forms pf ON pf.visit_id = v.id
      LEFT JOIN patient_investigations pi ON pi.visit_id = v.id
      LEFT JOIN test_master tm ON pi.test_id = tm.id
      GROUP BY c.id, c.centre_name
      ORDER BY c.created_at ASC
    `;
    const result = await pool.query(query, [targetDate]);
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// STATUTORY PCPNDT APIS
app.get('/api/pcpndt', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { startDate, endDate, month, search } = req.query;

    let query = `
      SELECT pf.*, pf.created_at as form_date, p.full_name as patient_name, p.age as patient_age, 
             p.address as patient_address, v.invoice_number,
             COALESCE(d.doctor_name, 'Direct OPD / Self') as referring_doctor_name,
             c.centre_name, COALESCE(pf.place, c.place, 'Kandivali West') as place
      FROM pcpndt_forms pf
      JOIN visits v ON pf.visit_id = v.id
      JOIN patients p ON v.patient_id = p.id
      LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
      LEFT JOIN clinic_centres c ON pf.centre_id = c.id
      WHERE 1=1
    `;
    let params = [];
    if (centreId) {
      params.push(String(centreId));
      query += ` AND (pf.centre_id::text = $${params.length}::text OR v.centre_id::text = $${params.length}::text)`;
    }
    if (startDate) {
      params.push(startDate);
      query += ` AND pf.created_at::date >= $${params.length}::date`;
    }
    if (endDate) {
      params.push(endDate);
      query += ` AND pf.created_at::date <= $${params.length}::date`;
    }
    if (month) {
      params.push(`${month}%`);
      query += ` AND TO_CHAR(pf.created_at, 'YYYY-MM') LIKE $${params.length}`;
    }
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      query += ` AND (p.full_name ILIKE $${params.length} OR v.invoice_number ILIKE $${params.length})`;
    }
    query += ' ORDER BY pf.created_at DESC LIMIT 500';
    const result = await pool.query(query, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/pcpndt/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const { 
      relativeName, lmpDate, weeksOfPreg, noOfSons, sonsAge, noOfDaughters, 
      daughtersAge, indications, scanResult, doctorName, doctorRegNo, clinicRegNo, place, centreId 
    } = req.body;

    const result = await pool.query(
      `UPDATE pcpndt_forms 
       SET relative_name = $1, lmp_date = $2, weeks_of_preg = $3, no_of_sons = $4, sons_age = $5,
           no_of_daughters = $6, daughters_age = $7, indications = $8, scan_result = $9,
           doctor_name = $10, doctor_reg_no = $11, clinic_reg_no = $12, place = $13,
           centre_id = COALESCE($14, centre_id)
       WHERE id::text = $15::text RETURNING *`,
      [
        relativeName || '', lmpDate || '', weeksOfPreg || '', parseInt(noOfSons, 10) || 0, sonsAge || '',
        parseInt(noOfDaughters, 10) || 0, daughtersAge || '', indications || '', scanResult || '',
        doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', clinicRegNo || 'RC197', 
        place || 'Kandivali West', getCleanId(centreId), validId
      ]
    );
    res.status(200).json({ success: true, data: result.rows[0], message: 'Statutory Form F updated successfully!' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/pcpndt/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    await pool.query('DELETE FROM pcpndt_forms WHERE id::text = $1::text', [validId]);
    res.status(200).json({ success: true, message: 'Form F deleted' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// HIGH-SPEED BATCH CLOUD SYNC API
app.post('/api/sync/cloud', async (req, res) => {
  if (!cleanCloudUrl) {
    return res.status(400).json({ success: false, error: 'CLOUD_DATABASE_URL is not defined in your environment variables (.env)' });
  }

  if (cleanDbUrl === cleanCloudUrl) {
    return res.status(200).json({
      success: true,
      message: 'Cloud Sync Notice: Your active system is already running directly on the Cloud Database.'
    });
  }

  let localClient, cloudClient;
  try {
    localClient = await pool.connect();
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Local DB connection error: ' + err.message });
  }

  try {
    cloudClient = await cloudPool.connect();
  } catch (err) {
    localClient.release();
    return res.status(503).json({ success: false, error: 'Cannot connect to Cloud Database. Verify CLOUD_DATABASE_URL credentials.' });
  }

  const startTime = Date.now();

  const isValidUuid = (val) => {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(val || '').trim());
  };

  try {
    await cloudClient.query('BEGIN');
    await cloudClient.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    try {
      await cloudClient.query(`
        ALTER TABLE patient_investigations DROP CONSTRAINT IF EXISTS patient_investigations_visit_id_fkey;
        ALTER TABLE patient_investigations ADD CONSTRAINT patient_investigations_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE;
        ALTER TABLE pcpndt_forms DROP CONSTRAINT IF EXISTS pcpndt_forms_visit_id_fkey;
        ALTER TABLE pcpndt_forms ADD CONSTRAINT pcpndt_forms_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE;
        ALTER TABLE imaging_reports DROP CONSTRAINT IF EXISTS imaging_reports_visit_id_fkey;
        ALTER TABLE imaging_reports ADD CONSTRAINT imaging_reports_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE CASCADE;
        ALTER TABLE imaging_reports DROP CONSTRAINT IF EXISTS imaging_reports_template_id_fkey;
      `);
    } catch (e) {}

    await cloudClient.query(`
      CREATE TABLE IF NOT EXISTS radiologists (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        centre_id UUID REFERENCES clinic_centres(id) ON DELETE CASCADE,
        doctor_name VARCHAR(255) NOT NULL,
        designation VARCHAR(255) DEFAULT 'Consultant Radiologist',
        reg_no VARCHAR(100) DEFAULT '2009/09/3218',
        signature_file TEXT,
        is_global BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE radiologists ADD COLUMN IF NOT EXISTS is_global BOOLEAN DEFAULT true;
      ALTER TABLE radiologists ADD COLUMN IF NOT EXISTS designation VARCHAR(255) DEFAULT 'Consultant Radiologist';
      ALTER TABLE radiologists ADD COLUMN IF NOT EXISTS reg_no VARCHAR(100) DEFAULT '2009/09/3218';
      ALTER TABLE radiologists ADD COLUMN IF NOT EXISTS signature_file TEXT;
      ALTER TABLE radiologists ALTER COLUMN signature_file TYPE TEXT;

      ALTER TABLE imaging_reports ADD COLUMN IF NOT EXISTS doctor_designation VARCHAR(255) DEFAULT 'Consultant Radiologist';
      ALTER TABLE imaging_reports ADD COLUMN IF NOT EXISTS signature_file TEXT;
      ALTER TABLE imaging_reports ALTER COLUMN signature_file TYPE TEXT;
    `);

    const auths = await localClient.query('SELECT * FROM app_auth WHERE role = $1', ['admin']);
    if (auths.rows.length > 0) {
      await bulkInsert(cloudClient, 'app_auth', ['id', 'role', 'password'], auths.rows, 10, 'ON CONFLICT (id) DO UPDATE SET password = EXCLUDED.password');
    }

    const centres = await localClient.query('SELECT * FROM clinic_centres');
    const mappedCentres = centres.rows.map(c => ({
      ...c,
      place: c.place || 'Kandivali West',
      phone: c.phone || '',
      reg_no: c.reg_no || 'RC197',
      email: c.email || '',
      centre_password: c.centre_password || '1234',
      owner_password: c.owner_password || 'owner123',
      top_margin_mm: c.top_margin_mm || 55,
      bottom_margin_mm: c.bottom_margin_mm || 15
    }));
    await bulkInsert(cloudClient, 'clinic_centres', [
      'id', 'centre_name', 'tagline', 'address', 'place', 'phone', 'reg_no', 'email',
      'centre_password', 'owner_password', 'is_private', 'top_margin_mm', 'bottom_margin_mm', 'created_at'
    ], mappedCentres, 50, `ON CONFLICT (id) DO UPDATE SET 
      centre_name = EXCLUDED.centre_name, tagline = EXCLUDED.tagline, address = EXCLUDED.address, place = EXCLUDED.place,
      phone = EXCLUDED.phone, reg_no = EXCLUDED.reg_no, email = EXCLUDED.email,
      centre_password = EXCLUDED.centre_password, owner_password = EXCLUDED.owner_password, is_private = EXCLUDED.is_private,
      top_margin_mm = EXCLUDED.top_margin_mm, bottom_margin_mm = EXCLUDED.bottom_margin_mm`);

    const doctors = await localClient.query('SELECT * FROM referring_doctors');
    await bulkInsert(cloudClient, 'referring_doctors', [
      'id', 'centre_id', 'doctor_name', 'hospital_clinic_name', 'commission_type', 'commission_value'
    ], doctors.rows, 100, `ON CONFLICT (id) DO UPDATE SET 
      centre_id = EXCLUDED.centre_id, doctor_name = EXCLUDED.doctor_name, 
      hospital_clinic_name = EXCLUDED.hospital_clinic_name, 
      commission_type = EXCLUDED.commission_type, commission_value = EXCLUDED.commission_value`);

    const tests = await localClient.query('SELECT * FROM test_master');
    await bulkInsert(cloudClient, 'test_master', [
      'id', 'centre_id', 'test_name', 'category', 'price', 'cut_type', 'test_cut'
    ], tests.rows, 100, `ON CONFLICT (id) DO UPDATE SET 
      centre_id = EXCLUDED.centre_id, test_name = EXCLUDED.test_name, category = EXCLUDED.category, 
      price = EXCLUDED.price, cut_type = EXCLUDED.cut_type, test_cut = EXCLUDED.test_cut`);

    const patients = await localClient.query('SELECT * FROM patients');
    await bulkInsert(cloudClient, 'patients', [
      'id', 'centre_id', 'patient_code', 'full_name', 'age', 'gender', 'phone', 'email', 'address', 'created_at'
    ], patients.rows, 100, `ON CONFLICT (id) DO UPDATE SET 
      full_name = EXCLUDED.full_name, age = EXCLUDED.age, gender = EXCLUDED.gender,
      phone = EXCLUDED.phone, email = EXCLUDED.email, address = EXCLUDED.address`);

    const radiologists = await localClient.query('SELECT * FROM radiologists');
    await bulkInsert(cloudClient, 'radiologists', [
      'id', 'centre_id', 'doctor_name', 'designation', 'reg_no', 'signature_file', 'is_global', 'created_at'
    ], radiologists.rows, 50, `ON CONFLICT (id) DO UPDATE SET 
      doctor_name = EXCLUDED.doctor_name, designation = EXCLUDED.designation, 
      reg_no = EXCLUDED.reg_no, signature_file = EXCLUDED.signature_file, is_global = EXCLUDED.is_global`);

    const visits = await localClient.query('SELECT * FROM visits');
    const localVisitIds = visits.rows.map(v => v.id).filter(Boolean);
    const localInvNos = visits.rows.map(v => v.invoice_number).filter(Boolean);

    if (localVisitIds.length > 0 || localInvNos.length > 0) {
      const safeVisitIds = localVisitIds.length > 0 ? localVisitIds : ['00000000-0000-0000-0000-000000000000'];
      const safeInvNos = localInvNos.length > 0 ? localInvNos : ['__dummy_inv__'];

      await cloudClient.query(`
        DELETE FROM patient_investigations WHERE visit_id IN (
          SELECT id FROM visits WHERE id = ANY($1::uuid[]) OR invoice_number = ANY($2::text[])
        )
      `, [safeVisitIds, safeInvNos]);

      await cloudClient.query(`
        DELETE FROM pcpndt_forms WHERE visit_id IN (
          SELECT id FROM visits WHERE id = ANY($1::uuid[]) OR invoice_number = ANY($2::text[])
        )
      `, [safeVisitIds, safeInvNos]);

      await cloudClient.query(`
        DELETE FROM imaging_reports WHERE visit_id IN (
          SELECT id FROM visits WHERE id = ANY($1::uuid[]) OR invoice_number = ANY($2::text[])
        )
      `, [safeVisitIds, safeInvNos]);

      await cloudClient.query(`
        DELETE FROM visits WHERE id = ANY($1::uuid[]) OR invoice_number = ANY($2::text[])
      `, [safeVisitIds, safeInvNos]);
    }

    const mappedVisits = visits.rows.map(v => ({
      ...v,
      cash_amount: v.cash_amount || 0,
      online_amount: v.online_amount || 0,
      bill_printed: v.bill_printed || false,
      doctor_commission: v.doctor_commission || 0,
      report_file: v.report_file || null,
      report_has_letterhead: v.report_has_letterhead !== false,
      report_margin_mm: v.report_margin_mm || 55
    }));

    await bulkInsert(cloudClient, 'visits', [
      'id', 'centre_id', 'patient_id', 'referring_doctor_id', 'total_amount', 'concession',
      'paid_amount', 'balance_amount', 'payment_status', 'payment_mode', 'cash_amount',
      'online_amount', 'bill_printed', 'invoice_number', 'doctor_commission', 'report_file', 
      'report_has_letterhead', 'report_margin_mm', 'created_at'
    ], mappedVisits, 100);

    const investigations = await localClient.query('SELECT * FROM patient_investigations');
    await bulkInsert(cloudClient, 'patient_investigations', [
      'id', 'visit_id', 'test_id', 'barcode', 'status', 'price', 'cut_type', 'test_cut'
    ], investigations.rows, 100, `ON CONFLICT (id) DO UPDATE SET
      visit_id = EXCLUDED.visit_id, test_id = EXCLUDED.test_id, barcode = EXCLUDED.barcode,
      status = EXCLUDED.status, price = EXCLUDED.price, cut_type = EXCLUDED.cut_type, test_cut = EXCLUDED.test_cut`);

    const pcpndt = await localClient.query('SELECT * FROM pcpndt_forms');
    const mappedPcpndt = pcpndt.rows.map(pf => ({
      ...pf,
      place: pf.place || 'Kandivali West',
      doctor_name: pf.doctor_name || 'Dr NIKUNJ KOTHIA',
      doctor_reg_no: pf.doctor_reg_no || '2009/09/3218',
      clinic_reg_no: pf.clinic_reg_no || 'RC197'
    }));
    await bulkInsert(cloudClient, 'pcpndt_forms', [
      'id', 'visit_id', 'centre_id', 'relative_name', 'no_of_sons', 'sons_age', 'no_of_daughters',
      'daughters_age', 'lmp_date', 'weeks_of_preg', 'indications', 'scan_result', 'doctor_name',
      'doctor_reg_no', 'clinic_reg_no', 'place', 'created_at'
    ], mappedPcpndt, 100, `ON CONFLICT (id) DO UPDATE SET
      relative_name = EXCLUDED.relative_name, lmp_date = EXCLUDED.lmp_date, 
      weeks_of_preg = EXCLUDED.weeks_of_preg, scan_result = EXCLUDED.scan_result, place = EXCLUDED.place`);

    const templates = await localClient.query('SELECT * FROM imaging_templates');
    await bulkInsert(cloudClient, 'imaging_templates', [
      'id', 'centre_id', 'template_name', 'title', 'category', 'default_impression', 'template_body', 'file_data'
    ], templates.rows, 10, `ON CONFLICT (id) DO UPDATE 
      SET title = EXCLUDED.title, category = EXCLUDED.category, default_impression = EXCLUDED.default_impression, template_body = EXCLUDED.template_body, file_data = EXCLUDED.file_data`);

    // Re-extract from local .docx files during Cloud Sync so Cloud DB gets the latest tables & bold tags
    const reports = await localClient.query('SELECT * FROM imaging_reports');
    const existingRepMap = new Map(reports.rows.map(r => [String(r.visit_id), r]));

    for (const v of visits.rows) {
      if (v.report_file) {
        const fullPath = path.resolve(__dirname, v.report_file);
        if (fs.existsSync(fullPath)) {
          const ext = path.extname(fullPath).toLowerCase();
          if (ext === '.docx' || ext === '.doc') {
            const parsed = extractTextFromUploadedFile(fullPath);
            const fallbackSig = await resolveDoctorSignature('Dr NIKUNJ KOTHIA', v.centre_id);
            const existingRow = existingRepMap.get(String(v.id));

            if (!existingRow) {
              const newRep = await localClient.query(
                `INSERT INTO imaging_reports (visit_id, patient_id, centre_id, template_name, report_text, impression, doctor_name, doctor_reg_no, doctor_designation, signature_file)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
                [v.id, v.patient_id, v.centre_id, parsed.title || 'DIAGNOSTIC IMAGING REPORT', parsed.body || 'Study completed.', parsed.impression || '', 'Dr NIKUNJ KOTHIA', '2009/09/3218', 'Consultant Radiologist', parsed.signatureFile || fallbackSig?.signature_file || null]
              );
              if (newRep.rows[0]) reports.rows.push(newRep.rows[0]);
            } else {
              existingRow.template_name = parsed.title || existingRow.template_name;
              existingRow.report_text = parsed.body || existingRow.report_text;
              existingRow.impression = parsed.impression || existingRow.impression;
              if (parsed.signatureFile) existingRow.signature_file = parsed.signatureFile;
              await localClient.query(
                `UPDATE imaging_reports SET template_name = $1, report_text = $2, impression = $3, signature_file = COALESCE($4, signature_file) WHERE id = $5`,
                [existingRow.template_name, existingRow.report_text, existingRow.impression, existingRow.signature_file, existingRow.id]
              );
            }
          }
        }
      }
    }

    const fallbackGlobalSig = await resolveDoctorSignature('Dr NIKUNJ KOTHIA', null);
    const mappedReports = reports.rows.map(r => ({
      ...r,
      visit_id: isValidUuid(r.visit_id) ? r.visit_id : null,
      patient_id: isValidUuid(r.patient_id) ? r.patient_id : null,
      centre_id: isValidUuid(r.centre_id) ? r.centre_id : null,
      template_id: isValidUuid(r.template_id) ? r.template_id : null,
      doctor_name: r.doctor_name || 'Dr NIKUNJ KOTHIA',
      doctor_reg_no: r.doctor_reg_no || '2009/09/3218',
      doctor_designation: r.doctor_designation || 'Consultant Radiologist',
      signature_file: r.signature_file || fallbackGlobalSig?.signature_file || null
    }));

    await bulkInsert(cloudClient, 'imaging_reports', [
      'id', 'visit_id', 'patient_id', 'centre_id', 'template_id', 'template_name',
      'report_text', 'impression', 'doctor_name', 'doctor_reg_no', 'doctor_designation', 'signature_file', 'created_at'
    ], mappedReports, 50, `ON CONFLICT (id) DO UPDATE SET
      template_name = EXCLUDED.template_name,
      report_text = EXCLUDED.report_text,
      impression = EXCLUDED.impression,
      doctor_name = EXCLUDED.doctor_name,
      doctor_reg_no = EXCLUDED.doctor_reg_no,
      doctor_designation = EXCLUDED.doctor_designation,
      signature_file = COALESCE(EXCLUDED.signature_file, imaging_reports.signature_file),
      created_at = EXCLUDED.created_at`);

    await cloudClient.query('COMMIT');
    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`[Cloud Sync] Completed in ${elapsedSec}s!`);
    res.status(200).json({ success: true, message: `Cloud Sync Successful! All records up to date in ${elapsedSec}s.` });
  } catch (err) {
    try { await cloudClient.query('ROLLBACK'); } catch (rb) {}
    console.error('Cloud Sync Error:', err.message);
    res.status(500).json({ success: false, error: 'Cloud Sync Failed: ' + err.message });
  } finally {
    if (localClient) localClient.release();
    if (cloudClient) cloudClient.release();
  }
});

// JSON API 404 GUARD
app.all('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: `API route ${req.method} ${req.originalUrl} not found.` });
});

// STATIC CATCH-ALL ROUTE (Checks root index.html FIRST)
app.get('*', (req, res) => {
  const rootIndex = path.join(__dirname, 'index.html');
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  res.setHeader('Content-Type', 'text/html');
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  res.status(404).send('index.html not found.');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  initDB();
});