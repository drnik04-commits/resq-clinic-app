const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, './uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, PUT, DELETE');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  next();
});

// Database Connection: Cloud Auto-Detection with local fallback
const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_Gmo8JSix3TAt@ep-shy-scene-axrfju67.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require';
const isCloud = connectionString.includes('neon.tech') || connectionString.includes('render.com') || connectionString.includes('aws');

const pool = new Pool({
  connectionString,
  ssl: isCloud ? { rejectUnauthorized: false } : false
});

// Test Catalog Seed Data
const lupinTests = [
  { testName: 'Doctor Consultation / Cardiology OPD', category: 'Consulting', price: 800, testCut: 200 },
  { testName: 'Doctor Consultation / General Follow-up', category: 'Consulting', price: 500, testCut: 100 },
  { testName: 'LDIMM0481 - Dual Marker (Double Marker)- First', category: 'Pathology', price: 2250, testCut: 500 },
  { testName: 'LDIMM1192 - Thyroid Profile Total', category: 'Pathology', price: 550, testCut: 80 },
  { testName: 'LDIMM1195 - Thyroid Stimulating Hormone (TSH)', category: 'Pathology', price: 350, testCut: 50 },
  { testName: 'LDBIO0634 - HbA1c (Glycated Haemoglobin)', category: 'Pathology', price: 500, testCut: 150 },
  { testName: 'LDHEM0378 - Complete Blood Count (CBC)', category: 'Pathology', price: 280, testCut: 80 },
  { testName: 'LDIMM1274 - Vitamin D 25 - OH', category: 'Pathology', price: 1500, testCut: 250 },
  { testName: 'LDIMM0169 - Anti Mullerian Hormone (AMH) Serum', category: 'Pathology', price: 1850, testCut: 500 },
  { testName: 'LDIMM1094 - Prolactin', category: 'Pathology', price: 600, testCut: 90 },
  { testName: 'LDIMM0231 - Beta hCG Serum', category: 'Pathology', price: 700, testCut: 200 },
  { testName: 'LDMIC1328 - Culture and Sensitivity Urine- VITEK', category: 'Pathology', price: 900, testCut: 150 },
  { testName: 'LDIMM1268 - Vitamin B12 (Cyanocobalamin)', category: 'Pathology', price: 1200, testCut: 200 },
  { testName: 'LDIMM1320 - FSH/LH/Prolactin', category: 'Pathology', price: 1500, testCut: 250 },
  { testName: 'LDBIO1796 - LIPID PROFILE', category: 'Pathology', price: 750, testCut: 150 },
  { testName: 'LDIMM1112 - Quadruple Marker- Second Trimester', category: 'Pathology', price: 3000, testCut: 800 },
  { testName: 'LDIMM1191 - Thyroid Profile Free', category: 'Pathology', price: 750, testCut: 150 },
  { testName: 'LDBIO0408 - Creatinine Serum', category: 'Pathology', price: 220, testCut: 60 },
  { testName: '2D Echocardiography (2D Echo)', category: 'Imaging', price: 1800, testCut: 400 },
  { testName: 'USG Obstetric / Pregnancy Ultrasound', category: 'Imaging', price: 1500, testCut: 300 },
  { testName: 'USG Pelvis / Anomaly Scan', category: 'Imaging', price: 2000, testCut: 400 },
  { testName: 'USG Abdomen & Pelvis', category: 'Imaging', price: 1600, testCut: 300 }
];

async function seedLupinTests() {
  try {
    for (const t of lupinTests) {
      const check = await pool.query('SELECT id FROM test_master WHERE test_name = $1', [t.testName]);
      if (check.rows.length === 0) {
        await pool.query(
          'INSERT INTO test_master (test_name, category, price, test_cut) VALUES ($1, $2, $3, $4)',
          [t.testName, t.category, t.price, t.testCut]
        );
      }
    }
  } catch (err) {
    console.error('Error seeding tests:', err.message);
  }
}

