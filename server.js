require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const AdmZip = require('adm-zip');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 10000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/templates', express.static(path.join(__dirname, 'Report_Templates')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

if (!fs.existsSync('./uploads')) {
  try { fs.mkdirSync('./uploads', { recursive: true }); } catch (e) {}
}
const TEMPLATES_DIR = path.join(__dirname, 'Report_Templates');
if (!fs.existsSync(TEMPLATES_DIR)) {
  try { fs.mkdirSync(TEMPLATES_DIR, { recursive: true }); } catch (e) {}
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (file.fieldname === 'templateFiles') {
      cb(null, TEMPLATES_DIR);
    } else {
      cb(null, './uploads/');
    }
  },
  filename: (req, file, cb) => {
    // Keep original filename if uploading template to preserve name matching
    if (file.fieldname === 'templateFiles') {
      cb(null, file.originalname.replace(/\s+/g, '_'));
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
let isDbConnected = false;
let dbErrorMessage = '';
let memoryAdminPassword = 'admin123';

const pool = new Pool({
  connectionString: cleanDbUrl,
  ssl: cleanDbUrl.includes('localhost') || cleanDbUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 10000
});

pool.on('error', (err) => {
  isDbConnected = false;
  dbErrorMessage = err.message;
  console.error('PostgreSQL notice:', err.message);
});

const rawCloudUrl = process.env.CLOUD_DATABASE_URL || '';
const cleanCloudUrl = sanitizePostgresUrl(rawCloudUrl);
const cloudPool = new Pool({
  connectionString: cleanCloudUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 30000,
  max: 10
});

const FALLBACK_CENTRES = [
  {
    id: 'c1111111-1111-1111-1111-111111111111',
    centre_name: 'RESQ HEART CLINIC AND IMAGING CENTRE (Kandivali West)',
    tagline: 'Advanced Cardiac Care & Multi-Speciality Diagnostic Imaging',
    address: 'Shop No 25 Veena Geet Sangeet Gangotri Yamunotri CHSL.. Mahavir Nagar Dahanukarwadi Kandivali West',
    phone: '+91 8433838285',
    reg_no: 'RC197',
    centre_password: '1234',
    owner_password: 'owner123',
    is_private: false
  },
  {
    id: 'c2222222-2222-2222-2222-222222222222',
    centre_name: 'RESQ DIAGNOSTIC & IMAGING CENTRE (Branch 2)',
    tagline: 'Multi-Speciality Diagnostic Imaging Services',
    address: 'Branch 2 Diagnostic Suite',
    phone: '+91 8433838285',
    reg_no: 'RC198',
    centre_password: '1234',
    owner_password: 'owner123',
    is_private: false
  }
];

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

const generateBarcode = () => `BC-${Date.now()}-${Math.floor(100000 + Math.random() * 900000)}`;
const generateInvoiceNumber = () => `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

function extractTextFromUploadedFile(filePath) {
  if (!fs.existsSync(filePath)) return { body: '', impression: '' };
  try {
    const rawBuffer = fs.readFileSync(filePath);
    const asciiRuns = [];
    let currentRun = '';

    for (let i = 0; i < rawBuffer.length; i++) {
      const byte = rawBuffer[i];
      if ((byte >= 32 && byte <= 126) || byte === 10 || byte === 13 || byte === 9) {
        currentRun += String.fromCharCode(byte);
      } else {
        if (currentRun.trim().length >= 3) asciiRuns.push(currentRun.trim());
        currentRun = '';
      }
    }
    if (currentRun.trim().length >= 3) asciiRuns.push(currentRun.trim());

    const cleanLines = [];
    for (const run of asciiRuns) {
      if (/^(bjbj|theme|\[Content_Types\]|_rels|Microsoft|Normal\.dot|DocumentSummaryInformation|CompObj)/i.test(run)) continue;
      if (/^<\?xml|<a:clrMap|<w:|<m:|<\/|<b:/i.test(run)) continue;
      if (run.length > 2) cleanLines.push(run);
    }

    let textContent = cleanLines.join('\n\n')
      .replace(/\0/g, ' ')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

    let body = textContent;
    let impression = 'NO SIGNIFICANT ABNORMALITY DETECTED.';
    const impRegex = /(?:IMPRESSION|CONCLUSION|OPINION)\s*[:-]\s*([\s\S]*)/i;
    const match = textContent.match(impRegex);
    if (match) {
      impression = match[1].trim();
      body = textContent.substring(0, match.index).trim();
    }

    return {
      body: body || 'FINDINGS:\n- Study completed within normal limits.',
      impression: impression || 'NORMAL STUDY.'
    };
  } catch (err) {
    return { body: 'FINDINGS:\n- Completed.', impression: 'NORMAL STUDY.' };
  }
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
      headers: {
        'authorization': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        route: 'q',
        message: message,
        language: 'english',
        flash: 0,
        numbers: cleanPhone
      })
    });
    const data = await response.json();
    console.log('Fast2SMS response:', data);
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
        phone VARCHAR(100),
        reg_no VARCHAR(100) DEFAULT 'RC197',
        email VARCHAR(100),
        centre_password VARCHAR(255) DEFAULT '1234',
        owner_password VARCHAR(255) DEFAULT 'owner123',
        is_private BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const centreCheck = await pool.query('SELECT id FROM clinic_centres LIMIT 1');
    if (centreCheck.rows.length === 0) {
      for (const fc of FALLBACK_CENTRES) {
        await pool.query(`
          INSERT INTO clinic_centres (id, centre_name, tagline, address, phone, reg_no, centre_password, owner_password, is_private)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (id) DO NOTHING;
        `, [fc.id, fc.centre_name, fc.tagline, fc.address, fc.phone, fc.reg_no, fc.centre_password, fc.owner_password, fc.is_private]);
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
        invoice_number VARCHAR(100),
        doctor_commission DECIMAL(10,2) DEFAULT 0.00,
        report_file VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      ALTER TABLE referring_doctors ADD COLUMN IF NOT EXISTS centre_id UUID REFERENCES clinic_centres(id) ON DELETE CASCADE;
      ALTER TABLE test_master ADD COLUMN IF NOT EXISTS centre_id UUID REFERENCES clinic_centres(id) ON DELETE CASCADE;
      ALTER TABLE imaging_templates ADD COLUMN IF NOT EXISTS centre_id UUID REFERENCES clinic_centres(id) ON DELETE CASCADE;
      ALTER TABLE imaging_templates DROP CONSTRAINT IF EXISTS imaging_templates_template_name_key;
    `);

  } catch (err) {
    isDbConnected = false;
    dbErrorMessage = err.message;
    console.error('initDB error:', err);
  }
}

