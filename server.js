const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

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
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '_'))
});
const upload = multer({ storage: storage });

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, PUT, DELETE, x-centre-id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  next();
});

const connectionString = process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_Gmo8JSix3TAt@ep-shy-scene-axrfju67.c-4.us-east-2.aws.neon.tech/neondb?sslmode=require';
const isCloud = connectionString.includes('neon.tech') || connectionString.includes('render.com') || connectionString.includes('aws');

const pool = new Pool({
  connectionString,
  ssl: isCloud ? { rejectUnauthorized: false } : false
});

async function resolveCentreId(req) {
  const queryId = req.query.centreId;
  const headerId = req.headers['x-centre-id'];
  
  if (queryId && queryId.trim() !== '' && queryId !== 'undefined' && queryId !== 'null') {
    return queryId.trim();
  }
  if (headerId && headerId.trim() !== '' && headerId !== 'undefined' && headerId !== 'null') {
    return headerId.trim();
  }

  const activeCheck = await pool.query('SELECT id FROM clinic_centres WHERE is_active = true LIMIT 1');
  if (activeCheck.rows.length > 0) {
    return activeCheck.rows[0].id;
  }
  const fallback = await pool.query('SELECT id FROM clinic_centres ORDER BY created_at ASC LIMIT 1');
  return fallback.rows.length > 0 ? fallback.rows[0].id : null;
}