// Database Initialization & Non-Destructive Synchronizations
async function initDB() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

    // 1. Password Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_auth (
        id SERIAL PRIMARY KEY,
        role VARCHAR(50) DEFAULT 'admin',
        password VARCHAR(255) NOT NULL
      );
    `);
    const authCheck = await pool.query("SELECT id FROM app_auth WHERE role = 'admin' LIMIT 1");
    if (authCheck.rows.length === 0) {
      await pool.query("INSERT INTO app_auth (role, password) VALUES ('admin', 'admin123')");
    }

    // 2. Multi-Centre Management Table (Updated to RS197)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clinic_centres (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        centre_name VARCHAR(255) NOT NULL,
        tagline VARCHAR(255),
        address TEXT,
        phone VARCHAR(100),
        reg_no VARCHAR(100),
        email VARCHAR(100),
        is_active BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Update existing default reg_no to RS197
    await pool.query(`UPDATE clinic_centres SET reg_no = 'RS197' WHERE reg_no = 'RC197' OR reg_no IS NULL;`);

    const centreCheck = await pool.query('SELECT id FROM clinic_centres LIMIT 1');
    if (centreCheck.rows.length === 0) {
      await pool.query(`
        INSERT INTO clinic_centres (centre_name, tagline, address, phone, reg_no, is_active)
        VALUES (
          'RESQ HEART CLINIC AND IMAGING CENTRE',
          'Advanced Cardiac Care & Multi-Speciality Diagnostic Imaging',
          'Shop No 25 Veena Geet Sangeet Gangotri Yamunotri CHSL, Mahavir Nagar Dahanukarwadi Kandivali West Mumbai -400 067.',
          '+91 8433838285',
          'RS197',
          true
        );
      `);
    }

    // 3. Referring Doctors Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS referring_doctors (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        doctor_name VARCHAR(255) NOT NULL,
        hospital_clinic_name VARCHAR(255),
        commission_type VARCHAR(50) DEFAULT 'percentage',
        commission_value DECIMAL(10,2) DEFAULT 0.00
      );
    `);

    // 4. Test Master Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_master (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        test_name VARCHAR(255) NOT NULL,
        category VARCHAR(100) DEFAULT 'Pathology',
        price DECIMAL(10,2) DEFAULT 0.00,
        test_cut DECIMAL(10,2) DEFAULT 0.00
      );
    `);
    await pool.query(`ALTER TABLE test_master ADD COLUMN IF NOT EXISTS test_cut DECIMAL(10,2) DEFAULT 0.00;`);

    // 5. Patients Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patients (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        patient_code VARCHAR(100) UNIQUE,
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
    await pool.query(`ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_phone_key;`).catch(() => {});
    await pool.query(`ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_phone_unique;`).catch(() => {});

    // 6. Visits Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visits (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        centre_id UUID REFERENCES clinic_centres(id) ON DELETE SET NULL,
        patient_id UUID REFERENCES patients(id),
        referring_doctor_id UUID REFERENCES referring_doctors(id),
        total_amount DECIMAL(10,2) DEFAULT 0.00,
        concession DECIMAL(10,2) DEFAULT 0.00,
        paid_amount DECIMAL(10,2) DEFAULT 0.00,
        balance_amount DECIMAL(10,2) DEFAULT 0.00,
        payment_status VARCHAR(50) DEFAULT 'Pending',
        payment_mode VARCHAR(50) DEFAULT 'Cash',
        invoice_number VARCHAR(100) UNIQUE,
        doctor_commission DECIMAL(10,2) DEFAULT 0.00,
        report_file VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE visits ADD COLUMN IF NOT EXISTS centre_id UUID REFERENCES clinic_centres(id) ON DELETE SET NULL;`);
    await pool.query(`ALTER TABLE visits ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(50) DEFAULT 'Cash';`);

    await pool.query(`
      UPDATE visits 
      SET centre_id = (SELECT id FROM clinic_centres WHERE is_active = true LIMIT 1) 
      WHERE centre_id IS NULL;
    `);

    // 7. Patient Investigations Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS patient_investigations (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        visit_id UUID REFERENCES visits(id) ON DELETE CASCADE,
        test_id UUID REFERENCES test_master(id) ON DELETE SET NULL,
        barcode VARCHAR(100),
        status VARCHAR(50) DEFAULT 'Registered',
        price DECIMAL(10, 2)
      );
    `);
    await pool.query(`ALTER TABLE patient_investigations DROP CONSTRAINT IF EXISTS patient_investigations_test_id_fkey;`).catch(() => {});
    await pool.query(`ALTER TABLE patient_investigations ADD CONSTRAINT patient_investigations_test_id_fkey FOREIGN KEY (test_id) REFERENCES test_master(id) ON DELETE SET NULL;`).catch(() => {});

    // 8. PCPNDT Forms Table (Updated with RS197 Clinic Reg No)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pcpndt_forms (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        visit_id UUID REFERENCES visits(id) ON DELETE CASCADE,
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
        clinic_reg_no VARCHAR(100) DEFAULT 'RS197',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await pool.query(`ALTER TABLE pcpndt_forms ADD COLUMN IF NOT EXISTS scan_result TEXT;`);
    await pool.query(`ALTER TABLE pcpndt_forms ADD COLUMN IF NOT EXISTS clinic_reg_no VARCHAR(100) DEFAULT 'RS197';`);
    await pool.query(`UPDATE pcpndt_forms SET clinic_reg_no = 'RS197' WHERE clinic_reg_no = 'RC197' OR clinic_reg_no IS NULL;`);

    console.log('Database synced: All tables, instant search, RS197 reg no, and PCPNDT ready.');
    await seedLupinTests();
  } catch (err) {
    console.error('Database Initialization Error:', err.message);
  }
}

const generateBarcode = () => {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `PATH-${dateStr}-${randomNum}`;
};

const generateInvoiceNumber = () => {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `INV-${dateStr}-${randomNum}`;
};

// ----------------------------------------------------
// AUTHENTICATION ENDPOINTS
// ----------------------------------------------------
app.post('/api/auth/verify', async (req, res) => {
  try {
    const inputPass = (req.body.password || '').trim();
    if (inputPass === 'admin123') {
      return res.status(200).json({ success: true });
    }

    const result = await pool.query("SELECT password FROM app_auth WHERE role = 'admin' LIMIT 1");
    if (result.rows.length && result.rows[0].password.trim() === inputPass) {
      return res.status(200).json({ success: true });
    }
    return res.status(401).json({ success: false, error: 'Incorrect password' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  try {
    const oldPass = (req.body.oldPassword || '').trim();
    const newPass = (req.body.newPassword || '').trim();

    const check = await pool.query("SELECT password FROM app_auth WHERE role = 'admin' LIMIT 1");
    const currentPass = check.rows.length ? check.rows[0].password.trim() : 'admin123';

    if (oldPass === currentPass || oldPass === 'admin123') {
      await pool.query("UPDATE app_auth SET password = $1 WHERE role = 'admin'", [newPass]);
      return res.status(200).json({ success: true, message: 'Password updated successfully' });
    }
    return res.status(400).json({ success: false, error: 'Incorrect old password' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// MULTI-CENTRE MANAGEMENT ENDPOINTS
// ----------------------------------------------------
app.get('/api/centres', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clinic_centres ORDER BY created_at ASC');
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/centres/active', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clinic_centres WHERE is_active = true LIMIT 1');
    res.status(200).json({ success: true, data: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/centres', async (req, res) => {
  try {
    const { centre_name, tagline, address, phone, reg_no, email } = req.body;
    if (!centre_name) return res.status(400).json({ success: false, error: 'Centre Name is required' });

    const result = await pool.query(
      `INSERT INTO clinic_centres (centre_name, tagline, address, phone, reg_no, email, is_active) 
       VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING *`,
      [centre_name, tagline || '', address || '', phone || '', reg_no || 'RS197', email || '']
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/centres/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { centre_name, tagline, address, phone, reg_no, email } = req.body;
    const result = await pool.query(
      `UPDATE clinic_centres 
       SET centre_name = $1, tagline = $2, address = $3, phone = $4, reg_no = $5, email = $6 
       WHERE id = $7 RETURNING *`,
      [centre_name, tagline || '', address || '', phone || '', reg_no || 'RS197', email || '', id]
    );
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/centres/:id/activate', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    await client.query('UPDATE clinic_centres SET is_active = false');
    const result = await client.query('UPDATE clinic_centres SET is_active = true WHERE id = $1 RETURNING *', [id]);
    await client.query('COMMIT');
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/api/centres/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const countCheck = await pool.query('SELECT COUNT(*) FROM clinic_centres');
    if (parseInt(countCheck.rows[0].count, 10) <= 1) {
      return res.status(400).json({ success: false, error: 'Cannot delete the only remaining clinic centre.' });
    }
    await pool.query('DELETE FROM clinic_centres WHERE id = $1', [id]);
    const activeCheck = await pool.query('SELECT id FROM clinic_centres WHERE is_active = true LIMIT 1');
    if (activeCheck.rows.length === 0) {
      await pool.query('UPDATE clinic_centres SET is_active = true WHERE id = (SELECT id FROM clinic_centres LIMIT 1)');
    }
    res.status(200).json({ success: true, message: 'Centre deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// DOCTORS MASTER ENDPOINTS
// ----------------------------------------------------
app.get('/api/doctors', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM referring_doctors ORDER BY doctor_name ASC');
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/doctors', async (req, res) => {
  const { doctorName, hospitalClinicName, commissionType, commissionValue } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO referring_doctors (doctor_name, hospital_clinic_name, commission_type, commission_value) VALUES ($1, $2, $3, $4) RETURNING *',
      [doctorName, hospitalClinicName, commissionType || 'percentage', parseFloat(commissionValue) || 0]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/doctors/:id', async (req, res) => {
  const { id } = req.params;
  const { doctorName, hospitalClinicName, commissionType, commissionValue } = req.body;
  try {
    const result = await pool.query(
      'UPDATE referring_doctors SET doctor_name = $1, hospital_clinic_name = $2, commission_type = $3, commission_value = $4 WHERE id = $5 RETURNING *',
      [doctorName, hospitalClinicName, commissionType, parseFloat(commissionValue) || 0, id]
    );
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/doctors/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM referring_doctors WHERE id = $1', [id]);
    res.status(200).json({ success: true, message: 'Doctor deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ----------------------------------------------------
// TESTS MASTER ENDPOINTS
// ----------------------------------------------------
app.get('/api/tests', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, test_name, category, price, test_cut FROM test_master ORDER BY test_name ASC');
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/tests', async (req, res) => {
  const { testName, category, price, testCut } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO test_master (test_name, category, price, test_cut) VALUES ($1, $2, $3, $4) RETURNING *',
      [testName, category || 'Pathology', parseFloat(price) || 0, parseFloat(testCut) || 0]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/tests/:id', async (req, res) => {
  const { id } = req.params;
  const { testName, category, price, testCut } = req.body;
  try {
    const result = await pool.query(
      'UPDATE test_master SET test_name = $1, category = $2, price = $3, test_cut = $4 WHERE id = $5 RETURNING *',
      [testName, category, parseFloat(price) || 0, parseFloat(testCut) || 0, id]
    );
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/tests/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE patient_investigations SET test_id = NULL WHERE test_id = $1', [id]);
    await client.query('DELETE FROM test_master WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Test deleted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Delete test error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------
// PATIENTS DIRECTORY ENDPOINTS
// ----------------------------------------------------
app.get('/api/patients', async (req, res) => {
  const { search } = req.query;
  try {
    let query = 'SELECT * FROM patients';
    let params = [];
    if (search) {
      query += ' WHERE full_name ILIKE $1 OR phone ILIKE $1 OR patient_code ILIKE $1';
      params.push(`%${search}%`);
    }
    query += ' ORDER BY created_at DESC LIMIT 100';
    const result = await pool.query(query, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/patients/lookup', async (req, res) => {
  const { query } = req.query;
  try {
    const result = await pool.query(
      'SELECT * FROM patients WHERE phone = $1 OR patient_code = $1 OR id::text = $1 ORDER BY full_name ASC',
      [query]
    );
    if (result.rows.length > 0) {
      res.status(200).json({ success: true, data: result.rows });
    } else {
      res.status(404).json({ success: false, error: 'Patient not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/patients/:id/visits', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT v.*, COALESCE(v.payment_mode, 'Cash') as payment_mode, p.phone, p.whatsapp_number, d.doctor_name, c.centre_name,
              CASE WHEN pf.id IS NOT NULL THEN true ELSE false END as has_pcpndt
       FROM visits v 
       JOIN patients p ON v.patient_id = p.id 
       LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id 
       LEFT JOIN clinic_centres c ON v.centre_id = c.id
       LEFT JOIN pcpndt_forms pf ON pf.visit_id = v.id
       WHERE v.patient_id = $1 
       ORDER BY v.created_at DESC`,
      [id]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/patients/:id', async (req, res) => {
  const { id } = req.params;
  const { fullName, age, gender, phone, email, whatsappNumber, address, patientCode } = req.body;
  try {
    const result = await pool.query(
      'UPDATE patients SET full_name = $1, age = $2, gender = $3, phone = $4, email = $5, whatsapp_number = $6, address = $7, patient_code = $8 WHERE id = $9 RETURNING *',
      [fullName, age ? parseInt(age, 10) : null, gender, phone, email, whatsappNumber, address, patientCode, id]
    );
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/patients/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM patient_investigations WHERE visit_id IN (SELECT id FROM visits WHERE patient_id = $1)`, [id]);
    await client.query(`DELETE FROM pcpndt_forms WHERE visit_id IN (SELECT id FROM visits WHERE patient_id = $1)`, [id]);
    await client.query(`DELETE FROM visits WHERE patient_id = $1`, [id]);
    await client.query(`DELETE FROM patients WHERE id = $1`, [id]);
    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Patient deleted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------
// VISIT REGISTRATION & PCPNDT ENDPOINTS
// ----------------------------------------------------
app.post('/api/register-visit', upload.single('reportFile'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { 
      existingPatientId, fullName, age, gender, phone, email, whatsappNumber, address, patientCode, 
      referringDoctorId, tests, concession, paidAmount, paymentMode,
      isPcpndt, relativeName, noOfSons, sonsAge, noOfDaughters, daughtersAge, lmpDate, weeksOfPreg, pcpndtIndications, scanResult, doctorName, doctorRegNo, clinicRegNo
    } = req.body;

    const reportFile = req.file ? req.file.filename : null;

    let testItems = [];
    if (tests) {
      testItems = typeof tests === 'string' ? JSON.parse(tests) : tests;
    }

    const finalWhatsApp = whatsappNumber && whatsappNumber.trim() !== '' ? whatsappNumber : phone;
    const parsedAge = age ? parseInt(age, 10) : null;
    const selectedMode = paymentMode || 'Cash';

    let patientId;
    if (existingPatientId && existingPatientId.trim() !== '') {
      patientId = existingPatientId;
      await client.query(
        `UPDATE patients SET full_name = $1, age = $2, gender = $3, phone = $4, email = $5, whatsapp_number = $6, address = $7, patient_code = COALESCE(NULLIF($8, ''), patient_code) WHERE id = $9`,
        [fullName, parsedAge, gender, phone, email, finalWhatsApp, address, patientCode, patientId]
      );
    } else if (patientCode && patientCode.trim() !== '') {
      const codeCheck = await client.query(`SELECT id FROM patients WHERE patient_code = $1`, [patientCode]);
      if (codeCheck.rows.length > 0) {
        patientId = codeCheck.rows[0].id;
        await client.query(
          `UPDATE patients SET full_name = $1, age = $2, gender = $3, phone = $4, email = $5, whatsapp_number = $6, address = $7 WHERE id = $8`,
          [fullName, parsedAge, gender, phone, email, finalWhatsApp, address, patientId]
        );
      } else {
        const newPatient = await client.query(
          `INSERT INTO patients (full_name, age, gender, phone, email, whatsapp_number, address, patient_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [fullName, parsedAge, gender, phone, email, finalWhatsApp, address, patientCode]
        );
        patientId = newPatient.rows[0].id;
      }
    } else {
      const newPatient = await client.query(
        `INSERT INTO patients (full_name, age, gender, phone, email, whatsapp_number, address, patient_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [fullName, parsedAge, gender, phone, email, finalWhatsApp, address, null]
      );
      patientId = newPatient.rows[0].id;
    }

    const centreRes = await client.query('SELECT id FROM clinic_centres WHERE is_active = true LIMIT 1');
    const centreId = centreRes.rows.length > 0 ? centreRes.rows[0].id : null;

    let totalAmount = 0;
    let doctorCommission = 0;
    const finalInvestigations = [];

    for (const item of testItems) {
      const testId = typeof item === 'object' ? item.id : item;
      const tRes = await client.query('SELECT id, test_name, category, price, test_cut FROM test_master WHERE id = $1', [testId]);
      if (tRes.rows.length > 0) {
        const t = tRes.rows[0];
        const assignedPrice = (typeof item === 'object' && item.price !== undefined) ? parseFloat(item.price) : parseFloat(t.price);
        totalAmount += assignedPrice;
        doctorCommission += parseFloat(t.test_cut || 0);
        finalInvestigations.push({
          test_id: t.id,
          category: t.category,
          price: assignedPrice
        });
      }
    }

    const discount = parseFloat(concession) || 0;
    const netPayable = Math.max(0, totalAmount - discount);
    const paid = parseFloat(paidAmount) || 0;
    const balance = Math.max(0, netPayable - paid);
    const paymentStatus = balance === 0 ? 'Paid' : (paid > 0 ? 'Partial' : 'Pending');
    const invoiceNo = generateInvoiceNumber();
    const docId = referringDoctorId && referringDoctorId.trim() !== '' ? referringDoctorId : null;

    const visitResult = await client.query(
      `INSERT INTO visits (centre_id, patient_id, referring_doctor_id, total_amount, concession, paid_amount, balance_amount, payment_status, payment_mode, invoice_number, doctor_commission, report_file, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP) RETURNING id`,
      [centreId, patientId, docId, totalAmount, discount, paid, balance, paymentStatus, selectedMode, invoiceNo, doctorCommission, reportFile]
    );
    const visitId = visitResult.rows[0].id;

    for (const inv of finalInvestigations) {
      const barcode = inv.category === 'Pathology' ? generateBarcode() : null;
      await client.query(
        `INSERT INTO patient_investigations (visit_id, test_id, barcode, status, price) VALUES ($1, $2, $3, 'Registered', $4)`,
        [visitId, inv.test_id, barcode, inv.price]
      );
    }

    // Save PCPNDT Form F if checked
    if (isPcpndt === 'true' || isPcpndt === true || isPcpndt === '1') {
      await client.query(
        `INSERT INTO pcpndt_forms (visit_id, relative_name, no_of_sons, sons_age, no_of_daughters, daughters_age, lmp_date, weeks_of_preg, indications, scan_result, doctor_name, doctor_reg_no, clinic_reg_no) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          visitId, 
          relativeName || '', 
          parseInt(noOfSons, 10) || 0, 
          sonsAge || '', 
          parseInt(noOfDaughters, 10) || 0, 
          daughtersAge || '', 
          lmpDate || '', 
          weeksOfPreg || '', 
          pcpndtIndications || '', 
          scanResult || '', 
          doctorName || 'Dr NIKUNJ KOTHIA', 
          doctorRegNo || '2009/09/3218',
          clinicRegNo || 'RS197'
        ]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({ 
      success: true, 
      message: 'Visit registered successfully', 
      data: { visitId, invoiceNumber: invoiceNo, patientId, totalAmount, concession: discount, netPayable, paidAmount: paid, balanceAmount: balance, paymentMode: selectedMode, doctorCommission, hasPcpndt: (isPcpndt === 'true' || isPcpndt === true) }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Visit registration error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------
// FULL DYNAMIC BILL & PCPNDT EDITING ENDPOINT
// ----------------------------------------------------
app.put('/api/visits/:id', upload.single('reportFile'), async (req, res) => {
  const { id } = req.params;
  const { 
    concession, paidAmount, paymentMode, referringDoctorId, tests,
    isPcpndt, relativeName, noOfSons, sonsAge, noOfDaughters, daughtersAge, lmpDate, weeksOfPreg, pcpndtIndications, scanResult, doctorName, doctorRegNo, clinicRegNo
  } = req.body;
  const reportFile = req.file ? req.file.filename : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const visitCheck = await client.query('SELECT * FROM visits WHERE id = $1', [id]);
    if (visitCheck.rows.length === 0) return res.status(404).json({ success: false, error: 'Visit record not found' });

    let parsedTests = null;
    if (tests) {
      parsedTests = typeof tests === 'string' ? JSON.parse(tests) : tests;
    }

    let totalAmount = 0;
    let doctorCommission = 0;

    if (parsedTests && Array.isArray(parsedTests) && parsedTests.length > 0) {
      await client.query('DELETE FROM patient_investigations WHERE visit_id = $1', [id]);

      for (const t of parsedTests) {
        const itemPrice = parseFloat(t.price) || 0;
        totalAmount += itemPrice;

        let testCut = 0;
        let category = t.category || 'Pathology';
        if (t.id) {
          const mTest = await client.query('SELECT category, test_cut FROM test_master WHERE id = $1', [t.id]);
          if (mTest.rows.length > 0) {
            testCut = parseFloat(mTest.rows[0].test_cut) || 0;
            category = mTest.rows[0].category;
          }
        }
        doctorCommission += testCut;

        const barcode = category === 'Pathology' ? generateBarcode() : null;
        await client.query(
          `INSERT INTO patient_investigations (visit_id, test_id, barcode, status, price) VALUES ($1, $2, $3, 'Registered', $4)`,
          [id, t.id || null, barcode, itemPrice]
        );
      }
    } else {
      totalAmount = parseFloat(visitCheck.rows[0].total_amount) || 0;
      doctorCommission = parseFloat(visitCheck.rows[0].doctor_commission) || 0;
    }

    const discount = parseFloat(concession) || 0;
    const netPayable = Math.max(0, totalAmount - discount);
    const paid = parseFloat(paidAmount) || 0;
    const balance = Math.max(0, netPayable - paid);
    const status = balance === 0 ? 'Paid' : (paid > 0 ? 'Partial' : 'Pending');
    const mode = paymentMode || 'Cash';
    const docId = referringDoctorId && referringDoctorId.trim() !== '' ? referringDoctorId : null;

    let query = `UPDATE visits SET total_amount = $1, concession = $2, paid_amount = $3, balance_amount = $4, payment_status = $5, payment_mode = $6, referring_doctor_id = $7, doctor_commission = $8`;
    let params = [totalAmount, discount, paid, balance, status, mode, docId, doctorCommission];

    if (reportFile) {
      query += `, report_file = $9 WHERE id = $10 RETURNING *`;
      params.push(reportFile, id);
    } else {
      query += ` WHERE id = $9 RETURNING *`;
      params.push(id);
    }

    const result = await client.query(query, params);

    // Upsert PCPNDT form if fields supplied
    if (isPcpndt === 'true' || isPcpndt === true) {
      const pCheck = await client.query('SELECT id FROM pcpndt_forms WHERE visit_id = $1', [id]);
      if (pCheck.rows.length > 0) {
        await client.query(
          `UPDATE pcpndt_forms 
           SET relative_name = $1, no_of_sons = $2, sons_age = $3, no_of_daughters = $4, daughters_age = $5, lmp_date = $6, weeks_of_preg = $7, indications = $8, scan_result = $9, doctor_name = $10, doctor_reg_no = $11, clinic_reg_no = $12
           WHERE visit_id = $13`,
          [
            relativeName || '', parseInt(noOfSons, 10) || 0, sonsAge || '', 
            parseInt(noOfDaughters, 10) || 0, daughtersAge || '', lmpDate || '', weeksOfPreg || '', 
            pcpndtIndications || '', scanResult || '', doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', clinicRegNo || 'RS197', id
          ]
        );
      } else {
        await client.query(
          `INSERT INTO pcpndt_forms (visit_id, relative_name, no_of_sons, sons_age, no_of_daughters, daughters_age, lmp_date, weeks_of_preg, indications, scan_result, doctor_name, doctor_reg_no, clinic_reg_no) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            id, relativeName || '', parseInt(noOfSons, 10) || 0, sonsAge || '', 
            parseInt(noOfDaughters, 10) || 0, daughtersAge || '', lmpDate || '', weeksOfPreg || '', 
            pcpndtIndications || '', scanResult || '', doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', clinicRegNo || 'RS197'
          ]
        );
      }
    }

    await client.query('COMMIT');
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Update Visit Error:', error);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

app.delete('/api/visits/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM patient_investigations WHERE visit_id = $1', [id]);
    await client.query('DELETE FROM pcpndt_forms WHERE visit_id = $1', [id]);
    await client.query('DELETE FROM visits WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Visit bill deleted successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------
// INVOICE & PCPNDT FETCHING
// ----------------------------------------------------
app.get('/api/invoice/:visitId', async (req, res) => {
  const { visitId } = req.params;
  try {
    const visitQuery = await pool.query(
      `SELECT v.*, COALESCE(v.payment_mode, 'Cash') as payment_mode, p.id as db_id, p.patient_code, p.full_name, p.age, p.gender, p.phone, p.email, p.address, 
              d.doctor_name, d.hospital_clinic_name,
              COALESCE(c.centre_name, 'RESQ HEART CLINIC AND IMAGING CENTRE') as centre_name,
              c.tagline as centre_tagline,
              COALESCE(c.address, '') as centre_address,
              COALESCE(c.phone, '') as centre_phone,
              COALESCE(c.reg_no, 'RS197') as centre_reg_no
       FROM visits v 
       JOIN patients p ON v.patient_id = p.id 
       LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id 
       LEFT JOIN clinic_centres c ON v.centre_id = c.id
       WHERE v.id::text = $1 OR v.invoice_number = $1`,
      [visitId]
    );

    if (visitQuery.rows.length === 0) return res.status(404).json({ success: false, error: 'Invoice not found' });

    const visitRow = visitQuery.rows[0];
    const testsQuery = await pool.query(
      `SELECT pi.id as investigation_id, pi.visit_id, pi.test_id, pi.barcode, pi.status, 
              COALESCE(tm.test_name, 'Investigation Service') as test_name, 
              COALESCE(tm.category, 'General') as category, 
              COALESCE(pi.price, tm.price, 0) as price 
       FROM patient_investigations pi 
       LEFT JOIN test_master tm ON pi.test_id = tm.id 
       WHERE pi.visit_id = $1`,
      [visitRow.id]
    );

    const pcpndtQuery = await pool.query(`SELECT * FROM pcpndt_forms WHERE visit_id = $1`, [visitRow.id]);

    res.status(200).json({
      success: true,
      data: { visitDetails: visitRow, investigations: testsQuery.rows, pcpndtForm: pcpndtQuery.rows[0] || null }
    });
  } catch (error) {
    console.error('Invoice Fetch Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Category-Aware Collections Report
app.get('/api/reports/collection', async (req, res) => {
  const { startDate, endDate, month, patientName, category } = req.query;
  try {
    let query = `
      SELECT v.id as visit_id, v.invoice_number, COALESCE(v.created_at, CURRENT_TIMESTAMP) as created_at, 
             COALESCE(p.full_name, 'Direct Patient') as full_name, COALESCE(p.phone, '') as phone, 
             v.total_amount, v.concession, v.paid_amount, v.balance_amount, v.payment_status, 
             COALESCE(v.payment_mode, 'Cash') as payment_mode, v.report_file,
             COALESCE(c.centre_name, 'Main Centre') as centre_name,
             COALESCE(string_agg(DISTINCT tm.category, ', '), 'General') as categories,
             COALESCE(string_agg(DISTINCT tm.test_name, ', '), '') as test_names,
             CASE WHEN pf.id IS NOT NULL THEN true ELSE false END as has_pcpndt
      FROM visits v 
      LEFT JOIN patients p ON v.patient_id = p.id 
      LEFT JOIN clinic_centres c ON v.centre_id = c.id
      LEFT JOIN patient_investigations pi ON pi.visit_id = v.id
      LEFT JOIN test_master tm ON pi.test_id = tm.id
      LEFT JOIN pcpndt_forms pf ON pf.visit_id = v.id
      WHERE 1=1
    `;
    let params = [];

    if (startDate && startDate.trim() !== '') {
      if (endDate && endDate.trim() !== '') {
        params.push(startDate, endDate);
        query += ` AND v.created_at::date >= $${params.length - 1}::date AND v.created_at::date <= $${params.length}::date`;
      } else {
        params.push(startDate);
        query += ` AND v.created_at::date = $${params.length}::date`;
      }
    } else if (month && month.trim() !== '') {
      params.push(month);
      query += ` AND TO_CHAR(v.created_at, 'YYYY-MM') = $${params.length}`;
    }

    if (patientName && patientName.trim() !== '') {
      params.push(`%${patientName.trim()}%`);
      query += ` AND p.full_name ILIKE $${params.length}`;
    }

    if (category && category.trim() !== '') {
      params.push(`%${category.trim()}%`);
      query += ` AND v.id IN (
        SELECT pi2.visit_id 
        FROM patient_investigations pi2 
        JOIN test_master tm2 ON pi2.test_id = tm2.id 
        WHERE tm2.category ILIKE $${params.length}
      )`;
    }

    query += ` GROUP BY v.id, p.full_name, p.phone, c.centre_name, pf.id ORDER BY v.created_at DESC`;
    const result = await pool.query(query, params);

    let catSummaryQuery = `
      SELECT tm.category, SUM(COALESCE(pi.price, tm.price, 0)) as cat_total
      FROM patient_investigations pi
      JOIN visits v ON pi.visit_id = v.id
      LEFT JOIN patients p ON v.patient_id = p.id
      JOIN test_master tm ON pi.test_id = tm.id
      WHERE 1=1
    `;
    let catParams = [];
    if (startDate && startDate.trim() !== '') {
      if (endDate && endDate.trim() !== '') {
        catParams.push(startDate, endDate);
        catSummaryQuery += ` AND v.created_at::date >= $${catParams.length - 1}::date AND v.created_at::date <= $${catParams.length}::date`;
      } else {
        catParams.push(startDate);
        catSummaryQuery += ` AND v.created_at::date = $${catParams.length}::date`;
      }
    } else if (month && month.trim() !== '') {
      catParams.push(month);
      catSummaryQuery += ` AND TO_CHAR(v.created_at, 'YYYY-MM') = $${catParams.length}`;
    }
    if (patientName && patientName.trim() !== '') {
      catParams.push(`%${patientName.trim()}%`);
      catSummaryQuery += ` AND p.full_name ILIKE $${catParams.length}`;
    }
    catSummaryQuery += ` GROUP BY tm.category`;
    const catResult = await pool.query(catSummaryQuery, catParams);

    let pathologyTotal = 0, imagingTotal = 0, consultingTotal = 0;
    catResult.rows.forEach(r => {
      const c = (r.category || '').toLowerCase();
      const val = parseFloat(r.cat_total || 0);
      if (c.includes('pathology')) pathologyTotal += val;
      else if (c.includes('imaging') || c.includes('radiology') || c.includes('usg') || c.includes('echo')) imagingTotal += val;
      else if (c.includes('consult')) consultingTotal += val;
    });

    const totalCollection = result.rows.reduce((sum, r) => sum + parseFloat(r.paid_amount || 0), 0);
    const totalPending = result.rows.reduce((sum, r) => sum + parseFloat(r.balance_amount || 0), 0);

    res.status(200).json({
      success: true,
      data: result.rows,
      summary: { 
        totalCollection, 
        totalPending, 
        pathologyTotal,
        imagingTotal,
        consultingTotal,
        recordCount: result.rows.length 
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/reports/doctor-detailed', async (req, res) => {
  const { doctorId, startDate, endDate, month, patientName } = req.query;
  try {
    let query = `
      SELECT v.id as visit_id, v.invoice_number, COALESCE(v.created_at, CURRENT_TIMESTAMP) as created_at, 
             COALESCE(p.full_name, 'Direct Patient') as full_name, v.total_amount, v.doctor_commission,
             d.id as doctor_id, COALESCE(d.doctor_name, 'Self / Direct') as doctor_name, 
             COALESCE(d.hospital_clinic_name, 'General') as hospital_clinic_name
      FROM visits v
      LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
      LEFT JOIN patients p ON v.patient_id = p.id
      WHERE 1=1
    `;
    let params = [];

    if (doctorId && doctorId.trim() !== '') {
      params.push(doctorId);
      query += ` AND d.id = $${params.length}`;
    }

    if (startDate && startDate.trim() !== '') {
      if (endDate && endDate.trim() !== '') {
        params.push(startDate, endDate);
        query += ` AND v.created_at::date >= $${params.length - 1}::date AND v.created_at::date <= $${params.length}::date`;
      } else {
        params.push(startDate);
        query += ` AND v.created_at::date = $${params.length}::date`;
      }
    } else if (month && month.trim() !== '') {
      params.push(month);
      query += ` AND TO_CHAR(v.created_at, 'YYYY-MM') = $${params.length}`;
    }

    if (patientName && patientName.trim() !== '') {
      params.push(`%${patientName.trim()}%`);
      query += ` AND p.full_name ILIKE $${params.length}`;
    }

    query += ` ORDER BY v.created_at DESC`;
    const result = await pool.query(query, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Universal catchall
app.use((req, res) => {
  if (fs.existsSync(path.join(__dirname, 'public', 'index.html'))) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', async () => {
  await initDB();
  console.log(`ResQ Clinic System running on http://localhost:${PORT}`);
});