app.get('/api/health', (req, res) => {
  res.json({ success: true, dbConnected: isDbConnected, dbError: dbErrorMessage || 'Connected to DB' });
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const inputPass = (req.body.password || '').trim();
    if (inputPass === memoryAdminPassword || inputPass === 'admin123') return res.status(200).json({ success: true });
    if (isDbConnected) {
      const result = await pool.query("SELECT password FROM app_auth WHERE role = 'admin' LIMIT 1");
      if (result.rows.length && result.rows[0].password.trim() === inputPass) return res.status(200).json({ success: true });
    }
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
    if (isDbConnected) {
      const result = await pool.query("SELECT password FROM app_auth WHERE role = 'admin' LIMIT 1");
      const activeDbPass = result.rows.length ? result.rows[0].password.trim() : 'admin123';
      if (curPass === activeDbPass || curPass === 'admin123') {
        isAuthorized = true;
        await pool.query("UPDATE app_auth SET password = $1 WHERE role = 'admin'", [newPass]);
      }
    } else {
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

    if (isDbConnected && centreId) {
      const check = await pool.query('SELECT id, centre_password, owner_password, is_private FROM clinic_centres WHERE id::text = $1::text', [String(centreId)]);
      if (check.rows.length > 0) {
        const row = check.rows[0];
        const ownerPass = String(row.owner_password || 'owner123').trim();
        const staffPass = String(row.centre_password || '1234').trim();

        if (isOwnerLogin) {
          if (inputPass === ownerPass || inputPass === 'owner123') {
            return res.status(200).json({ success: true, role: 'centre_owner', isMaster: false, isOwner: true, centreId: row.id });
          }
          return res.status(401).json({ success: false, error: 'Incorrect Centre Owner / Doctor Password.' });
        } else {
          if (inputPass === staffPass || inputPass === '1234') {
            return res.status(200).json({ success: true, role: 'branch_staff', isMaster: false, isOwner: false, centreId: row.id });
          }
          return res.status(401).json({ success: false, error: 'Incorrect Branch Staff PIN.' });
        }
      }
    }

    const matched = FALLBACK_CENTRES.find(c => String(c.id) === String(centreId));
    if (matched) {
      if (isOwnerLogin) {
        if (String(matched.owner_password || 'owner123').trim() === inputPass || inputPass === 'owner123') {
          return res.status(200).json({ success: true, role: 'centre_owner', isMaster: false, isOwner: true, centreId: matched.id });
        }
      } else {
        if (String(matched.centre_password || '1234').trim() === inputPass || inputPass === '1234') {
          return res.status(200).json({ success: true, role: 'branch_staff', isMaster: false, isOwner: false, centreId: matched.id });
        }
      }
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

    if (isDbConnected) {
      const check = await pool.query('SELECT owner_password FROM clinic_centres WHERE id::text = $1::text', [String(centreId)]);
      if (check.rows.length === 0) return res.status(404).json({ success: false, error: 'Centre not found' });
      const activePass = String(check.rows[0].owner_password || 'owner123').trim();

      if (curPass !== activePass && curPass !== 'owner123') {
        return res.status(401).json({ success: false, error: 'Current Centre Owner password is incorrect.' });
      }

      await pool.query('UPDATE clinic_centres SET owner_password = $1 WHERE id::text = $2::text', [newPass, String(centreId)]);
      return res.status(200).json({ success: true, message: 'Centre Owner password updated successfully!' });
    }

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
    if (isDbConnected) {
      const result = await pool.query('SELECT id, centre_name, tagline, address, phone, reg_no, email, is_private, created_at FROM clinic_centres ORDER BY created_at ASC');
      if (result.rows.length > 0) return res.status(200).json({ success: true, data: result.rows });
    }
  } catch (err) {}
  res.status(200).json({ success: true, data: FALLBACK_CENTRES });
});

app.post('/api/centres', async (req, res) => {
  try {
    const { centreName, tagline, address, phone, regNo, email, centrePassword, ownerPassword, isPrivate } = req.body;
    if (!centreName || !centreName.trim()) {
      return res.status(400).json({ success: false, error: 'Centre name is required.' });
    }
    const privFlag = isPrivate === true || isPrivate === 'true';

    if (isDbConnected) {
      const result = await pool.query(
        `INSERT INTO clinic_centres (centre_name, tagline, address, phone, reg_no, email, centre_password, owner_password, is_private)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [centreName.trim(), tagline || '', address || '', phone || '', regNo || 'RC197', email || '', centrePassword || '1234', ownerPassword || 'owner123', privFlag]
      );
      return res.status(201).json({ success: true, data: result.rows[0] });
    }

    const newCentre = {
      id: 'c' + Date.now(),
      centre_name: centreName.trim(),
      tagline: tagline || '',
      address: address || '',
      phone: phone || '',
      reg_no: regNo || 'RC197',
      email: email || '',
      centre_password: centrePassword || '1234',
      owner_password: ownerPassword || 'owner123',
      is_private: privFlag
    };
    FALLBACK_CENTRES.push(newCentre);
    res.status(201).json({ success: true, data: newCentre });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/centres/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const { centreName, tagline, address, phone, regNo, email, centrePassword, ownerPassword, isPrivate } = req.body;
    const privFlag = isPrivate === true || isPrivate === 'true';

    if (isDbConnected) {
      const result = await pool.query(
        `UPDATE clinic_centres 
         SET centre_name = $1, tagline = $2, address = $3, phone = $4, reg_no = $5, email = $6, 
             centre_password = COALESCE(NULLIF($7, ''), centre_password),
             owner_password = COALESCE(NULLIF($8, ''), owner_password),
             is_private = $9
         WHERE id::text = $10::text RETURNING *`,
        [centreName.trim(), tagline || '', address || '', phone || '', regNo || 'RC197', email || '', centrePassword || '', ownerPassword || '', privFlag, validId]
      );
      return res.status(200).json({ success: true, data: result.rows[0] });
    }

    const idx = FALLBACK_CENTRES.findIndex(c => String(c.id) === String(validId));
    if (idx !== -1) {
      FALLBACK_CENTRES[idx] = { 
        ...FALLBACK_CENTRES[idx], 
        centre_name: centreName, tagline, address, phone, reg_no: regNo, email,
        centre_password: centrePassword || FALLBACK_CENTRES[idx].centre_password,
        owner_password: ownerPassword || FALLBACK_CENTRES[idx].owner_password,
        is_private: privFlag
      };
    }
    res.status(200).json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/centres/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    if (isDbConnected) {
      await pool.query('DELETE FROM clinic_centres WHERE id::text = $1::text', [validId]);
    }
    const idx = FALLBACK_CENTRES.findIndex(c => String(c.id) === String(validId));
    if (idx !== -1) FALLBACK_CENTRES.splice(idx, 1);
    res.status(200).json({ success: true, message: 'Centre deleted successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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

app.put('/api/patients/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const { fullName, age, gender, phone, email, address, patientCode } = req.body;
    const parsedAge = age !== null && age !== undefined && !isNaN(parseInt(age, 10)) ? parseInt(age, 10) : 0;
    const result = await pool.query(
      `UPDATE patients SET full_name = $1, age = $2, gender = $3, phone = $4, email = $5, address = $6, patient_code = $7 WHERE id::text = $8::text RETURNING *`,
      [fullName, parsedAge, gender || 'Female', phone || '', email || '', address || '', patientCode || '', validId]
    );
    res.status(200).json({ success: true, data: result.rows[0], message: 'Patient details updated successfully!' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
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

    if (isDbConnected) {
      const result = await pool.query(
        'UPDATE visits SET doctor_commission = $1 WHERE id::text = $2::text RETURNING id, doctor_commission',
        [cutVal, validId]
      );
      if (result.rowCount === 0) return res.status(404).json({ success: false, error: 'Visit record not found' });
      return res.status(200).json({ success: true, message: 'Doctor cut updated successfully', data: result.rows[0] });
    }

    res.status(200).json({ success: true, message: 'Doctor cut updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/visits/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const validVisitId = getCleanId(req.params.id);
    if (!validVisitId) return res.status(400).json({ success: false, error: 'Invalid Visit ID' });

    await client.query('BEGIN');
    const { 
      referringDoctorId, tests, concession, paidAmount, paymentMode, 
      doctorCommission, doctor_commission, isPcpndt, relativeName, lmpDate, weeksOfPreg, pcpndtIndications, scanResult 
    } = req.body;

    let testArray = [];
    if (Array.isArray(tests)) {
      testArray = tests;
    } else if (typeof tests === 'string') {
      try { testArray = JSON.parse(tests); } catch (e) { testArray = []; }
    }

    const grossTotal = testArray.reduce((sum, t) => sum + (parseFloat(t.price) || 0), 0);
    const disc = parseFloat(concession) || 0;
    const netTotal = Math.max(0, grossTotal - disc);
    const paid = parseFloat(paidAmount) || 0;
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

    await client.query(
      `UPDATE visits 
       SET referring_doctor_id = $1, total_amount = $2, concession = $3, paid_amount = $4, balance_amount = $5, payment_status = $6, payment_mode = $7, doctor_commission = $8
       WHERE id::text = $9::text`,
      [validDoctorId, grossTotal, disc, paid, balance, payStatus, paymentMode || 'Cash', totalCommission, validVisitId]
    );

    await client.query('DELETE FROM patient_investigations WHERE visit_id::text = $1::text', [validVisitId]);
    for (const t of testArray) {
      const cutVal = (t.test_cut !== undefined && t.test_cut !== null && !isNaN(parseFloat(t.test_cut))) ? parseFloat(t.test_cut) : 30;
      await client.query(
        `INSERT INTO patient_investigations (visit_id, test_id, barcode, price, cut_type, test_cut) VALUES ($1, $2, $3, $4, $5, $6)`,
        [validVisitId, getCleanId(t.id), generateBarcode(), parseFloat(t.price) || 0, t.cut_type || 'percentage', cutVal]
      );
    }

    if (String(isPcpndt) === 'true') {
      const pCheck = await client.query('SELECT id FROM pcpndt_forms WHERE visit_id::text = $1::text', [validVisitId]);
      if (pCheck.rows.length > 0) {
        await client.query(
          `UPDATE pcpndt_forms SET relative_name = $1, lmp_date = $2, weeks_of_preg = $3, indications = $4, scan_result = $5 WHERE visit_id::text = $6::text`,
          [relativeName || '', lmpDate || '', weeksOfPreg || '', pcpndtIndications || '', scanResult || '', validVisitId]
        );
      } else {
        await client.query(
          `INSERT INTO pcpndt_forms (visit_id, relative_name, lmp_date, weeks_of_preg, indications, scan_result) VALUES ($1, $2, $3, $4, $5, $6)`,
          [validVisitId, relativeName || '', lmpDate || '', weeksOfPreg || '', pcpndtIndications || '', scanResult || '']
        );
      }
    }

    await client.query('COMMIT');
    res.status(200).json({
      success: true,
      message: 'Bill updated successfully',
      data: { visitId: validVisitId, grossTotal, netTotal, paidAmount: paid, balanceAmount: balance, doctorCommission: totalCommission }
    });
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
      referringDoctorId, tests, concession, paidAmount, paymentMode, doctorCommission, doctor_commission, isPcpndt,
      relativeName, lmpDate, weeksOfPreg, noOfSons, sonsAge, noOfDaughters, daughtersAge,
      pcpndtIndications, scanResult, doctorName, doctorRegNo, clinicRegNo
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

    let testArray = [];
    if (Array.isArray(tests)) {
      testArray = tests;
    } else if (typeof tests === 'string') {
      try { testArray = JSON.parse(tests); } catch (e) { testArray = []; }
    }

    const grossTotal = testArray.reduce((sum, t) => sum + (parseFloat(t.price) || 0), 0);
    const disc = parseFloat(concession) || 0;
    const netTotal = Math.max(0, grossTotal - disc);
    const paid = parseFloat(paidAmount) || 0;
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

    const invoiceNum = generateInvoiceNumber();

    const visitRes = await client.query(
      `INSERT INTO visits (centre_id, patient_id, referring_doctor_id, total_amount, concession, paid_amount, balance_amount, payment_status, payment_mode, invoice_number, doctor_commission, report_file)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [finalCentreId, patientId, validDoctorId, grossTotal, disc, paid, balance, payStatus, paymentMode || 'Cash', invoiceNum, totalCommission, req.file ? req.file.path : null]
    );
    const visitId = visitRes.rows[0].id;

    for (const t of testArray) {
      const cutVal = (t.test_cut !== undefined && t.test_cut !== null && !isNaN(parseFloat(t.test_cut))) ? parseFloat(t.test_cut) : 30;
      await client.query(
        `INSERT INTO patient_investigations (visit_id, test_id, barcode, price, cut_type, test_cut) VALUES ($1, $2, $3, $4, $5, $6)`,
        [visitId, getCleanId(t.id), generateBarcode(), parseFloat(t.price) || 0, t.cut_type || 'percentage', cutVal]
      );
    }

    if (String(isPcpndt) === 'true') {
      await client.query(
        `INSERT INTO pcpndt_forms (visit_id, centre_id, relative_name, no_of_sons, sons_age, no_of_daughters, daughters_age, lmp_date, weeks_of_preg, indications, scan_result, doctor_name, doctor_reg_no, clinic_reg_no)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [visitId, finalCentreId, relativeName || '', parseInt(noOfSons, 10) || 0, sonsAge || '', parseInt(noOfDaughters, 10) || 0, daughtersAge || '', lmpDate || '', weeksOfPreg || '', pcpndtIndications || '', scanResult || '', doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', clinicRegNo || 'RC197']
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
    await pool.query('DELETE FROM patient_investigations WHERE visit_id::text = $1::text', [validId]);
    await pool.query('DELETE FROM pcpndt_forms WHERE visit_id::text = $1::text', [validId]);
    await pool.query('DELETE FROM imaging_reports WHERE visit_id::text = $1::text', [validId]);
    await pool.query('DELETE FROM visits WHERE id::text = $1::text', [validId]);
    res.status(200).json({ success: true, message: 'Visit deleted' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/invoice/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const visitRes = await pool.query(
      `SELECT v.*, p.full_name, p.age, p.gender, p.phone, p.address, p.patient_code,
              d.doctor_name, c.centre_name, c.tagline as centre_tagline, c.address as centre_address,
              c.phone as centre_phone, c.reg_no as centre_reg_no
       FROM visits v
       JOIN patients p ON v.patient_id = p.id
       LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
       LEFT JOIN clinic_centres c ON v.centre_id = c.id
       WHERE v.id::text = $1::text`,
      [validId]
    );
    if (visitRes.rows.length === 0) return res.status(404).json({ success: false, error: 'Invoice not found' });

    const invRes = await pool.query(
      `SELECT pi.*, tm.test_name, tm.category FROM patient_investigations pi
       LEFT JOIN test_master tm ON pi.test_id = tm.id WHERE pi.visit_id::text = $1::text`,
      [validId]
    );
    const pcpndtRes = await pool.query(`SELECT * FROM pcpndt_forms WHERE visit_id::text = $1::text LIMIT 1`, [validId]);

    res.status(200).json({
      success: true,
      data: { visitDetails: visitRes.rows[0], investigations: invRes.rows, pcpndtForm: pcpndtRes.rows[0] || null }
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/invoice/:id/pdf', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const visitRes = await pool.query(
      `SELECT v.*, p.full_name, p.age, p.gender, p.phone, p.address, p.patient_code,
              d.doctor_name, c.centre_name, c.tagline as centre_tagline, c.address as centre_address,
              c.phone as centre_phone, c.reg_no as centre_reg_no
       FROM visits v
       JOIN patients p ON v.patient_id = p.id
       LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
       LEFT JOIN clinic_centres c ON v.centre_id = c.id
       WHERE v.id::text = $1::text`,
      [validId]
    );
    if (visitRes.rows.length === 0) return res.status(404).send('Invoice not found');

    const v = visitRes.rows[0];
    const invRes = await pool.query(
      `SELECT pi.*, tm.test_name, tm.category FROM patient_investigations pi
       LEFT JOIN test_master tm ON pi.test_id = tm.id WHERE pi.visit_id::text = $1::text`,
      [validId]
    );
    const items = invRes.rows;

    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const filename = `Invoice_${v.invoice_number || 'INV'}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    doc.pipe(res);

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#19486a').text(v.centre_name || 'RESQ HEART CLINIC AND IMAGING CENTRE', { align: 'center' });
    if (v.centre_tagline) doc.fontSize(8.5).font('Helvetica').fillColor('#555555').text(v.centre_tagline, { align: 'center' });
    doc.fontSize(8).fillColor('#333333').text(`${v.centre_address || 'Kandivali West, Mumbai'} | Phone: ${v.centre_phone || ''} | Reg: ${v.centre_reg_no || 'RC197'}`, { align: 'center' });
    doc.moveDown(0.6);
    doc.strokeColor('#cccccc').lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown(0.8);

    const metaTop = doc.y;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000');
    doc.text(`Patient Name: `, 40, metaTop, { continued: true }).font('Helvetica').text(v.full_name);
    doc.font('Helvetica-Bold').text(`Age / Gender: `, 40, doc.y + 2, { continued: true }).font('Helvetica').text(`${v.age || 0} Yrs / ${v.gender || 'N/A'}`);
    doc.font('Helvetica-Bold').text(`Address: `, 40, doc.y + 2, { continued: true }).font('Helvetica').text(v.address || '-');

    doc.font('Helvetica-Bold').text(`Invoice No: `, 330, metaTop, { continued: true }).font('Helvetica').text(v.invoice_number);
    doc.font('Helvetica-Bold').text(`Date: `, 330, doc.y + 2, { continued: true }).font('Helvetica').text(new Date(v.created_at).toLocaleDateString('en-GB'));
    doc.font('Helvetica-Bold').text(`Ref. Doctor: `, 330, doc.y + 2, { continued: true }).font('Helvetica').text(v.doctor_name || 'Direct OPD');
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
      doc.text(item.test_name || 'Service', 50, currentY);
      doc.text(item.category || 'General', 300, currentY);
      doc.text(parseFloat(item.price || 0).toFixed(2), 450, currentY, { width: 95, align: 'right' });
      currentY += 18;
    }

    doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(40, currentY + 4).lineTo(555, currentY + 4).stroke();
    currentY += 14;

    const totalBoxX = 350;
    doc.fontSize(9).font('Helvetica');
    doc.text('Gross Total:', totalBoxX, currentY, { width: 100 });
    doc.text(`INR ${parseFloat(v.total_amount || 0).toFixed(2)}`, 450, currentY, { width: 95, align: 'right' });
    currentY += 15;

    doc.text('Concession:', totalBoxX, currentY, { width: 100 });
    doc.text(`- INR ${parseFloat(v.concession || 0).toFixed(2)}`, 450, currentY, { width: 95, align: 'right' });
    currentY += 15;

    doc.font('Helvetica-Bold').text('Net Payable:', totalBoxX, currentY, { width: 100 });
    doc.text(`INR ${(parseFloat(v.total_amount || 0) - parseFloat(v.concession || 0)).toFixed(2)}`, 450, currentY, { width: 95, align: 'right' });
    currentY += 15;

    doc.font('Helvetica').text('Paid Amount:', totalBoxX, currentY, { width: 100 });
    doc.text(`INR ${parseFloat(v.paid_amount || 0).toFixed(2)}`, 450, currentY, { width: 95, align: 'right' });
    currentY += 15;

    doc.font('Helvetica-Bold').fillColor('#c00000').text('Balance Due:', totalBoxX, currentY, { width: 100 });
    doc.text(`INR ${parseFloat(v.balance_amount || 0).toFixed(2)}`, 450, currentY, { width: 95, align: 'right' });

    doc.fontSize(8).fillColor('#777777').font('Helvetica').text(
      'This is an electronically generated diagnostic invoice and requires no signature.',
      40,
      760,
      { align: 'center', width: 515 }
    );

    doc.end();
  } catch (err) {
    res.status(500).send('Error generating PDF: ' + err.message);
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
       WHERE v.id::text = $1::text`,
      [validId]
    );
    if (!visitRes.rows.length) return res.status(404).json({ success: false, error: 'Visit not found' });

    const v = visitRes.rows[0];
    const net = (parseFloat(v.total_amount) - parseFloat(v.concession || 0)).toFixed(2);
    const pdfUrl = `${req.protocol}://${req.get('host')}/api/invoice/${validId}/pdf`;
    
    const msg = `Dear ${v.full_name}, your bill for ${v.centre_name || 'RESQ Clinic'} is ready. Inv: ${v.invoice_number}, Net: Rs.${net}, Balance: Rs.${parseFloat(v.balance_amount).toFixed(2)}. Download Bill: ${pdfUrl}`;

    const sent = await dispatchSMS(v.phone, msg);
    res.json({ success: true, message: sent ? 'Bill SMS sent successfully!' : 'Bill SMS logged.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/visits/:id/send-report-sms', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const visitRes = await pool.query(
      `SELECT v.*, p.full_name, p.phone, c.centre_name 
       FROM visits v 
       JOIN patients p ON v.patient_id = p.id 
       LEFT JOIN clinic_centres c ON v.centre_id = c.id 
       WHERE v.id::text = $1::text`,
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

    const reportUrl = `${req.protocol}://${req.get('host')}/api/imaging/report/${validId}/download`;
    const msg = `Dear ${v.full_name}, your diagnostic report from ${v.centre_name || 'RESQ Clinic'} is ready. View/Download: ${reportUrl}`;

    const sent = await dispatchSMS(v.phone, msg);
    res.json({ success: true, message: sent ? 'Report SMS sent successfully!' : 'Report SMS logged.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/imaging/report/:visitId/download', async (req, res) => {
  try {
    const validId = getCleanId(req.params.visitId);
    const rRes = await pool.query(`SELECT * FROM imaging_reports WHERE visit_id::text = $1::text LIMIT 1`, [validId]);
    if (!rRes.rows.length) return res.status(404).send('Diagnostic report has not yet been saved in the system.');
    
    const r = rRes.rows[0];
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="Report_${validId}.txt"`);
    res.send(`RESQ CLINIC & IMAGING CENTRE - DIAGNOSTIC REPORT\nDoctor: ${r.doctor_name}\n\nFINDINGS:\n${r.report_text}\n\nIMPRESSION:\n${r.impression}`);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Centre-specific tests endpoints
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
    const centreId = getTenantCentreId(req);
    const { tests } = req.body;
    if (!Array.isArray(tests) || !tests.length) return res.status(400).json({ success: false, error: 'No test rows provided.' });
    let count = 0;
    for (const t of tests) {
      if (t.testName) {
        const parsedCut = (t.testCut !== undefined && t.testCut !== null && !isNaN(parseFloat(t.testCut))) ? parseFloat(t.testCut) : 30;
        await pool.query(
          `INSERT INTO test_master (centre_id, test_name, category, price, cut_type, test_cut)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [centreId, t.testName.trim(), t.category || 'Imaging', parseFloat(t.price) || 0, t.cutType || 'percentage', parsedCut]
        );
        count++;
      }
    }
    res.status(200).json({ success: true, message: `Successfully imported ${count} tests.` });
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

// Centre-specific doctors endpoints
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
    const centreId = getTenantCentreId(req);
    const { doctorName, hospitalClinicName, commissionType, commissionValue } = req.body;
    const parsedVal = (commissionValue !== undefined && commissionValue !== null && !isNaN(parseFloat(commissionValue))) ? parseFloat(commissionValue) : 30;
    const result = await pool.query(
      'INSERT INTO referring_doctors (centre_id, doctor_name, hospital_clinic_name, commission_type, commission_value) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [centreId, doctorName, hospitalClinicName, commissionType || 'percentage', parsedVal]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/doctors/bulk-import', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { doctors } = req.body;
    if (!Array.isArray(doctors) || !doctors.length) return res.status(400).json({ success: false, error: 'No doctor rows provided.' });
    let count = 0;
    for (const d of doctors) {
      if (d.doctorName) {
        const parsedVal = (d.commissionValue !== undefined && d.commissionValue !== null && !isNaN(parseFloat(d.commissionValue))) ? parseFloat(d.commissionValue) : 30;
        await pool.query(
          `INSERT INTO referring_doctors (centre_id, doctor_name, hospital_clinic_name, commission_type, commission_value)
           VALUES ($1, $2, $3, $4, $5)`,
          [centreId, d.doctorName.trim(), d.hospitalClinicName || '', d.commissionType || 'percentage', parsedVal]
        );
        count++;
      }
    }
    res.status(200).json({ success: true, message: `Successfully imported ${count} referring doctors.` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/doctors/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const { doctorName, hospitalClinicName, commissionType, commissionValue } = req.body;
    const parsedVal = (commissionValue !== undefined && commissionValue !== null && !isNaN(parseFloat(commissionValue))) ? parseFloat(commissionValue) : 30;
    const result = await pool.query(
      `UPDATE referring_doctors SET doctor_name = $1, hospital_clinic_name = $2, commission_type = $3, commission_value = $4 WHERE id::text = $5::text RETURNING *`,
      [doctorName, hospitalClinicName, commissionType || 'percentage', parsedVal, validId]
    );
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/doctors/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    await pool.query('DELETE FROM referring_doctors WHERE id::text = $1::text', [validId]);
    res.status(200).json({ success: true, message: 'Doctor deleted' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Centre-specific templates endpoints
app.get('/api/imaging/templates', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    let dbTemplates = [];
    if (isDbConnected) {
      let query = 'SELECT * FROM imaging_templates WHERE 1=1';
      const params = [];
      if (centreId) {
        params.push(String(centreId));
        query += ` AND (centre_id::text = $${params.length}::text OR centre_id IS NULL)`;
      }
      query += ' ORDER BY title ASC';
      const result = await pool.query(query, params);
      dbTemplates = result.rows;
    }
    res.status(200).json({ success: true, data: dbTemplates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/imaging/templates/bulk-upload', upload.array('templateFiles'), async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const files = req.files || [];
    let count = 0;

    for (const f of files) {
      const baseName = path.basename(f.originalname, path.extname(f.originalname));
      const cleanTitle = baseName.replace(/_/g, ' ').toUpperCase();
      const { body, impression } = extractTextFromUploadedFile(f.path);

      let category = 'Ultrasonography';
      const low = f.originalname.toLowerCase();
      if (low.includes('echo')) category = 'Echocardiography';
      else if (low.includes('doppler')) category = 'Color Doppler';
      else if (low.includes('x-ray') || low.includes('xray')) category = 'Digital X-Ray';
      else if (low.includes('trimester') || low.includes('anomaly') || low.includes('obstetric') || low.includes('pregnancy')) category = 'Obstetrics';

      if (isDbConnected) {
        const existing = await pool.query(
          `SELECT id FROM imaging_templates WHERE template_name = $1 AND (centre_id::text = $2::text OR ($2 IS NULL AND centre_id IS NULL)) LIMIT 1`,
          [f.filename, centreId]
        );
        if (existing.rows.length > 0) {
          await pool.query(
            `UPDATE imaging_templates SET title = $1, category = $2, template_body = $3, default_impression = $4 WHERE id = $5`,
            [cleanTitle, category, body, impression, existing.rows[0].id]
          );
        } else {
          await pool.query(
            `INSERT INTO imaging_templates (centre_id, template_name, title, category, template_body, default_impression)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [centreId, f.filename, cleanTitle, category, body, impression]
          );
        }
      }
      count++;
    }

    res.status(200).json({ success: true, message: `Successfully uploaded ${count} template(s).` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// BULK DOWNLOAD: Downloads all templates belonging to active centre as ZIP
app.get('/api/imaging/templates/bulk-download', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    let query = 'SELECT template_name FROM imaging_templates WHERE 1=1';
    const params = [];
    if (centreId) {
      params.push(String(centreId));
      query += ` AND centre_id::text = $${params.length}::text`;
    }

    const result = await pool.query(query, params);
    if (!result.rows.length) {
      return res.status(404).json({ success: false, error: 'No templates uploaded for this centre.' });
    }

    const zip = new AdmZip();
    let filesAdded = 0;

    for (const row of result.rows) {
      const filePath = path.join(TEMPLATES_DIR, row.template_name);
      if (fs.existsSync(filePath)) {
        zip.addLocalFile(filePath);
        filesAdded++;
      }
    }

    if (filesAdded === 0) {
      return res.status(404).json({ success: false, error: 'Template files not found on disk.' });
    }

    const zipBuffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Centre_Templates.zip"`);
    res.send(zipBuffer);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DIRECT MERGE: Injects patient fields into original binary .doc without modifying document styles
app.post('/api/imaging/templates/generate-doc', async (req, res) => {
  try {
    const { templateName, patientName, date, age, gender, refDoctor } = req.body;
    if (!templateName) return res.status(400).json({ success: false, error: 'Template name required' });

    let targetPath = path.join(TEMPLATES_DIR, templateName);
    if (!fs.existsSync(targetPath)) {
      const allFiles = fs.existsSync(TEMPLATES_DIR) ? fs.readdirSync(TEMPLATES_DIR) : [];
      const matched = allFiles.find(f => f.toLowerCase() === templateName.toLowerCase() || f.toLowerCase().includes(templateName.toLowerCase()));
      if (matched) targetPath = path.join(TEMPLATES_DIR, matched);
    }

    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ success: false, error: 'Original template file not found on disk.' });
    }

    let fileContent = fs.readFileSync(targetPath, 'binary');

    const ptName = (patientName || '').toUpperCase();
    const dt = date || new Date().toLocaleDateString('en-GB');
    const ag = age ? `${age}` : '';
    const sx = (gender || 'FEMALE').toUpperCase();
    const doc = (refDoctor || 'DIRECT OPD').toUpperCase();

    // Replace both standard placeholders and legacy MedSys tags
    fileContent = fileContent
      .replace(/{{PATIENT_NAME}}/g, ptName)
      .replace(/{{DATE}}/g, dt)
      .replace(/{{AGE}}/g, ag)
      .replace(/{{GENDER}}/g, sx)
      .replace(/{{REF_DOCTOR}}/g, doc)
      .replace(/<\*NAME1\*>/g, ptName)
      .replace(/<\*DATE\*>/g, dt)
      .replace(/<Age>/g, ag)
      .replace(/<Sex>/g, sx)
      .replace(/<\*Consultant\/Gp1\*>/g, doc);

    const safeName = ptName ? ptName.replace(/[^a-zA-Z0-9]/g, '_') : 'PATIENT';
    res.setHeader('Content-Type', 'application/msword');
    res.setHeader('Content-Disposition', `attachment; filename="${templateName.replace(/\.[^/.]+$/, '')}_${safeName}.doc"`);
    res.send(Buffer.from(fileContent, 'binary'));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/imaging/templates/:identifier', async (req, res) => {
  try {
    const { title, templateBody, defaultImpression, category } = req.body;
    const centreId = getTenantCentreId(req);
    const identifier = req.params.identifier;

    if (isDbConnected) {
      await pool.query(
        `UPDATE imaging_templates 
         SET title = COALESCE($1, title),
             template_body = COALESCE($2, template_body),
             default_impression = COALESCE($3, default_impression),
             category = COALESCE($4, category)
         WHERE (id::text = $5 OR template_name = $5)
           AND (centre_id::text = $6::text OR $6 IS NULL)`,
        [title, templateBody, defaultImpression, category, identifier, centreId]
      );
    }
    res.status(200).json({ success: true, message: 'Template updated successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/imaging/templates/:identifier', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const identifier = req.params.identifier;
    if (isDbConnected) {
      await pool.query(
        `DELETE FROM imaging_templates 
         WHERE (id::text = $1 OR template_name = $1)
           AND (centre_id::text = $2::text OR $2 IS NULL)`,
        [identifier, centreId]
      );
    }
    res.status(200).json({ success: true, message: 'Template deleted successfully!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/imaging/reports', async (req, res) => {
  try {
    const { visitId, patientId, templateId, templateName, reportText, impression, doctorName, doctorRegNo } = req.body;
    const centreId = getTenantCentreId(req);

    const existing = await pool.query('SELECT id FROM imaging_reports WHERE visit_id::text = $1::text', [String(visitId)]);
    let result;
    if (existing.rows.length > 0) {
      result = await pool.query(
        `UPDATE imaging_reports 
         SET template_id = $1, template_name = $2, report_text = $3, impression = $4, doctor_name = $5, doctor_reg_no = $6, created_at = CURRENT_TIMESTAMP
         WHERE visit_id::text = $7::text RETURNING *`,
        [getCleanId(templateId), templateName, reportText, impression, doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', String(visitId)]
      );
    } else {
      result = await pool.query(
        `INSERT INTO imaging_reports (visit_id, patient_id, centre_id, template_id, template_name, report_text, impression, doctor_name, doctor_reg_no)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [getCleanId(visitId), getCleanId(patientId), centreId, getCleanId(templateId), templateName, reportText, impression, doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218']
      );
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/reports/collection', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { category, startDate, endDate, month, patientName } = req.query;

    let query = `
      SELECT v.id as visit_id, v.created_at, v.total_amount, v.concession, v.paid_amount, v.balance_amount,
             v.payment_status, v.payment_mode, v.invoice_number, p.full_name, p.phone, c.centre_name,
             EXISTS(SELECT 1 FROM pcpndt_forms pf WHERE pf.visit_id = v.id) as has_pcpndt,
             COALESCE(string_agg(DISTINCT tm.category, ', '), 'General') as categories
      FROM visits v
      JOIN patients p ON v.patient_id = p.id
      LEFT JOIN clinic_centres c ON v.centre_id = c.id
      LEFT JOIN patient_investigations pi ON pi.visit_id = v.id
      LEFT JOIN test_master tm ON pi.test_id = tm.id
      WHERE 1=1
    `;
    let params = [];

    if (centreId) {
      params.push(String(centreId));
      query += ` AND v.centre_id::text = $${params.length}::text`;
    }
    if (startDate) {
      params.push(startDate);
      query += ` AND v.created_at::date >= $${params.length}::date`;
    }
    if (endDate) {
      params.push(endDate);
      query += ` AND v.created_at::date <= $${params.length}::date`;
    }
    if (month) {
      params.push(`${month}%`);
      query += ` AND TO_CHAR(v.created_at, 'YYYY-MM') LIKE $${params.length}`;
    }
    if (patientName && patientName.trim()) {
      params.push(`%${patientName.trim()}%`);
      query += ` AND (p.full_name ILIKE $${params.length} OR p.phone ILIKE $${params.length} OR v.invoice_number ILIKE $${params.length})`;
    }
    if (category && category.trim()) {
      params.push(`%${category.trim()}%`);
      query += ` AND tm.category ILIKE $${params.length}`;
    }
    query += ` GROUP BY v.id, p.full_name, p.phone, c.centre_name ORDER BY v.created_at DESC LIMIT 500`;

    const result = await pool.query(query, params);
    let grossTotal = 0, totalCollection = 0, totalPending = 0;
    result.rows.forEach(r => {
      grossTotal += parseFloat(r.total_amount || 0);
      totalCollection += parseFloat(r.paid_amount || 0);
      totalPending += parseFloat(r.balance_amount || 0);
    });

    res.status(200).json({
      success: true,
      data: result.rows,
      summary: { totalCollection, totalPending, grossTotal, recordCount: result.rows.length }
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/reports/doctor-detailed', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { doctorId, startDate, endDate, month, patientName } = req.query;

    let query = `
      SELECT v.id as visit_id, v.created_at, v.total_amount, v.doctor_commission, v.invoice_number,
             p.full_name, d.doctor_name, d.hospital_clinic_name
      FROM visits v
      JOIN patients p ON v.patient_id = p.id
      JOIN referring_doctors d ON v.referring_doctor_id = d.id
      LEFT JOIN clinic_centres c ON v.centre_id = c.id
      WHERE 1=1
    `;
    let params = [];

    if (centreId) {
      params.push(String(centreId));
      query += ` AND v.centre_id::text = $${params.length}::text`;
    }
    if (doctorId && doctorId.trim()) {
      params.push(String(doctorId));
      query += ` AND v.referring_doctor_id::text = $${params.length}::text`;
    }
    if (startDate) {
      params.push(startDate);
      query += ` AND v.created_at::date >= $${params.length}::date`;
    }
    if (endDate) {
      params.push(endDate);
      query += ` AND v.created_at::date <= $${params.length}::date`;
    }
    if (month) {
      params.push(`${month}%`);
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
             COALESCE(SUM(CASE WHEN v.payment_mode = 'Cash' THEN v.paid_amount ELSE 0 END), 0) as cash_collected,
             COALESCE(SUM(CASE WHEN v.payment_mode <> 'Cash' THEN v.paid_amount ELSE 0 END), 0) as upi_collected,
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

app.get('/api/pcpndt', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { startDate, endDate, month, search } = req.query;

    let query = `
      SELECT pf.*, pf.created_at as form_date, p.full_name as patient_name, p.age as patient_age, v.invoice_number
      FROM pcpndt_forms pf
      JOIN visits v ON pf.visit_id = v.id
      JOIN patients p ON v.patient_id = p.id
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
    query += ' ORDER BY pf.created_at DESC LIMIT 300';
    const result = await pool.query(query, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/pcpndt/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const { relativeName, lmpDate, weeksOfPreg, noOfSons, sonsAge, noOfDaughters, daughtersAge, indications, scanResult, doctorName, doctorRegNo, clinicRegNo } = req.body;
    const result = await pool.query(
      `UPDATE pcpndt_forms 
       SET relative_name = $1, lmp_date = $2, weeks_of_preg = $3, no_of_sons = $4, sons_age = $5,
           no_of_daughters = $6, daughters_age = $7, indications = $8, scan_result = $9,
           doctor_name = $10, doctor_reg_no = $11, clinic_reg_no = $12
       WHERE id::text = $13::text RETURNING *`,
      [relativeName || '', lmpDate || '', weeksOfPreg || '', parseInt(noOfSons, 10) || 0, sonsAge || '', parseInt(noOfDaughters, 10) || 0, daughtersAge || '', indications || '', scanResult || '', doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', clinicRegNo || 'RC197', validId]
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

app.post('/api/sync/cloud', async (req, res) => {
  if (!cleanCloudUrl) return res.status(400).json({ success: false, error: 'CLOUD_DATABASE_URL is not defined in .env' });

  let localClient, cloudClient;
  try {
    localClient = await pool.connect();
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Local DB error: ' + err.message });
  }

  try {
    cloudClient = await cloudPool.connect();
  } catch (err) {
    localClient.release();
    return res.status(503).json({ success: false, error: 'Cannot connect to Cloud DB: ' + err.message });
  }

  try {
    await cloudClient.query('BEGIN');
    await cloudClient.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    await cloudClient.query(`
      CREATE TABLE IF NOT EXISTS app_auth (id SERIAL PRIMARY KEY, role VARCHAR(50) DEFAULT 'admin', password VARCHAR(255) NOT NULL);
      CREATE TABLE IF NOT EXISTS clinic_centres (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, centre_name VARCHAR(255) NOT NULL, tagline VARCHAR(255), address TEXT, phone VARCHAR(100), reg_no VARCHAR(100) DEFAULT 'RC197', email VARCHAR(100), centre_password VARCHAR(255) DEFAULT '1234', owner_password VARCHAR(255) DEFAULT 'owner123', is_private BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS referring_doctors (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, centre_id UUID, doctor_name VARCHAR(255) NOT NULL, hospital_clinic_name VARCHAR(255), commission_type VARCHAR(50) DEFAULT 'percentage', commission_value DECIMAL(10,2) DEFAULT 0.00);
      CREATE TABLE IF NOT EXISTS test_master (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, centre_id UUID, test_name VARCHAR(255) NOT NULL, category VARCHAR(100) DEFAULT 'Pathology', price DECIMAL(10,2) DEFAULT 0.00, cut_type VARCHAR(20) DEFAULT 'fixed', test_cut DECIMAL(10,2) DEFAULT 0.00);
      CREATE TABLE IF NOT EXISTS patients (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, centre_id UUID, patient_code VARCHAR(100), full_name VARCHAR(255) NOT NULL, age INT DEFAULT 0, gender VARCHAR(20), phone VARCHAR(50), email VARCHAR(255), whatsapp_number VARCHAR(50), address TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS visits (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, centre_id UUID, patient_id UUID REFERENCES patients(id) ON DELETE CASCADE, referring_doctor_id UUID, total_amount DECIMAL(10,2) DEFAULT 0.00, concession DECIMAL(10,2) DEFAULT 0.00, paid_amount DECIMAL(10,2) DEFAULT 0.00, balance_amount DECIMAL(10,2) DEFAULT 0.00, payment_status VARCHAR(50) DEFAULT 'Pending', payment_mode VARCHAR(50) DEFAULT 'Cash', invoice_number VARCHAR(100), doctor_commission DECIMAL(10,2) DEFAULT 0.00, report_file VARCHAR(255), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS patient_investigations (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, visit_id UUID, test_id UUID, barcode VARCHAR(100), status VARCHAR(50) DEFAULT 'Registered', price DECIMAL(10, 2), cut_type VARCHAR(20) DEFAULT 'fixed', test_cut DECIMAL(10, 2) DEFAULT 0.00);
      CREATE TABLE IF NOT EXISTS pcpndt_forms (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, visit_id UUID, centre_id UUID, relative_name VARCHAR(255), no_of_sons INT DEFAULT 0, sons_age VARCHAR(100), no_of_daughters INT DEFAULT 0, daughters_age VARCHAR(100), lmp_date VARCHAR(50), weeks_of_preg VARCHAR(50), indications TEXT, scan_result TEXT, doctor_name VARCHAR(255) DEFAULT 'Dr NIKUNJ KOTHIA', doctor_reg_no VARCHAR(100) DEFAULT '2009/09/3218', clinic_reg_no VARCHAR(100) DEFAULT 'RC197', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS imaging_templates (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, centre_id UUID, template_name VARCHAR(255) NOT NULL, title VARCHAR(255) NOT NULL, category VARCHAR(100) DEFAULT 'Ultrasonography', default_impression TEXT, template_body TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS imaging_reports (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, visit_id UUID, patient_id UUID, centre_id UUID, template_id UUID, template_name VARCHAR(255), report_text TEXT NOT NULL, impression TEXT, doctor_name VARCHAR(255) DEFAULT 'Dr NIKUNJ KOTHIA', doctor_reg_no VARCHAR(100) DEFAULT '2009/09/3218', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    `);

    const auths = await localClient.query('SELECT * FROM app_auth WHERE role = $1', ['admin']);
    if (auths.rows.length > 0) {
      await cloudClient.query(`INSERT INTO app_auth (id, role, password) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET password = EXCLUDED.password`, [auths.rows[0].id, auths.rows[0].role, auths.rows[0].password]);
    }

    const centres = await localClient.query('SELECT * FROM clinic_centres');
    for (const c of centres.rows) {
      await cloudClient.query(`
        INSERT INTO clinic_centres (id, centre_name, tagline, address, phone, reg_no, email, centre_password, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO UPDATE SET centre_name = EXCLUDED.centre_name, tagline = EXCLUDED.tagline, address = EXCLUDED.address, phone = EXCLUDED.phone, reg_no = EXCLUDED.reg_no, email = EXCLUDED.email, centre_password = EXCLUDED.centre_password;
      `, [c.id, c.centre_name, c.tagline, c.address, c.phone, c.reg_no, c.email, c.centre_password, c.created_at]);
    }

    const doctors = await localClient.query('SELECT * FROM referring_doctors');
    for (const d of doctors.rows) {
      await cloudClient.query(`
        INSERT INTO referring_doctors (id, centre_id, doctor_name, hospital_clinic_name, commission_type, commission_value)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET doctor_name = EXCLUDED.doctor_name, hospital_clinic_name = EXCLUDED.hospital_clinic_name, commission_type = EXCLUDED.commission_type, commission_value = EXCLUDED.commission_value;
      `, [d.id, d.centre_id, d.doctor_name, d.hospital_clinic_name, d.commission_type, d.commission_value]);
    }

    const tests = await localClient.query('SELECT * FROM test_master');
    for (const t of tests.rows) {
      await cloudClient.query(`
        INSERT INTO test_master (id, centre_id, test_name, category, price, cut_type, test_cut)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (id) DO UPDATE SET test_name = EXCLUDED.test_name, category = EXCLUDED.category, price = EXCLUDED.price, cut_type = EXCLUDED.cut_type, test_cut = EXCLUDED.test_cut;
      `, [t.id, t.centre_id, t.test_name, t.category, t.price, t.cut_type || 'percentage', t.test_cut]);
    }

    const templates = await localClient.query('SELECT * FROM imaging_templates');
    for (const t of templates.rows) {
      await cloudClient.query(
        `INSERT INTO imaging_templates (id, centre_id, template_name, title, category, default_impression, template_body)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE 
         SET title = EXCLUDED.title, category = EXCLUDED.category, default_impression = EXCLUDED.default_impression, template_body = EXCLUDED.template_body`,
        [t.id, t.centre_id, t.template_name, t.title, t.category, t.default_impression, t.template_body]
      );
    }

    await cloudClient.query('COMMIT');
    res.status(200).json({ success: true, message: 'Cloud Sync Successful!' });
  } catch (err) {
    try { await cloudClient.query('ROLLBACK'); } catch (rb) {}
    res.status(500).json({ success: false, error: 'Cloud Sync Failed: ' + err.message });
  } finally {
    if (localClient) localClient.release();
    if (cloudClient) cloudClient.release();
  }
});

app.get('*', (req, res) => {
  const publicIndex = path.join(__dirname, 'public', 'index.html');
  const rootIndex = path.join(__dirname, 'index.html');
  res.setHeader('Content-Type', 'text/html');
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  res.status(404).send('index.html not found.');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  initDB();
});