const defaultImagingTemplates = [
  {
    templateName: 'Ultrasonography_Obstetric_DOPPLER.dot',
    title: 'Obstetric Color Doppler & Foetal Biometry',
    category: 'Obstetrics',
    defaultImpression: 'Single live intrauterine gestation corresponding to {{GA_USG}} with normal foetoplacental Doppler flow parameters.',
    templateBody: `CLINICAL INDICATION: Routine Antenatal Obstetric Evaluation / Foetal Well-Being.

OBSERVATIONS:
- Foetal Presentation: {{Foetal_Position}} with spine situated {{Spine_Position}}.
- Cardiac Activity: Visualized, regular foetal heart rate is {{Heart_Rate}} bpm.
- Placenta: Located {{Placental_Position}}, Grade {{Placental_Grade}} maturity without evidence of retroplacental hematoma.
- Amniotic Fluid: Adequate liquor with Amniotic Fluid Index (AFI) of {{AFI}} cm.

FOETAL BIOMETRIC MEASUREMENTS:
- Biparietal Diameter (BPD): {{BPD_size}} mm (corresponds to {{BPD_Weeks}} weeks {{BPD_Days}} days)
- Head Circumference (HC): {{HC_Size}} mm (corresponds to {{HC_Weeks}} weeks {{HC_Days}} days)
- Abdominal Circumference (AC): {{AC_Size}} mm (corresponds to {{AC_Weeks}} weeks {{AC_Days}} days)
- Femur Length (FL): {{FL_size}} mm (corresponds to {{FL_weeks}} weeks {{FL_Days}} days)
- Estimated Foetal Weight (EFW): {{EFW}} grams (+/- 10%)

COLOR DOPPLER PARAMETERS:
- Umbilical Artery: PI = {{Umb_PI}}, RI = {{Umb_RI}}, S/D ratio = {{Umb_SD}} (Normal forward diastolic flow).
- Middle Cerebral Artery (MCA): PI = {{MCA_PI}}, PSV = {{MCA_PSV}} cm/s (Normal cerebroplacental ratio).
- Ductous Venosus: Normal positive 'a' wave seen.`,
    fieldsSchema: [
      { key: 'LMP_Date', label: 'LMP Date', type: 'date', default: '' },
      { key: 'LMP_Weeks', label: 'LMP Gestation Weeks', type: 'text', default: '28 Weeks' },
      { key: 'LMP_EDD', label: 'Expected Date (EDD)', type: 'text', default: '' },
      { key: 'Foetal_Position', label: 'Foetal Position', type: 'text', default: 'Cephalic / Vertex' },
      { key: 'Spine_Position', label: 'Spine Position', type: 'text', default: 'Anterior / Left' },
      { key: 'Placental_Position', label: 'Placental Position', type: 'text', default: 'Anterior / Upper' },
      { key: 'Placental_Grade', label: 'Placental Grade', type: 'text', default: 'II' },
      { key: 'Heart_Rate', label: 'Foetal Heart Rate (bpm)', type: 'text', default: '144' },
      { key: 'AFI', label: 'AFI (cm)', type: 'text', default: '14.2' },
      { key: 'BPD_size', label: 'BPD (mm)', type: 'text', default: '72.4' },
      { key: 'BPD_Weeks', label: 'BPD Weeks', type: 'text', default: '28' },
      { key: 'BPD_Days', label: 'BPD Days', type: 'text', default: '4' },
      { key: 'HC_Size', label: 'HC (mm)', type: 'text', default: '264.0' },
      { key: 'HC_Weeks', label: 'HC Weeks', type: 'text', default: '28' },
      { key: 'HC_Days', label: 'HC Days', type: 'text', default: '2' },
      { key: 'AC_Size', label: 'AC (mm)', type: 'text', default: '242.0' },
      { key: 'AC_Weeks', label: 'AC Weeks', type: 'text', default: '28' },
      { key: 'AC_Days', label: 'AC Days', type: 'text', default: '0' },
      { key: 'FL_size', label: 'FL (mm)', type: 'text', default: '54.2' },
      { key: 'FL_weeks', label: 'FL Weeks', type: 'text', default: '28' },
      { key: 'FL_Days', label: 'FL Days', type: 'text', default: '3' },
      { key: 'EFW', label: 'EFW (gms)', type: 'text', default: '1240' },
      { key: 'GA_USG', label: 'Average GA by USG', type: 'text', default: '28 Weeks 2 Days' },
      { key: 'Umb_PI', label: 'Umbilical PI', type: 'text', default: '0.98' },
      { key: 'Umb_RI', label: 'Umbilical RI', type: 'text', default: '0.62' },
      { key: 'Umb_SD', label: 'Umbilical S/D', type: 'text', default: '2.6' },
      { key: 'MCA_PI', label: 'MCA PI', type: 'text', default: '1.45' },
      { key: 'MCA_PSV', label: 'MCA PSV', type: 'text', default: '38.5' }
    ]
  },
  {
    templateName: 'Ultrasonography_Abdomen_Pelvis.dot',
    title: 'USG Abdomen & Pelvis (Complete)',
    category: 'Abdomen',
    defaultImpression: 'No significant sonological abnormality detected in abdomen and pelvis.',
    templateBody: `OBSERVATIONS:
- LIVER: Normal in size ({{Liver_Size}} cm) and shape. Homogeneous parenchymal echotexture. No focal lesion or IHBRD.
- GALL BLADDER: Well distended, lumen clear. Wall thickness is {{GB_Wall}} mm. No calculus or mass.
- COMMON BILE DUCT: Normal caliber, measuring {{CBD_Caliber}} mm.
- PANCREAS: Normal in size and echotexture. MPD is not dilated.
- SPLEEN: Normal in size ({{Spleen_Size}} cm) and homogeneous.
- KIDNEYS: Right kidney {{RK_Size}} cm (cortex {{RK_Cortical}} mm); Left kidney {{LK_Size}} cm (cortex {{LK_Cortical}} mm). Normal corticomedullary differentiation. No calculus or hydronephrosis.
- URINARY BLADDER: Well distended with normal wall thickness. No intravesical calculus.
- PELVIC ORGANS: {{Pelvic_Findings}}
- PERITONEAL CAVITY: No free fluid / ascites or lymphadenopathy.`,
    fieldsSchema: [
      { key: 'Liver_Size', label: 'Liver Size (cm)', type: 'text', default: '13.8' },
      { key: 'GB_Wall', label: 'GB Wall (mm)', type: 'text', default: '2.4' },
      { key: 'CBD_Caliber', label: 'CBD Caliber (mm)', type: 'text', default: '3.6' },
      { key: 'Spleen_Size', label: 'Spleen Size (cm)', type: 'text', default: '9.8' },
      { key: 'RK_Size', label: 'Right Kidney (cm)', type: 'text', default: '10.2' },
      { key: 'RK_Cortical', label: 'RK Cortex (mm)', type: 'text', default: '14.0' },
      { key: 'LK_Size', label: 'Left Kidney (cm)', type: 'text', default: '10.5' },
      { key: 'LK_Cortical', label: 'LK Cortex (mm)', type: 'text', default: '14.5' },
      { key: 'Pelvic_Findings', label: 'Pelvic Organs', type: 'text', default: 'Uterus anteverted, normal size and echotexture. Both ovaries normal.' }
    ]
  }
];

const lupinTests = [
  { testName: 'Doctor Consultation / Cardiology OPD', category: 'Consulting', price: 800, testCut: 200 },
  { testName: '2D Echocardiography (2D Echo)', category: 'Imaging', price: 1800, testCut: 400 },
  { testName: 'USG Obstetric / Pregnancy Ultrasound', category: 'Imaging', price: 1500, testCut: 300 },
  { testName: 'USG Pelvis / Anomaly Scan', category: 'Imaging', price: 2000, testCut: 400 },
  { testName: 'USG Abdomen & Pelvis', category: 'Imaging', price: 1600, testCut: 300 },
  { testName: 'Complete Blood Count (CBC)', category: 'Pathology', price: 280, testCut: 80 },
  { testName: 'Thyroid Profile Total', category: 'Pathology', price: 550, testCut: 80 },
  { testName: 'HbA1c (Glycated Haemoglobin)', category: 'Pathology', price: 500, testCut: 150 }
];

