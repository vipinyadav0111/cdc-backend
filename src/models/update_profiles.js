const pool = require('./db');

// Profile data read directly from Excel
const profiles = [
  { email: 'vipinyadav.cdc@mriu.edu.in',     dob: '1993-01-30', designation: 'Manager',                        phone: '7508009698', joined: '2022-09-03' },
  { email: 'ankurkumaraggarwal@mru.edu.in',   dob: '1987-04-21', designation: 'Associate Head - Career Skills', phone: '9911888492', joined: '2023-01-21' },
  { email: 'susantabose.cdc@mriu.edu.in',     dob: '1985-10-27', designation: 'Head - Career Skills',           phone: '9953315901', joined: '2023-08-07' },
  { email: 'harmeetkaur.fca@mriu.edu.in',     dob: '1985-08-11', designation: 'Lead Technical - Career Skills', phone: '9928110309', joined: '2022-12-19' },
  { email: 'kirtiaggarwal.set@mriu.edu.in',   dob: '1985-06-30', designation: 'Manager - Career Skills',        phone: '9899174007', joined: '2023-02-01' },
  { email: 'prakashjha.cdc@mrvpl.in',         dob: '1977-07-10', designation: 'Deputy Manager - Career Skills', phone: '6239982945', joined: '2023-11-28' },
  { email: 'sahilnagpal.cdc@mriu.edu.in',     dob: '1993-06-12', designation: 'Manager',                        phone: '9953931475', joined: '2023-03-01' },
  { email: 'geetika.cdc@mrvpl.in',            dob: '1999-08-26', designation: 'Assistant Manager - Career Skills', phone: '9053171150', joined: '2025-08-01' },
  { email: 'karansardana.cdc@mriu.edu.in',    dob: '1989-12-01', designation: 'Sr. Manager - Career Skills',    phone: '7838673733', joined: '2025-08-11' },
  { email: 'amjadchaudhary.cdc@mriu.edu.in',  dob: '1993-07-15', designation: 'Deputy Manager',                 phone: '8427036871', joined: '2025-08-15' },
  { email: 'snigdha.cdc@mrvpl.in',            dob: '1988-08-27', designation: 'Manager',                        phone: '9873387116', joined: '2016-07-22' },
  { email: 'premaanand.cdc@mriu.edu.in',      dob: '1968-04-15', designation: 'Manager Training',               phone: '9811758154', joined: '2022-08-22' },
  { email: 'pranamika.cdc@mriu.edu.in',       dob: '1981-02-14', designation: 'Manager - Career Skills',        phone: '9811668432', joined: '2023-01-03' },
  { email: 'soniagupta.cdc@mriu.edu.in',      dob: null,         designation: 'CDC Trainer',                    phone: '',           joined: null },
  { email: 'avikchakraborty.cdc@mriu.edu.in', dob: '1983-01-18', designation: 'Senior Manager',                 phone: '9880036081', joined: '2025-08-13' },
  { email: 'monikaaggarwal.cdc@mriu.edu.in',  dob: '1974-01-09', designation: 'Deputy General Manager',         phone: '9873634445', joined: '2022-09-07' },
  { email: 'priyasingh.cdc@mriu.edu.in',      dob: '1995-04-20', designation: 'Assistant Manager',              phone: '9873030796', joined: '2023-08-21' },
  { email: 'swapnilvinod@mru.edu.in',         dob: '1983-09-26', designation: 'Sr. Manager Career Skills',      phone: '9910043046', joined: '2022-07-01' },
  { email: 'shivangeearora.cdc@mriu.edu.in',  dob: '1993-09-07', designation: 'Assistant Manager',              phone: '8826911903', joined: '2024-07-01' },
  { email: 'anand.cdc@mriu.edu.in',           dob: null,         designation: 'CDC Trainer',                    phone: '',           joined: null },
  { email: 'akshi.cdc@mriu.edu.in',           dob: null,         designation: 'CDC Trainer',                    phone: '',           joined: null },
  { email: 'nitya.cdc@mriu.edu.in',           dob: null,         designation: 'Visiting Faculty',               phone: '',           joined: null },
  { email: 'vibha.cdc@mriu.edu.in',           dob: null,         designation: 'Visiting Faculty',               phone: '',           joined: null },
  { email: 'aarti.cdc@mriu.edu.in',           dob: null,         designation: 'Visiting Faculty',               phone: '',           joined: null },
];

async function updateProfiles() {
  const client = await pool.connect();
  try {
    // Make sure columns exist
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS designation VARCHAR(100);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday DATE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS joined_date DATE;
    `);

    // Make sure notices table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS notices (
        id SERIAL PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        content TEXT NOT NULL,
        category VARCHAR(50) DEFAULT 'general',
        priority VARCHAR(20) DEFAULT 'normal',
        author_id INTEGER REFERENCES users(id),
        author_name VARCHAR(100),
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create attendance tables
    const fs = require('fs');
    const attSchema = fs.readFileSync(__dirname + '/attendance_schema.sql', 'utf8');
    await client.query(attSchema);
    console.log('✅ Attendance tables created');
    console.log('✅ Schema updated');

    let updated = 0;
    for (const p of profiles) {
      const result = await client.query(
        `UPDATE users SET
          designation = $1,
          birthday = $2,
          phone = $3,
          joined_date = $4
         WHERE LOWER(email) = LOWER($5)`,
        [p.designation, p.dob || null, p.phone || null, p.joined || null, p.email]
      );
      if (result.rowCount > 0) {
        console.log(`  ✅ Updated: ${p.email} → ${p.designation}`);
        updated++;
      } else {
        console.log(`  ⚠️  Not found: ${p.email}`);
      }
    }

    console.log(`\n🎉 Done! Updated ${updated}/${profiles.length} profiles`);
  } catch(e) {
    console.error('❌ Error:', e.message);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

updateProfiles().catch(console.error);
