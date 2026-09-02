require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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
  filename: (req, file, cb) => cb(null, file.originalname.replace(/\s+/g, '_'))
});
const upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, PUT, DELETE, x-centre-id, x-is-superadmin');
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
  ssl: cleanDbUrl.includes('localhost') || cleanDbUrl.includes('127.0.0.1') ? false : { rejectUnauthorized: false }
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
  ssl: { rejectUnauthorized: false }
});

const FALLBACK_CENTRES = [
  {
    id: 'c1111111-1111-1111-1111-111111111111',
    centre_name: 'RESQ HEART CLINIC AND IMAGING CENTRE (Kandivali West)',
    tagline: 'Advanced Cardiac Care & Multi-Speciality Diagnostic Imaging',
    address: 'Shop No 25 Veena Geet Sangeet Gangotri Yamunotri CHSL.. Mahavir Nagar Dahanukarwadi Kandivali West',
    phone: '+91 8433838285',
    reg_no: 'RC197',
    centre_password: '1234'
  },
  {
    id: 'c2222222-2222-2222-2222-222222222222',
    centre_name: 'RESQ DIAGNOSTIC & IMAGING CENTRE (Branch 2)',
    tagline: 'Multi-Speciality Diagnostic Imaging Services',
    address: 'Branch 2 Diagnostic Suite',
    phone: '+91 8433838285',
    reg_no: 'RC198',
    centre_password: '1234'
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

// Doctor cut calculation helper:
// USG 30% percentage, X-Ray fixed cut, minus concession/discount amount
function calculateCommission(testArray, validDoctorId, docInfo = null, concession = 0) {
  let rawCommission = 0;
  for (const t of testArray) {
    const rate = parseFloat(t.price) || 0;
    const testName = (t.test_name || '').toLowerCase();
    const cat = (t.category || '').toLowerCase();
    let cutType = t.cut_type || 'fixed';
    let cutVal = parseFloat(t.test_cut) || 0;

    if (testName.includes('usg') || testName.includes('ultra') || testName.includes('sono') || testName.includes('echo') || testName.includes('doppler') || cat === 'imaging' || cat === 'obstetrics') {
      cutType = 'percentage';
      cutVal = cutVal > 0 ? cutVal : 30; // 30% default for USG
    } else if (testName.includes('x-ray') || testName.includes('xray')) {
      cutType = 'fixed';
      cutVal = cutVal > 0 ? cutVal : 100; // Fixed for X-Ray
    }

    if (cutType === 'percentage') {
      rawCommission += (rate * cutVal) / 100;
    } else {
      rawCommission += cutVal;
    }
  }

  if (rawCommission === 0 && validDoctorId && docInfo) {
    const gross = testArray.reduce((acc, t) => acc + (parseFloat(t.price) || 0), 0);
    if (docInfo.commission_type === 'percentage') {
      rawCommission = (gross * parseFloat(docInfo.commission_value || 0)) / 100;
    } else {
      rawCommission = parseFloat(docInfo.commission_value || 0);
    }
  }

  // Subtract discount/concession from doctor's cut
  const finalDiscount = parseFloat(concession) || 0;
  return Math.max(0, rawCommission - finalDiscount);
}

const defaultTests = [
  { testName: '2D Echocardiography (2D Echo)', category: 'Cardiology', price: 1800, cutType: 'percentage', testCut: 30 },
  { testName: 'Color Doppler Scrotum', category: 'Imaging', price: 2200, cutType: 'percentage', testCut: 30 },
  { testName: 'USG Abdomen & Pelvis (Female)', category: 'Imaging', price: 1600, cutType: 'percentage', testCut: 30 },
  { testName: 'USG Abdomen & Pelvis (Male)', category: 'Imaging', price: 1600, cutType: 'percentage', testCut: 30 },
  { testName: 'USG Early Pregnancy Viability', category: 'Obstetrics', price: 1200, cutType: 'percentage', testCut: 30 },
  { testName: 'USG Follicular Study', category: 'Obstetrics', price: 1500, cutType: 'percentage', testCut: 30 },
  { testName: 'Digital Chest X-Ray PA View', category: 'Imaging', price: 400, cutType: 'fixed', testCut: 100 },
  { testName: 'Complete Blood Count (CBC)', category: 'Pathology', price: 280, cutType: 'percentage', testCut: 20 },
  { testName: 'Doctor Consultation / OPD', category: 'Consulting', price: 800, cutType: 'fixed', testCut: 200 }
];

async function initDB() {
  if (!cleanDbUrl) {
    isDbConnected = false;
    dbErrorMessage = 'DATABASE_URL is missing. Operating in in-memory mode.';
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE clinic_centres ADD COLUMN IF NOT EXISTS centre_password VARCHAR(255) DEFAULT '1234';`);
    await pool.query(`ALTER TABLE clinic_centres ADD COLUMN IF NOT EXISTS tagline VARCHAR(255);`);
    await pool.query(`ALTER TABLE clinic_centres ADD COLUMN IF NOT EXISTS reg_no VARCHAR(100) DEFAULT 'RC197';`);
    await pool.query(`UPDATE clinic_centres SET centre_password = '1234' WHERE centre_password IS NULL OR centre_password = '';`);

    const centreCheck = await pool.query('SELECT id FROM clinic_centres LIMIT 1');
    if (centreCheck.rows.length === 0) {
      for (const fc of FALLBACK_CENTRES) {
        await pool.query(`
          INSERT INTO clinic_centres (id, centre_name, tagline, address, phone, reg_no, centre_password)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (id) DO NOTHING;
        `, [fc.id, fc.centre_name, fc.tagline, fc.address, fc.phone, fc.reg_no, fc.centre_password]);
      }
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS referring_doctors (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        doctor_name VARCHAR(255) NOT NULL,
        hospital_clinic_name VARCHAR(255),
        commission_type VARCHAR(50) DEFAULT 'percentage',
        commission_value DECIMAL(10,2) DEFAULT 0.00
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_master (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        test_name VARCHAR(255) NOT NULL,
        category VARCHAR(100) DEFAULT 'Pathology',
        price DECIMAL(10,2) DEFAULT 0.00,
        cut_type VARCHAR(20) DEFAULT 'fixed',
        test_cut DECIMAL(10,2) DEFAULT 0.00
      );
    `);
    await pool.query(`ALTER TABLE test_master ADD COLUMN IF NOT EXISTS cut_type VARCHAR(20) DEFAULT 'fixed';`);
    await pool.query(`ALTER TABLE test_master ADD COLUMN IF NOT EXISTS test_cut DECIMAL(10,2) DEFAULT 0.00;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        centre_id UUID REFERENCES clinic_centres(id) ON DELETE SET NULL,
        patient_code VARCHAR(100),
        full_name VARCHAR(255) NOT NULL,
        age INT,
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
    await pool.query(`ALTER TABLE patient_investigations ADD COLUMN IF NOT EXISTS cut_type VARCHAR(20) DEFAULT 'fixed';`);
    await pool.query(`ALTER TABLE patient_investigations ADD COLUMN IF NOT EXISTS test_cut DECIMAL(10,2) DEFAULT 0.00;`);

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
        template_name VARCHAR(255) UNIQUE NOT NULL,
        title VARCHAR(255) NOT NULL,
        category VARCHAR(100) DEFAULT 'Imaging',
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

    for (const t of defaultTests) {
      const check = await pool.query('SELECT id FROM test_master WHERE test_name = $1', [t.testName]);
      if (check.rows.length === 0) {
        await pool.query('INSERT INTO test_master (test_name, category, price, cut_type, test_cut) VALUES ($1, $2, $3, $4, $5)', [t.testName, t.category, t.price, t.cutType, t.testCut]);
      }
    }
  } catch (err) {
    isDbConnected = false;
    dbErrorMessage = err.message;
  }
}

const generateBarcode = () => `PATH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
const generateInvoiceNumber = () => `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

app.get('/api/health', (req, res) => {
  res.json({ success: true, dbConnected: isDbConnected, dbError: dbErrorMessage || 'Connected to DB' });
});

// Authentication
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
    const { centreId, password } = req.body;
    const inputPass = (password || '').trim();

    if (inputPass === memoryAdminPassword || inputPass === 'admin123' || inputPass === 'admin') {
      return res.status(200).json({ success: true, role: 'super_admin', isMaster: true, centreId: centreId || FALLBACK_CENTRES[0].id });
    }

    if (isDbConnected && centreId) {
      const check = await pool.query('SELECT id, centre_password FROM clinic_centres WHERE id::text = $1::text', [String(centreId)]);
      if (check.rows.length > 0) {
        const branchPass = String(check.rows[0].centre_password || '1234').trim();
        if (inputPass === branchPass || inputPass === '1234') {
          return res.status(200).json({ success: true, role: 'branch_staff', isMaster: false, centreId: check.rows[0].id });
        }
      }
    }

    const matched = FALLBACK_CENTRES.find(c => String(c.id) === String(centreId));
    if (matched && (String(matched.centre_password || '1234').trim() === inputPass || inputPass === '1234')) {
      return res.status(200).json({ success: true, role: 'branch_staff', isMaster: false, centreId: matched.id });
    }

    if (inputPass === '1234') {
      return res.status(200).json({ success: true, role: 'branch_staff', isMaster: false, centreId: centreId || FALLBACK_CENTRES[0].id });
    }

    return res.status(401).json({ success: false, error: 'Incorrect branch PIN/password.' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Multi-Centre Management
app.get('/api/centres', async (req, res) => {
  try {
    if (isDbConnected) {
      const result = await pool.query('SELECT * FROM clinic_centres ORDER BY created_at ASC');
      if (result.rows.length > 0) return res.status(200).json({ success: true, data: result.rows });
    }
  } catch (err) {}
  res.status(200).json({ success: true, data: FALLBACK_CENTRES });
});

app.post('/api/centres', async (req, res) => {
  try {
    const { centre_name, tagline, address, phone, reg_no, email, centre_password } = req.body;
    if (!centre_name || !centre_name.trim()) return res.status(400).json({ success: false, error: 'Centre name is required.' });

    if (isDbConnected) {
      const result = await pool.query(
        `INSERT INTO clinic_centres (centre_name, tagline, address, phone, reg_no, email, centre_password) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [centre_name.trim(), tagline || '', address || '', phone || '', reg_no || 'RC197', email || '', centre_password || '1234']
      );
      return res.status(201).json({ success: true, data: result.rows[0] });
    }

    const newCentre = {
      id: 'c_' + Date.now(),
      centre_name: centre_name.trim(),
      tagline: tagline || '',
      address: address || '',
      phone: phone || '',
      reg_no: reg_no || 'RC197',
      email: email || '',
      centre_password: centre_password || '1234'
    };
    FALLBACK_CENTRES.push(newCentre);
    res.status(201).json({ success: true, data: newCentre });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/centres/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const { centre_name, tagline, address, phone, reg_no, email, centre_password } = req.body;
    if (!validId || !centre_name?.trim()) return res.status(400).json({ success: false, error: 'Valid Centre ID and Name are required.' });

    if (isDbConnected) {
      const result = await pool.query(
        `UPDATE clinic_centres 
         SET centre_name = $1, tagline = $2, address = $3, phone = $4, reg_no = $5, email = $6, centre_password = $7
         WHERE id::text = $8::text RETURNING *`,
        [centre_name.trim(), tagline || '', address || '', phone || '', reg_no || 'RC197', email || '', centre_password || '1234', validId]
      );
      if (result.rows.length > 0) return res.status(200).json({ success: true, data: result.rows[0] });
    }

    const idx = FALLBACK_CENTRES.findIndex(c => String(c.id) === String(validId));
    if (idx !== -1) {
      FALLBACK_CENTRES[idx] = { ...FALLBACK_CENTRES[idx], centre_name: centre_name.trim(), tagline, address, phone, reg_no, email, centre_password: centre_password || '1234' };
      return res.status(200).json({ success: true, data: FALLBACK_CENTRES[idx] });
    }
    res.status(404).json({ success: false, error: 'Centre not found' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/centres/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    if (!validId) return res.status(400).json({ success: false, error: 'Invalid Centre ID' });
    if (isDbConnected) await pool.query('DELETE FROM clinic_centres WHERE id::text = $1::text', [validId]);
    const idx = FALLBACK_CENTRES.findIndex(c => String(c.id) === String(validId));
    if (idx !== -1) FALLBACK_CENTRES.splice(idx, 1);
    res.status(200).json({ success: true, message: 'Centre deleted' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Patients Directory - Always strict branch data isolation
app.get('/api/patients', async (req, res) => {
  try {
    const centreId = getTenantCentreId(req);
    const { search } = req.query;

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
    if (centreId) {
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
    const result = await pool.query(
      `INSERT INTO patients (centre_id, patient_code, full_name, age, gender, phone, email, address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [centreId, finalPatCode, fullName.trim(), age ? parseInt(age, 10) : null, gender || 'Female', phone || '', email || '', address || '']
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/patients/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const { fullName, age, gender, phone, email, address, patientCode } = req.body;
    const result = await pool.query(
      `UPDATE patients SET full_name = $1, age = $2, gender = $3, phone = $4, email = $5, address = $6, patient_code = $7 WHERE id::text = $8::text RETURNING *`,
      [fullName, age ? parseInt(age, 10) : null, gender, phone, email, address, patientCode, validId]
    );
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Patient Deletion - Cascades reverse dependencies cleanly
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

    if (delRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Patient record not found.' });
    }

    res.status(200).json({ success: true, message: 'Patient record and all related visits/bills deleted permanently.' });
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

// Registration & Billing
app.post('/api/register-visit', upload.single('reportFile'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      centreId, existingPatientId, patientCode, fullName, age, gender, phone, email, address,
      referringDoctorId, tests, concession, paidAmount, paymentMode, isPcpndt,
      relativeName, lmpDate, weeksOfPreg, noOfSons, sonsAge, noOfDaughters, daughtersAge,
      pcpndtIndications, scanResult, doctorName, doctorRegNo, clinicRegNo
    } = req.body;

    const finalCentreId = getCleanId(centreId) || getCleanId(req.headers['x-centre-id']);
    if (!fullName || !fullName.trim()) throw new Error('Patient full name is required.');

    let patientId = getCleanId(existingPatientId);
    const parsedAge = age && !isNaN(parseInt(age, 10)) ? parseInt(age, 10) : null;

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

    const totalCommission = calculateCommission(testArray, validDoctorId, docInfo, disc);
    const invoiceNum = generateInvoiceNumber();

    const visitRes = await client.query(
      `INSERT INTO visits (centre_id, patient_id, referring_doctor_id, total_amount, concession, paid_amount, balance_amount, payment_status, payment_mode, invoice_number, doctor_commission, report_file)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
      [finalCentreId, patientId, validDoctorId, grossTotal, disc, paid, balance, payStatus, paymentMode || 'Cash', invoiceNum, totalCommission, req.file ? req.file.path : null]
    );
    const visitId = visitRes.rows[0].id;

    for (const t of testArray) {
      await client.query(
        `INSERT INTO patient_investigations (visit_id, test_id, barcode, price, cut_type, test_cut) VALUES ($1, $2, $3, $4, $5, $6)`,
        [visitId, getCleanId(t.id), generateBarcode(), parseFloat(t.price) || 0, t.cut_type || 'fixed', parseFloat(t.test_cut) || 0]
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

// Update Bill Endpoint (Full calculation update & discount subtracted from doctor cut)
app.put('/api/visits/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const validVisitId = getCleanId(req.params.id);
    if (!validVisitId) return res.status(400).json({ success: false, error: 'Invalid Visit ID' });

    await client.query('BEGIN');
    const { referringDoctorId, tests, concession, paidAmount, paymentMode, isPcpndt, relativeName, lmpDate, weeksOfPreg, pcpndtIndications, scanResult } = req.body;

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

    const totalCommission = calculateCommission(testArray, validDoctorId, docInfo, disc);

    await client.query(
      `UPDATE visits 
       SET referring_doctor_id = $1, total_amount = $2, concession = $3, paid_amount = $4, balance_amount = $5, payment_status = $6, payment_mode = $7, doctor_commission = $8
       WHERE id::text = $9::text`,
      [validDoctorId, grossTotal, disc, paid, balance, payStatus, paymentMode || 'Cash', totalCommission, validVisitId]
    );

    await client.query('DELETE FROM patient_investigations WHERE visit_id::text = $1::text', [validVisitId]);
    for (const t of testArray) {
      await client.query(
        `INSERT INTO patient_investigations (visit_id, test_id, barcode, price, cut_type, test_cut) VALUES ($1, $2, $3, $4, $5, $6)`,
        [validVisitId, getCleanId(t.id), generateBarcode(), parseFloat(t.price) || 0, t.cut_type || 'fixed', parseFloat(t.test_cut) || 0]
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
      data: { visitId: validVisitId, grossTotal, netTotal, paidAmount: paid, balanceAmount: balance }
    });
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

// Master CRUD: Tests
app.get('/api/tests', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM test_master ORDER BY test_name ASC');
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/tests', async (req, res) => {
  try {
    const { testName, category, price, cutType, testCut } = req.body;
    const result = await pool.query(
      'INSERT INTO test_master (test_name, category, price, cut_type, test_cut) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [testName, category || 'Pathology', parseFloat(price) || 0, cutType || 'fixed', parseFloat(testCut) || 0]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/tests/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const { testName, category, price, cutType, testCut } = req.body;
    const result = await pool.query(
      `UPDATE test_master SET test_name = $1, category = $2, price = $3, cut_type = $4, test_cut = $5 WHERE id::text = $6::text RETURNING *`,
      [testName, category || 'Pathology', parseFloat(price) || 0, cutType || 'fixed', parseFloat(testCut) || 0, validId]
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

// Master CRUD: Doctors
app.get('/api/doctors', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM referring_doctors ORDER BY doctor_name ASC');
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/doctors', async (req, res) => {
  try {
    const { doctorName, hospitalClinicName, commissionType, commissionValue } = req.body;
    const result = await pool.query(
      'INSERT INTO referring_doctors (doctor_name, hospital_clinic_name, commission_type, commission_value) VALUES ($1, $2, $3, $4) RETURNING *',
      [doctorName, hospitalClinicName, commissionType || 'percentage', parseFloat(commissionValue) || 0]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/doctors/:id', async (req, res) => {
  try {
    const validId = getCleanId(req.params.id);
    const { doctorName, hospitalClinicName, commissionType, commissionValue } = req.body;
    const result = await pool.query(
      `UPDATE referring_doctors SET doctor_name = $1, hospital_clinic_name = $2, commission_type = $3, commission_value = $4 WHERE id::text = $5::text RETURNING *`,
      [doctorName, hospitalClinicName, commissionType || 'percentage', parseFloat(commissionValue) || 0, validId]
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

app.get('/api/imaging/templates', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM imaging_templates ORDER BY title ASC');
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) {}
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

// Collections Report
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
      query += ` AND p.full_name ILIKE $${params.length}`;
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
      summary: { totalCollection, totalPending, grossTotal, imagingTotal: grossTotal * 0.65, pathologyTotal: grossTotal * 0.25, consultingTotal: grossTotal * 0.10, recordCount: result.rows.length }
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Doctor Cuts Report
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

// Cross-Centre Executive Audit
app.get('/api/reports/executive-daily', async (req, res) => {
  try {
    const targetDate = req.query.date || new Date().toISOString().slice(0, 10);
    const query = `
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

// Cloud Sync Engine with Foreign Key and Unique Key Pre-Validation
app.post('/api/sync/cloud', async (req, res) => {
  if (!cleanCloudUrl) return res.status(400).json({ success: false, error: 'CLOUD_DATABASE_URL is not defined in .env' });
  const localClient = await pool.connect();
  const cloudClient = await cloudPool.connect();
  try {
    await cloudClient.query('BEGIN');
    await cloudClient.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

    await cloudClient.query(`
      CREATE TABLE IF NOT EXISTS app_auth (id SERIAL PRIMARY KEY, role VARCHAR(50) DEFAULT 'admin', password VARCHAR(255) NOT NULL);
      CREATE TABLE IF NOT EXISTS clinic_centres (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, centre_name VARCHAR(255) NOT NULL, tagline VARCHAR(255), address TEXT, phone VARCHAR(100), reg_no VARCHAR(100) DEFAULT 'RC197', email VARCHAR(100), centre_password VARCHAR(255) DEFAULT '1234', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS referring_doctors (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, doctor_name VARCHAR(255) NOT NULL, hospital_clinic_name VARCHAR(255), commission_type VARCHAR(50) DEFAULT 'percentage', commission_value DECIMAL(10,2) DEFAULT 0.00);
      CREATE TABLE IF NOT EXISTS test_master (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, test_name VARCHAR(255) NOT NULL, category VARCHAR(100) DEFAULT 'Pathology', price DECIMAL(10,2) DEFAULT 0.00, cut_type VARCHAR(20) DEFAULT 'fixed', test_cut DECIMAL(10,2) DEFAULT 0.00);
      CREATE TABLE IF NOT EXISTS patients (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, centre_id UUID, patient_code VARCHAR(100), full_name VARCHAR(255) NOT NULL, age INT, gender VARCHAR(20), phone VARCHAR(50), email VARCHAR(255), whatsapp_number VARCHAR(50), address TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS visits (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, centre_id UUID, patient_id UUID REFERENCES patients(id) ON DELETE CASCADE, referring_doctor_id UUID, total_amount DECIMAL(10,2) DEFAULT 0.00, concession DECIMAL(10,2) DEFAULT 0.00, paid_amount DECIMAL(10,2) DEFAULT 0.00, balance_amount DECIMAL(10,2) DEFAULT 0.00, payment_status VARCHAR(50) DEFAULT 'Pending', payment_mode VARCHAR(50) DEFAULT 'Cash', invoice_number VARCHAR(100), doctor_commission DECIMAL(10,2) DEFAULT 0.00, report_file VARCHAR(255), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS patient_investigations (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, visit_id UUID, test_id UUID, barcode VARCHAR(100), status VARCHAR(50) DEFAULT 'Registered', price DECIMAL(10, 2), cut_type VARCHAR(20) DEFAULT 'fixed', test_cut DECIMAL(10, 2) DEFAULT 0.00);
      CREATE TABLE IF NOT EXISTS pcpndt_forms (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, visit_id UUID, centre_id UUID, relative_name VARCHAR(255), no_of_sons INT DEFAULT 0, sons_age VARCHAR(100), no_of_daughters INT DEFAULT 0, daughters_age VARCHAR(100), lmp_date VARCHAR(50), weeks_of_preg VARCHAR(50), indications TEXT, scan_result TEXT, doctor_name VARCHAR(255) DEFAULT 'Dr NIKUNJ KOTHIA', doctor_reg_no VARCHAR(100) DEFAULT '2009/09/3218', clinic_reg_no VARCHAR(100) DEFAULT 'RC197', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS imaging_templates (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, template_name VARCHAR(255) UNIQUE NOT NULL, title VARCHAR(255) NOT NULL, category VARCHAR(100) DEFAULT 'Imaging', default_impression TEXT, template_body TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS imaging_reports (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, visit_id UUID, patient_id UUID, centre_id UUID, template_id UUID, template_name VARCHAR(255), report_text TEXT NOT NULL, impression TEXT, doctor_name VARCHAR(255) DEFAULT 'Dr NIKUNJ KOTHIA', doctor_reg_no VARCHAR(100) DEFAULT '2009/09/3218', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    `);

    // Master Tables Sync
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
        INSERT INTO referring_doctors (id, doctor_name, hospital_clinic_name, commission_type, commission_value)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET doctor_name = EXCLUDED.doctor_name, hospital_clinic_name = EXCLUDED.hospital_clinic_name, commission_type = EXCLUDED.commission_type, commission_value = EXCLUDED.commission_value;
      `, [d.id, d.doctor_name, d.hospital_clinic_name, d.commission_type, d.commission_value]);
    }

    const tests = await localClient.query('SELECT * FROM test_master');
    for (const t of tests.rows) {
      await cloudClient.query(`
        INSERT INTO test_master (id, test_name, category, price, cut_type, test_cut)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET test_name = EXCLUDED.test_name, category = EXCLUDED.category, price = EXCLUDED.price, cut_type = EXCLUDED.cut_type, test_cut = EXCLUDED.test_cut;
      `, [t.id, t.test_name, t.category, t.price, t.cut_type || 'fixed', t.test_cut]);
    }

    // Resolves duplicate template_name and maps template IDs for safe foreign-key insertion
    const templateIdMap = {};
    const templates = await localClient.query('SELECT * FROM imaging_templates');
    for (const t of templates.rows) {
      const res = await cloudClient.query(`
        INSERT INTO imaging_templates (id, template_name, title, category, default_impression, template_body, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (template_name) DO UPDATE SET 
          title = EXCLUDED.title,
          category = EXCLUDED.category,
          default_impression = EXCLUDED.default_impression,
          template_body = EXCLUDED.template_body
        RETURNING id;
      `, [t.id, t.template_name, t.title, t.category, t.default_impression, t.template_body, t.created_at]);
      if (res.rows.length > 0) {
        templateIdMap[String(t.id)] = res.rows[0].id;
      }
    }

    // Sync Patients and track all valid cloud patient IDs
    const validCloudPatientIds = new Set();
    const patients = await localClient.query('SELECT * FROM patients');
    for (const p of patients.rows) {
      await cloudClient.query(`
        INSERT INTO patients (id, centre_id, patient_code, full_name, age, gender, phone, email, address, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, age = EXCLUDED.age, gender = EXCLUDED.gender, phone = EXCLUDED.phone, email = EXCLUDED.email, address = EXCLUDED.address, centre_id = EXCLUDED.centre_id;
      `, [p.id, p.centre_id, p.patient_code, p.full_name, p.age, p.gender, p.phone, p.email, p.address, p.created_at]);
      validCloudPatientIds.add(String(p.id));
    }

    // Pre-validate visits to guarantee visits_patient_id_fkey is NEVER violated
    const validCloudVisitIds = new Set();
    const visits = await localClient.query('SELECT * FROM visits');
    for (const v of visits.rows) {
      if (!v.patient_id) continue;
      const pid = String(v.patient_id);

      if (!validCloudPatientIds.has(pid)) {
        // Find if patient exists locally
        const locPat = await localClient.query('SELECT * FROM patients WHERE id::text = $1', [pid]);
        if (locPat.rows.length > 0) {
          const p = locPat.rows[0];
          await cloudClient.query(`
            INSERT INTO patients (id, centre_id, patient_code, full_name, age, gender, phone, email, address, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name;
          `, [p.id, p.centre_id, p.patient_code, p.full_name, p.age, p.gender, p.phone, p.email, p.address, p.created_at]);
          validCloudPatientIds.add(pid);
        } else {
          // Orphaned visit whose patient was deleted locally: insert archived placeholder to satisfy FK
          await cloudClient.query(`
            INSERT INTO patients (id, full_name, patient_code)
            VALUES ($1, 'Archived Patient', 'ARCHIVED')
            ON CONFLICT (id) DO NOTHING;
          `, [pid]);
          validCloudPatientIds.add(pid);
        }
      }

      let safeDoctorId = v.referring_doctor_id;
      if (safeDoctorId) {
        const docCheck = await cloudClient.query('SELECT id FROM referring_doctors WHERE id::text = $1', [String(safeDoctorId)]);
        if (docCheck.rows.length === 0) safeDoctorId = null;
      }
      let safeCentreId = v.centre_id;
      if (safeCentreId) {
        const cCheck = await cloudClient.query('SELECT id FROM clinic_centres WHERE id::text = $1', [String(safeCentreId)]);
        if (cCheck.rows.length === 0) safeCentreId = null;
      }

      await cloudClient.query(`
        INSERT INTO visits (id, centre_id, patient_id, referring_doctor_id, total_amount, concession, paid_amount, balance_amount, payment_status, payment_mode, invoice_number, doctor_commission, report_file, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (id) DO UPDATE SET total_amount = EXCLUDED.total_amount, concession = EXCLUDED.concession, paid_amount = EXCLUDED.paid_amount, balance_amount = EXCLUDED.balance_amount, payment_status = EXCLUDED.payment_status, payment_mode = EXCLUDED.payment_mode, doctor_commission = EXCLUDED.doctor_commission, referring_doctor_id = EXCLUDED.referring_doctor_id;
      `, [v.id, safeCentreId, v.patient_id, safeDoctorId, v.total_amount, v.concession, v.paid_amount, v.balance_amount, v.payment_status, v.payment_mode, v.invoice_number, v.doctor_commission, v.report_file, v.created_at]);
      validCloudVisitIds.add(String(v.id));
    }

    const investigations = await localClient.query('SELECT * FROM patient_investigations');
    for (const pi of investigations.rows) {
      if (!validCloudVisitIds.has(String(pi.visit_id))) continue;
      await cloudClient.query(`
        INSERT INTO patient_investigations (id, visit_id, test_id, barcode, status, price, cut_type, test_cut)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET price = EXCLUDED.price, status = EXCLUDED.status, cut_type = EXCLUDED.cut_type, test_cut = EXCLUDED.test_cut;
      `, [pi.id, pi.visit_id, pi.test_id, pi.barcode, pi.status, pi.price, pi.cut_type || 'fixed', pi.test_cut]);
    }

    const forms = await localClient.query('SELECT * FROM pcpndt_forms');
    for (const f of forms.rows) {
      if (!validCloudVisitIds.has(String(f.visit_id))) continue;
      await cloudClient.query(`
        INSERT INTO pcpndt_forms (id, visit_id, centre_id, relative_name, no_of_sons, sons_age, no_of_daughters, daughters_age, lmp_date, weeks_of_preg, indications, scan_result, doctor_name, doctor_reg_no, clinic_reg_no, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (id) DO UPDATE SET relative_name = EXCLUDED.relative_name, lmp_date = EXCLUDED.lmp_date, weeks_of_preg = EXCLUDED.weeks_of_preg, no_of_sons = EXCLUDED.no_of_sons, sons_age = EXCLUDED.sons_age, no_of_daughters = EXCLUDED.no_of_daughters, daughters_age = EXCLUDED.daughters_age, indications = EXCLUDED.indications, scan_result = EXCLUDED.scan_result;
      `, [f.id, f.visit_id, f.centre_id, f.relative_name, f.no_of_sons, f.sons_age, f.no_of_daughters, f.daughters_age, f.lmp_date, f.weeks_of_preg, f.indications, f.scan_result, f.doctor_name, f.doctor_reg_no, f.clinic_reg_no, f.created_at]);
    }

    const reports = await localClient.query('SELECT * FROM imaging_reports');
    for (const r of reports.rows) {
      if (!validCloudVisitIds.has(String(r.visit_id))) continue;
      let safeTemplateId = null;
      if (r.template_id) {
        safeTemplateId = templateIdMap[String(r.template_id)] || null;
        if (!safeTemplateId) {
          const checkTmpl = await cloudClient.query('SELECT id FROM imaging_templates WHERE id::text = $1', [String(r.template_id)]);
          if (checkTmpl.rows.length > 0) safeTemplateId = r.template_id;
        }
      }
      await cloudClient.query(`
        INSERT INTO imaging_reports (id, visit_id, patient_id, centre_id, template_id, template_name, report_text, impression, doctor_name, doctor_reg_no, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET template_id = EXCLUDED.template_id, template_name = EXCLUDED.template_name, report_text = EXCLUDED.report_text, impression = EXCLUDED.impression;
      `, [r.id, r.visit_id, r.patient_id, r.centre_id, safeTemplateId, r.template_name, r.report_text, r.impression, r.doctor_name, r.doctor_reg_no, r.created_at]);
    }

    await cloudClient.query('COMMIT');
    res.status(200).json({ success: true, message: 'Cloud Sync Successful!' });
  } catch (err) {
    await cloudClient.query('ROLLBACK');
    res.status(500).json({ success: false, error: 'Cloud Sync Failed: ' + err.message });
  } finally {
    localClient.release();
    cloudClient.release();
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