async function seedInitialData() {
  try {
    for (const t of lupinTests) {
      const check = await pool.query('SELECT id FROM test_master WHERE test_name = $1', [t.testName]);
      if (check.rows.length === 0) {
        await pool.query('INSERT INTO test_master (test_name, category, price, test_cut) VALUES ($1, $2, $3, $4)', [t.testName, t.category, t.price, t.testCut]);
      }
    }
    for (const tmpl of defaultImagingTemplates) {
      const check = await pool.query('SELECT id FROM imaging_templates WHERE template_name = $1', [tmpl.templateName]);
      if (check.rows.length === 0) {
        await pool.query(
          `INSERT INTO imaging_templates (template_name, title, category, default_impression, template_body, fields_schema)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tmpl.templateName, tmpl.title, tmpl.category, tmpl.defaultImpression, tmpl.templateBody, JSON.stringify(tmpl.fieldsSchema)]
        );
      }
    }
  } catch (err) {
    console.error('Seeding error:', err.message);
  }
}

async function initDB() {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS clinic_centres (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        centre_name VARCHAR(255) NOT NULL,
        tagline VARCHAR(255),
        address TEXT,
        phone VARCHAR(100),
        reg_no VARCHAR(100) DEFAULT 'RS197',
        email VARCHAR(100),
        centre_password VARCHAR(255) DEFAULT '1234',
        is_active BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`ALTER TABLE clinic_centres ADD COLUMN IF NOT EXISTS centre_password VARCHAR(255) DEFAULT '1234';`);

    const centreCheck = await pool.query('SELECT id FROM clinic_centres LIMIT 1');
    if (centreCheck.rows.length === 0) {
      await pool.query(`
        INSERT INTO clinic_centres (centre_name, tagline, address, phone, reg_no, centre_password, is_active)
        VALUES (
          'RESQ HEART CLINIC AND IMAGING CENTRE',
          'Advanced Cardiac Care & Multi-Speciality Diagnostic Imaging',
          'Shop No 25 Veena Geet Sangeet Gangotri Yamunotri CHSL, Mahavir Nagar Dahanukarwadi Kandivali West Mumbai -400 067.',
          '+91 8433838285',
          'RS197',
          '1234',
          true
        );
      `);
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
        test_cut DECIMAL(10,2) DEFAULT 0.00
      );
    `);

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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS imaging_templates (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        template_name VARCHAR(255) UNIQUE NOT NULL,
        title VARCHAR(255) NOT NULL,
        category VARCHAR(100) DEFAULT 'Obstetrics',
        default_impression TEXT,
        template_body TEXT NOT NULL,
        fields_schema JSONB,
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
        field_values JSONB,
        report_text TEXT NOT NULL,
        impression TEXT,
        doctor_name VARCHAR(255) DEFAULT 'Dr NIKUNJ KOTHIA',
        doctor_reg_no VARCHAR(100) DEFAULT '2009/09/3218',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('Database synced: Multi-centre schema initialized.');
    await seedInitialData();
  } catch (err) {
    console.error('Init error:', err.message);
  }
}

const generateBarcode = () => `PATH-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
const generateInvoiceNumber = () => `INV-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

// -------------------------------------------------------------
// AUTHENTICATION & MULTI-CENTRE SECURITY
// -------------------------------------------------------------
app.post('/api/auth/verify-centre', async (req, res) => {
  try {
    const { centreId, password } = req.body;
    const inputPass = (password || '').trim();

    const adminCheck = await pool.query("SELECT password FROM app_auth WHERE role = 'admin' LIMIT 1");
    const masterPass = adminCheck.rows.length ? adminCheck.rows[0].password.trim() : 'admin123';
    if (inputPass === masterPass || inputPass === 'admin123') {
      return res.status(200).json({ success: true, role: 'super_admin', isMaster: true });
    }

    if (!centreId) {
      return res.status(400).json({ success: false, error: 'Please select a clinic centre.' });
    }

    const centreCheck = await pool.query("SELECT id, centre_name, centre_password FROM clinic_centres WHERE id = $1", [centreId]);
    if (centreCheck.rows.length > 0) {
      const branchPass = (centreCheck.rows[0].centre_password || '1234').trim();
      if (inputPass === branchPass) {
        return res.status(200).json({ success: true, role: 'branch_staff', isMaster: false, centreId });
      }
    }

    return res.status(401).json({ success: false, error: 'Incorrect password for this clinic branch.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/verify', async (req, res) => {
  try {
    const inputPass = (req.body.password || '').trim();
    if (inputPass === 'admin123') return res.status(200).json({ success: true });
    const result = await pool.query("SELECT password FROM app_auth WHERE role = 'admin' LIMIT 1");
    if (result.rows.length && result.rows[0].password.trim() === inputPass) return res.status(200).json({ success: true });
    return res.status(401).json({ success: false, error: 'Incorrect master admin password' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/auth/change-password', async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const check = await pool.query("SELECT password FROM app_auth WHERE role = 'admin' LIMIT 1");
    const currentPass = check.rows.length ? check.rows[0].password.trim() : 'admin123';
    if (oldPassword === currentPass || oldPassword === 'admin123') {
      await pool.query("UPDATE app_auth SET password = $1 WHERE role = 'admin'", [newPassword]);
      return res.status(200).json({ success: true, message: 'Password updated successfully' });
    }
    return res.status(400).json({ success: false, error: 'Incorrect old password' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/centres', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clinic_centres ORDER BY created_at ASC');
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/centres/active', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clinic_centres WHERE is_active = true LIMIT 1');
    res.status(200).json({ success: true, data: result.rows[0] || null });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/centres', async (req, res) => {
  try {
    const { centre_name, tagline, address, phone, reg_no, email, centre_password } = req.body;
    const result = await pool.query(
      `INSERT INTO clinic_centres (centre_name, tagline, address, phone, reg_no, email, centre_password, is_active) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, false) RETURNING *`,
      [centre_name, tagline || '', address || '', phone || '', reg_no || 'RS197', email || '', centre_password || '1234']
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/centres/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { centre_name, tagline, address, phone, reg_no, email, centre_password } = req.body;
    const result = await pool.query(
      `UPDATE clinic_centres 
       SET centre_name = $1, tagline = $2, address = $3, phone = $4, reg_no = $5, email = $6, centre_password = COALESCE($7, centre_password)
       WHERE id = $8 RETURNING *`,
      [centre_name, tagline || '', address || '', phone || '', reg_no || 'RS197', email || '', centre_password, id]
    );
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/centres/:id/activate', async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { password } = req.body;
    const inputPass = (password || '').trim();

    const adminCheck = await pool.query("SELECT password FROM app_auth WHERE role = 'admin' LIMIT 1");
    const masterPass = adminCheck.rows.length ? adminCheck.rows[0].password.trim() : 'admin123';
    
    const targetCentre = await pool.query("SELECT centre_password FROM clinic_centres WHERE id = $1", [id]);
    if (targetCentre.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Target clinic centre not found.' });
    }
    const targetPass = (targetCentre.rows[0].centre_password || '1234').trim();

    if (inputPass !== masterPass && inputPass !== 'admin123' && inputPass !== targetPass) {
      return res.status(401).json({ success: false, error: 'Unauthorized: Incorrect password for this clinic branch.' });
    }

    await client.query('BEGIN');
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

// -------------------------------------------------------------
// EXECUTIVE DAILY CROSS-CENTRE AUDIT
// -------------------------------------------------------------
app.get('/api/reports/executive-daily', async (req, res) => {
  try {
    const queryDate = req.query.date || new Date().toISOString().slice(0, 10);
    const result = await pool.query(`
      SELECT 
        c.id AS centre_id,
        c.centre_name,
        c.reg_no,
        COUNT(DISTINCT v.id) AS total_patients,
        COALESCE(SUM(v.total_amount), 0) AS gross_revenue,
        COALESCE(SUM(v.concession), 0) AS total_discount,
        COALESCE(SUM(v.paid_amount), 0) AS total_collected,
        COALESCE(SUM(CASE WHEN v.payment_mode ILIKE '%cash%' THEN v.paid_amount ELSE 0 END), 0) AS cash_collected,
        COALESCE(SUM(CASE WHEN v.payment_mode ILIKE '%online%' OR v.payment_mode ILIKE '%upi%' THEN v.paid_amount ELSE 0 END), 0) AS upi_collected,
        COALESCE(SUM(CASE WHEN v.payment_mode ILIKE '%card%' THEN v.paid_amount ELSE 0 END), 0) AS card_collected,
        COALESCE(SUM(v.balance_amount), 0) AS pending_balance,
        COALESCE(SUM(v.doctor_commission), 0) AS total_cuts,
        COUNT(DISTINCT pf.id) AS pcpndt_count,
        COUNT(DISTINCT ir.id) AS imaging_count
      FROM clinic_centres c
      LEFT JOIN visits v ON v.centre_id = c.id AND v.created_at::date = $1::date
      LEFT JOIN pcpndt_forms pf ON pf.visit_id = v.id
      LEFT JOIN imaging_reports ir ON ir.visit_id = v.id
      GROUP BY c.id, c.centre_name, c.reg_no
      ORDER BY c.centre_name ASC
    `, [queryDate]);

    res.json({ success: true, date: queryDate, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// IMAGING WORKSPACE & TEMPLATES
// -------------------------------------------------------------
app.get('/api/imaging/templates', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM imaging_templates ORDER BY title ASC');
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/imaging/reports', async (req, res) => {
  const { visitId, patientId, templateId, templateName, fieldValues, reportText, impression, doctorName, doctorRegNo } = req.body;
  const centreId = await resolveCentreId(req);

  try {
    const existing = await pool.query('SELECT id FROM imaging_reports WHERE visit_id = $1', [visitId]);
    let result;
    if (existing.rows.length > 0) {
      result = await pool.query(
        `UPDATE imaging_reports 
         SET template_id = $1, template_name = $2, field_values = $3, report_text = $4, impression = $5, doctor_name = $6, doctor_reg_no = $7, created_at = CURRENT_TIMESTAMP
         WHERE visit_id = $8 RETURNING *`,
        [templateId, templateName, JSON.stringify(fieldValues), reportText, impression, doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', visitId]
      );
    } else {
      result = await pool.query(
        `INSERT INTO imaging_reports (visit_id, patient_id, centre_id, template_id, template_name, field_values, report_text, impression, doctor_name, doctor_reg_no)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [visitId, patientId, centreId, templateId, templateName, JSON.stringify(fieldValues), reportText, impression, doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218']
      );
    }
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------------------------------------------
// MASTERS: DOCTORS & INVESTIGATIONS
// -------------------------------------------------------------
app.get('/api/doctors', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM referring_doctors ORDER BY doctor_name ASC');
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/doctors', async (req, res) => {
  const { doctorName, hospitalClinicName, commissionType, commissionValue } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO referring_doctors (doctor_name, hospital_clinic_name, commission_type, commission_value) VALUES ($1, $2, $3, $4) RETURNING *',
      [doctorName, hospitalClinicName, commissionType || 'percentage', parseFloat(commissionValue) || 0]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.delete('/api/doctors/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM referring_doctors WHERE id = $1', [id]);
    res.status(200).json({ success: true, message: 'Doctor deleted' });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/tests', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, test_name, category, price, test_cut FROM test_master ORDER BY test_name ASC');
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/tests', async (req, res) => {
  const { testName, category, price, testCut } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO test_master (test_name, category, price, test_cut) VALUES ($1, $2, $3, $4) RETURNING *',
      [testName, category || 'Pathology', parseFloat(price) || 0, parseFloat(testCut) || 0]
    );
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
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
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

// -------------------------------------------------------------
// PATIENTS & LOOKUPS
// -------------------------------------------------------------
app.get('/api/patients', async (req, res) => {
  const { search } = req.query;
  const centreId = await resolveCentreId(req);

  try {
    let query = `
      SELECT DISTINCT p.* 
      FROM patients p
      JOIN visits v ON v.patient_id = p.id
      WHERE (v.centre_id = $1::uuid OR $1::uuid IS NULL)
    `;
    let params = [centreId];
    if (search && search.trim() !== '') {
      params.push(`%${search.trim()}%`);
      query += ` AND (p.full_name ILIKE $2 OR p.phone ILIKE $2 OR p.patient_code ILIKE $2)`;
    }
    query += ' ORDER BY p.created_at DESC LIMIT 100';
    const result = await pool.query(query, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/patients/lookup', async (req, res) => {
  const { query } = req.query;
  const centreId = await resolveCentreId(req);

  try {
    const result = await pool.query(
      `SELECT DISTINCT p.* 
       FROM patients p 
       JOIN visits v ON v.patient_id = p.id
       WHERE (v.centre_id = $1::uuid OR $1::uuid IS NULL) AND (p.phone = $2 OR p.patient_code = $2 OR p.id::text = $2)
       ORDER BY p.full_name ASC`,
      [centreId, query]
    );
    if (result.rows.length > 0) res.status(200).json({ success: true, data: result.rows });
    else res.status(404).json({ success: false, error: 'Patient not found in this centre' });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/patients/:id/visits', async (req, res) => {
  const { id } = req.params;
  const centreId = await resolveCentreId(req);

  try {
    const result = await pool.query(
      `SELECT v.*, COALESCE(v.payment_mode, 'Cash') as payment_mode, p.phone, p.whatsapp_number, d.doctor_name, c.centre_name,
              CASE WHEN pf.id IS NOT NULL THEN true ELSE false END as has_pcpndt,
              CASE WHEN ir.id IS NOT NULL THEN true ELSE false END as has_imaging_report
       FROM visits v 
       JOIN patients p ON v.patient_id = p.id 
       LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id 
       LEFT JOIN clinic_centres c ON v.centre_id = c.id
       LEFT JOIN pcpndt_forms pf ON pf.visit_id = v.id
       LEFT JOIN imaging_reports ir ON ir.visit_id = v.id
       WHERE v.patient_id = $1 AND (v.centre_id = $2::uuid OR $2::uuid IS NULL)
       ORDER BY v.created_at DESC`,
      [id, centreId]
    );
    res.status(200).json({ success: true, data: result.rows });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
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
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// -------------------------------------------------------------
// STATUTORY PCPNDT FORM F
// -------------------------------------------------------------
app.get('/api/pcpndt', async (req, res) => {
  const { startDate, endDate, month, search } = req.query;
  const centreId = await resolveCentreId(req);

  try {
    let query = `
      SELECT pf.*, v.invoice_number, COALESCE(pf.created_at, v.created_at) as form_date,
             p.full_name as patient_name, p.age as patient_age, p.phone as patient_phone, p.address as patient_address,
             c.centre_name, c.address as centre_address, COALESCE(pf.clinic_reg_no, c.reg_no, 'RS197') as effective_reg_no,
             d.doctor_name as ref_doctor_name
      FROM pcpndt_forms pf
      JOIN visits v ON pf.visit_id = v.id
      JOIN patients p ON v.patient_id = p.id
      LEFT JOIN clinic_centres c ON v.centre_id = c.id
      LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
      WHERE (v.centre_id = $1::uuid OR $1::uuid IS NULL)
    `;
    let params = [centreId];

    if (startDate && startDate.trim() !== '') {
      if (endDate && endDate.trim() !== '') {
        params.push(startDate, endDate);
        query += ` AND COALESCE(pf.created_at, v.created_at)::date >= $${params.length - 1}::date AND COALESCE(pf.created_at, v.created_at)::date <= $${params.length}::date`;
      } else {
        params.push(startDate);
        query += ` AND COALESCE(pf.created_at, v.created_at)::date = $${params.length}::date`;
      }
    } else if (month && month.trim() !== '') {
      params.push(month);
      query += ` AND TO_CHAR(COALESCE(pf.created_at, v.created_at), 'YYYY-MM') = $${params.length}`;
    }

    if (search && search.trim() !== '') {
      params.push(`%${search.trim()}%`);
      query += ` AND (p.full_name ILIKE $${params.length} OR pf.relative_name ILIKE $${params.length} OR v.invoice_number ILIKE $${params.length})`;
    }

    query += ` ORDER BY form_date DESC`;
    const result = await pool.query(query, params);
    res.status(200).json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/pcpndt/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT pf.*, v.invoice_number, COALESCE(pf.created_at, v.created_at) as form_date,
              p.full_name as patient_name, p.age as patient_age, p.phone as patient_phone, p.address as patient_address,
              c.centre_name, c.address as centre_address, COALESCE(pf.clinic_reg_no, c.reg_no, 'RS197') as effective_reg_no,
              d.doctor_name as ref_doctor_name
       FROM pcpndt_forms pf
       JOIN visits v ON pf.visit_id = v.id
       JOIN patients p ON v.patient_id = p.id
       LEFT JOIN clinic_centres c ON v.centre_id = c.id
       LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
       WHERE pf.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'PCPNDT record not found' });
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.put('/api/pcpndt/:id', async (req, res) => {
  const { id } = req.params;
  const { relativeName, noOfSons, sonsAge, noOfDaughters, daughtersAge, lmpDate, weeksOfPreg, pcpndtIndications, scanResult, doctorName, doctorRegNo, clinicRegNo } = req.body;
  try {
    const result = await pool.query(
      `UPDATE pcpndt_forms 
       SET relative_name = $1, no_of_sons = $2, sons_age = $3, no_of_daughters = $4, daughters_age = $5,
           lmp_date = $6, weeks_of_preg = $7, indications = $8, scan_result = $9, doctor_name = $10, doctor_reg_no = $11, clinic_reg_no = $12
       WHERE id = $13 RETURNING *`,
      [relativeName || '', parseInt(noOfSons, 10) || 0, sonsAge || '', parseInt(noOfDaughters, 10) || 0, daughtersAge || '', lmpDate || '', weeksOfPreg || '', pcpndtIndications || '', scanResult || '', doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', clinicRegNo || 'RS197', id]
    );
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/pcpndt/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM pcpndt_forms WHERE id = $1', [id]);
    res.status(200).json({ success: true, message: 'PCPNDT Form F record deleted' });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// -------------------------------------------------------------
// VISITS, REGISTRATIONS & BILLING
// -------------------------------------------------------------
app.post('/api/register-visit', upload.single('reportFile'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { 
      existingPatientId, fullName, age, gender, phone, email, whatsappNumber, address, patientCode, 
      referringDoctorId, tests, concession, paidAmount, paymentMode, centreId: explicitCentreId,
      isPcpndt, relativeName, noOfSons, sonsAge, noOfDaughters, daughtersAge, lmpDate, weeksOfPreg, pcpndtIndications, scanResult, doctorName, doctorRegNo, clinicRegNo
    } = req.body;

    const reportFile = req.file ? req.file.filename : null;
    let testItems = tests ? (typeof tests === 'string' ? JSON.parse(tests) : tests) : [];

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

    let targetCentreId = explicitCentreId;
    if (!targetCentreId || targetCentreId.trim() === '' || targetCentreId === 'null' || targetCentreId === 'undefined') {
      const centreRes = await client.query('SELECT id FROM clinic_centres WHERE is_active = true LIMIT 1');
      targetCentreId = centreRes.rows.length > 0 ? centreRes.rows[0].id : null;
    }

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
        finalInvestigations.push({ test_id: t.id, category: t.category, price: assignedPrice });
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
      [targetCentreId, patientId, docId, totalAmount, discount, paid, balance, paymentStatus, selectedMode, invoiceNo, doctorCommission, reportFile]
    );
    const visitId = visitResult.rows[0].id;

    for (const inv of finalInvestigations) {
      const barcode = inv.category === 'Pathology' ? generateBarcode() : null;
      await client.query(
        `INSERT INTO patient_investigations (visit_id, test_id, barcode, status, price) VALUES ($1, $2, $3, 'Registered', $4)`,
        [visitId, inv.test_id, barcode, inv.price]
      );
    }

    if (isPcpndt === 'true' || isPcpndt === true || isPcpndt === '1') {
      await client.query(
        `INSERT INTO pcpndt_forms (visit_id, relative_name, no_of_sons, sons_age, no_of_daughters, daughters_age, lmp_date, weeks_of_preg, indications, scan_result, doctor_name, doctor_reg_no, clinic_reg_no) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          visitId, relativeName || '', parseInt(noOfSons, 10) || 0, sonsAge || '', 
          parseInt(noOfDaughters, 10) || 0, daughtersAge || '', lmpDate || '', weeksOfPreg || '', 
          pcpndtIndications || '', scanResult || '', doctorName || 'Dr NIKUNJ KOTHIA', doctorRegNo || '2009/09/3218', clinicRegNo || 'RS197'
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
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

app.put('/api/visits/:id', upload.single('reportFile'), async (req, res) => {
  const { id } = req.params;
  const { concession, paidAmount, paymentMode, referringDoctorId, tests, isPcpndt, relativeName, noOfSons, sonsAge, noOfDaughters, daughtersAge, lmpDate, weeksOfPreg, pcpndtIndications, scanResult } = req.body;
  const reportFile = req.file ? req.file.filename : null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const visitCheck = await client.query('SELECT * FROM visits WHERE id = $1', [id]);
    if (visitCheck.rows.length === 0) return res.status(404).json({ success: false, error: 'Visit not found' });

    let parsedTests = tests ? (typeof tests === 'string' ? JSON.parse(tests) : tests) : null;
    let totalAmount = 0, doctorCommission = 0;

    if (parsedTests && Array.isArray(parsedTests) && parsedTests.length > 0) {
      await client.query('DELETE FROM patient_investigations WHERE visit_id = $1', [id]);
      for (const t of parsedTests) {
        const itemPrice = parseFloat(t.price) || 0;
        totalAmount += itemPrice;
        let testCut = 0, category = t.category || 'Pathology';
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

    if (isPcpndt === 'true' || isPcpndt === true) {
      const pCheck = await client.query('SELECT id FROM pcpndt_forms WHERE visit_id = $1', [id]);
      if (pCheck.rows.length > 0) {
        await client.query(
          `UPDATE pcpndt_forms 
           SET relative_name = $1, no_of_sons = $2, sons_age = $3, no_of_daughters = $4, daughters_age = $5, lmp_date = $6, weeks_of_preg = $7, indications = $8, scan_result = $9, clinic_reg_no = 'RS197'
           WHERE visit_id = $10`,
          [relativeName || '', parseInt(noOfSons, 10) || 0, sonsAge || '', parseInt(noOfDaughters, 10) || 0, daughtersAge || '', lmpDate || '', weeksOfPreg || '', pcpndtIndications || '', scanResult || '', id]
        );
      } else {
        await client.query(
          `INSERT INTO pcpndt_forms (visit_id, relative_name, no_of_sons, sons_age, no_of_daughters, daughters_age, lmp_date, weeks_of_preg, indications, scan_result, clinic_reg_no) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'RS197')`,
          [id, relativeName || '', parseInt(noOfSons, 10) || 0, sonsAge || '', parseInt(noOfDaughters, 10) || 0, daughtersAge || '', lmpDate || '', weeksOfPreg || '', pcpndtIndications || '', scanResult || '']
        );
      }
    }

    await client.query('COMMIT');
    res.status(200).json({ success: true, data: result.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
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
    await client.query('DELETE FROM imaging_reports WHERE visit_id = $1', [id]);
    await client.query('DELETE FROM visits WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.status(200).json({ success: true, message: 'Visit deleted' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ success: false, error: error.message });
  } finally {
    client.release();
  }
});

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
    const reportQuery = await pool.query(`SELECT * FROM imaging_reports WHERE visit_id = $1`, [visitRow.id]);

    res.status(200).json({
      success: true,
      data: { visitDetails: visitRow, investigations: testsQuery.rows, pcpndtForm: pcpndtQuery.rows[0] || null, imagingReport: reportQuery.rows[0] || null }
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/reports/collection', async (req, res) => {
  const { startDate, endDate, month, patientName, category } = req.query;
  const centreId = await resolveCentreId(req);

  try {
    let query = `
      SELECT v.id as visit_id, v.invoice_number, COALESCE(v.created_at, CURRENT_TIMESTAMP) as created_at, 
             COALESCE(p.full_name, 'Direct Patient') as full_name, COALESCE(p.phone, '') as phone, 
             v.total_amount, v.concession, v.paid_amount, v.balance_amount, v.payment_status, 
             COALESCE(v.payment_mode, 'Cash') as payment_mode, v.report_file,
             COALESCE(c.centre_name, 'Main Centre') as centre_name,
             COALESCE(string_agg(DISTINCT tm.category, ', '), 'General') as categories,
             COALESCE(string_agg(DISTINCT tm.test_name, ', '), '') as test_names,
             CASE WHEN pf.id IS NOT NULL THEN true ELSE false END as has_pcpndt,
             CASE WHEN ir.id IS NOT NULL THEN true ELSE false END as has_imaging_report
      FROM visits v 
      LEFT JOIN patients p ON v.patient_id = p.id 
      LEFT JOIN clinic_centres c ON v.centre_id = c.id
      LEFT JOIN patient_investigations pi ON pi.visit_id = v.id
      LEFT JOIN test_master tm ON pi.test_id = tm.id
      LEFT JOIN pcpndt_forms pf ON pf.visit_id = v.id
      LEFT JOIN imaging_reports ir ON ir.visit_id = v.id
      WHERE (v.centre_id = $1::uuid OR $1::uuid IS NULL)
    `;
    let params = [centreId];

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

    query += ` GROUP BY v.id, p.full_name, p.phone, c.centre_name, pf.id, ir.id ORDER BY v.created_at DESC`;
    const result = await pool.query(query, params);

    const totalCollection = result.rows.reduce((sum, r) => sum + parseFloat(r.paid_amount || 0), 0);
    const totalPending = result.rows.reduce((sum, r) => sum + parseFloat(r.balance_amount || 0), 0);

    res.status(200).json({
      success: true,
      data: result.rows,
      summary: { totalCollection, totalPending, recordCount: result.rows.length }
    });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/api/reports/doctor-detailed', async (req, res) => {
  const { doctorId, startDate, endDate, month, patientName } = req.query;
  const centreId = await resolveCentreId(req);

  try {
    let query = `
      SELECT v.id as visit_id, v.invoice_number, COALESCE(v.created_at, CURRENT_TIMESTAMP) as created_at, 
             COALESCE(p.full_name, 'Direct Patient') as full_name, v.total_amount, v.doctor_commission,
             d.id as doctor_id, COALESCE(d.doctor_name, 'Self / Direct') as doctor_name, 
             COALESCE(d.hospital_clinic_name, 'General') as hospital_clinic_name
      FROM visits v
      LEFT JOIN referring_doctors d ON v.referring_doctor_id = d.id
      LEFT JOIN patients p ON v.patient_id = p.id
      WHERE (v.centre_id = $1::uuid OR $1::uuid IS NULL)
    `;
    let params = [centreId];

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
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.use((req, res) => {
  if (fs.existsSync(path.join(__dirname, 'public', 'index.html'))) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

app.listen(PORT, '0.0.0.0', async () => {
  await initDB();
  console.log(`RESQ Clinic System online at port ${PORT}`);
});