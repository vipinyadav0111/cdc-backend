const pool = require('./db');
const bcrypt = require('bcryptjs');

const schema = `
DROP TABLE IF EXISTS audit_log CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS duties CASCADE;
DROP TABLE IF EXISTS timetable CASCADE;
DROP TABLE IF EXISTS users CASCADE;

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  employee_id VARCHAR(20) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'trainer' CHECK (role IN ('super_admin','trainer','viewer')),
  is_active BOOLEAN DEFAULT true,
  must_change_password BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE timetable (
  id SERIAL PRIMARY KEY,
  trainer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  day VARCHAR(15) NOT NULL,
  slot_number INTEGER NOT NULL,
  class_name VARCHAR(150),
  session_type VARCHAR(50),
  room VARCHAR(20),
  institution VARCHAR(20),
  UNIQUE(trainer_id, day, slot_number)
);

CREATE TABLE duties (
  id SERIAL PRIMARY KEY,
  trainer_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  slot_number INTEGER NOT NULL,
  type VARCHAR(20) CHECK (type IN ('adjustment','duty','extra_class','cancellation')),
  class_name VARCHAR(150),
  room VARCHAR(20),
  topic TEXT,
  instructions TEXT,
  note TEXT,
  assigned_by INTEGER REFERENCES users(id),
  acknowledged BOOLEAN DEFAULT false,
  acknowledged_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200),
  message TEXT,
  type VARCHAR(50),
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action VARCHAR(100),
  details TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
`;

// Slot mapping: col index (0-based from col B) -> slot number
// Col B=slot2, C=slot3, D=slot4, E=lunch(skip), F=slot5, G=slot6, H=slot7, I=slot8, J=slot9
// Index: 0=II(2), 1=III(3), 2=IV(4), 3=LUNCH, 4=V(5), 5=VI(6), 6=VII(7), 7=VIII(8), 8=IX(9)
const COL_TO_SLOT = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const trainers = [
  { name: 'Mr. Vipin',      email: 'vipinyadav.cdc@mriu.edu.in',      employee_id: '4500466', role: 'super_admin' },
  { name: 'Mr. Ankur',      email: 'ankurkumaraggarwal@mru.edu.in',    employee_id: '2010830', role: 'super_admin' },
  { name: 'Mr. Susanta',    email: 'susantabose.cdc@mriu.edu.in',      employee_id: '4500538', role: 'trainer' },
  { name: 'Ms. Harmeet',    email: 'harmeetkaur.fca@mriu.edu.in',      employee_id: '5700051', role: 'trainer' },
  { name: 'Ms. Kirti',      email: 'kirtiaggarwal.set@mriu.edu.in',    employee_id: '5000706', role: 'trainer' },
  { name: 'Mr. Prakash',    email: 'prakashjha.cdc@mrvpl.in',          employee_id: '8500618', role: 'trainer' },
  { name: 'Mr. Sahil',      email: 'sahilnagpal.cdc@mriu.edu.in',      employee_id: '4500506', role: 'trainer' },
  { name: 'Ms. Geetika',    email: 'geetika.cdc@mrvpl.in',             employee_id: '8500679', role: 'trainer' },
  { name: 'Mr. Karan',      email: 'karansardana.cdc@mriu.edu.in',     employee_id: '4500649', role: 'trainer' },
  { name: 'Mr. Amjad',      email: 'amjadchaudhary.cdc@mriu.edu.in',   employee_id: '4500656', role: 'trainer' },
  { name: 'Ms. Snigdha',    email: 'snigdha.cdc@mrvpl.in',             employee_id: '8500234', role: 'trainer' },
  { name: 'Mr. Anand',      email: 'anand.cdc@mriu.edu.in',            employee_id: 'TBD001',  role: 'trainer' },
  { name: 'Ms. Sonia',      email: 'soniagupta.cdc@mriu.edu.in',       employee_id: '4500640', role: 'trainer' },
  { name: 'Ms. Akshi',      email: 'akshi.cdc@mriu.edu.in',            employee_id: 'TBD002',  role: 'trainer' },
  { name: 'Ms. Shivangee',  email: 'shivangeearora.cdc@mriu.edu.in',   employee_id: '4500592', role: 'trainer' },
  { name: 'Ms. Priya',      email: 'priyasingh.cdc@mriu.edu.in',       employee_id: '4500544', role: 'trainer' },
  { name: 'Dr. Monika',     email: 'monikaaggarwal.cdc@mriu.edu.in',   employee_id: '4500468', role: 'trainer' },
  { name: 'Ms. Swapnil',    email: 'swapnilvinod@mru.edu.in',          employee_id: '2010794', role: 'trainer' },
  { name: 'Mr. Avik',       email: 'avikchakraborty.cdc@mriu.edu.in',  employee_id: '4500651', role: 'trainer' },
  { name: 'Ms. Pranamika',  email: 'pranamika.cdc@mriu.edu.in',        employee_id: '4500495', role: 'trainer' },
  { name: 'Ms. Prema',      email: 'premaanand.cdc@mriu.edu.in',       employee_id: '4500462', role: 'trainer' },
  { name: 'Ms. Nitya',      email: 'nitya.cdc@mriu.edu.in',            employee_id: 'TBD003',  role: 'trainer' },
  { name: 'Ms. Vibha',      email: 'vibha.cdc@mriu.edu.in',            employee_id: 'TBD004',  role: 'trainer' },
  { name: 'Ms. Aarti',      email: 'aarti.cdc@mriu.edu.in',            employee_id: 'TBD005',  role: 'trainer' },
];

function parseCell(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;
  // Extract room: last word if it looks like a room code
  const parts = s.split(' ');
  const lastWord = parts[parts.length - 1];
  const roomPattern = /^[A-Z]{1,3}\s*\d{2,3}$|^[A-Z]{2,4}\d{2,3}$|^[A-Z]{1,2}\d{2,3}$/;
  let room = null;
  let className = s;
  if (roomPattern.test(lastWord.replace(/\s/g,''))) {
    room = lastWord.replace(/\s/g,'');
    className = parts.slice(0, -1).join(' ').trim();
  }
  // Detect institution
  let institution = 'Other';
  if (s.includes('MRIIRS') || s.includes('Mriirs')) institution = 'MRIIRS';
  else if (s.includes('MRU') || s.includes('Mru')) institution = 'MRU';
  else if (s.includes('CDOE')) institution = 'CDOE';
  // Detect session type
  let session_type = 'General';
  const sl = s.toLowerCase();
  if (sl.includes('soft skill') || sl.includes('verbal')) session_type = 'Soft Skills';
  else if (sl.includes('apti') || sl.includes('aptitude')) session_type = 'Aptitude';
  else if (sl.includes('technical') || sl.includes('tech')) session_type = 'Technical';
  else if (sl.includes('kedge')) session_type = 'Special';

  return { class_name: className, session_type, room, institution };
}

// Full timetable from Excel - keyed by trainer email
// Format: [day, col_index(0-8), cell_value]
// col_index maps to slots: 0=Slot2, 1=Slot3, 2=Slot4, 3=LUNCH(skip), 4=Slot5, 5=Slot6, 6=Slot7, 7=Slot8, 8=Slot9
const rawTT = {
  'susantabose.cdc@mriu.edu.in': [
    ['Tuesday',   1, 'MRU CSE 6AIML B Soft Skill LT09'],
    ['Tuesday',   2, 'MRU CSE 6AIML C+FSD Soft Skill LF03'],
    ['Wednesday', 1, 'MRU CSE 6CSTI+R&I Soft Skill HT09'],
    ['Wednesday', 2, 'MRU ECE+ME 6 Soft Skill HS07'],
    ['Thursday',  1, 'MRU CSE 4C Soft Skill LF03'],
    ['Thursday',  2, 'MRU CSE 4D Soft Skill KS02'],
    ['Friday',    1, 'MRU CSE 4C Soft Skill LS03'],
    ['Friday',    2, 'MRU CSE 4D Soft Skill LT09'],
  ],
  'ankurkumaraggarwal@mru.edu.in': [
    ['Monday',    1, 'MRU CSE 6C Technical HF09'],
    ['Monday',    2, 'MRU CSE 6C Technical HF09'],
    ['Tuesday',   0, 'MRIIRS CSE 6E Technical AF14'],
    ['Tuesday',   1, 'MRIIRS CSE 6E Technical AF14'],
    ['Tuesday',   4, 'MRIIRS CSE 6D Technical AF13'],
    ['Tuesday',   5, 'MRIIRS CSE 6D Technical AF13'],
    ['Wednesday', 0, 'MRU CSE 6AIML A Technical LT09'],
    ['Wednesday', 1, 'MRU CSE 6AIML A Technical LF03'],
    ['Thursday',  4, 'MRIIRS BCA 4A Technical CT06'],
    ['Thursday',  5, 'MRIIRS BCA 4A Technical CT06'],
    ['Friday',    0, 'MRIIRS CSE 6AIML A Technical AF13'],
    ['Friday',    1, 'MRIIRS CSE 6AIML A Technical AF13'],
  ],
  'harmeetkaur.fca@mriu.edu.in': [
    ['Thursday',  3, 'MRIIRS MCA 2A Technical CS22'],
    ['Monday',    1, 'MRU CSE 6CSTI+R&I Technical HT09'],
    ['Monday',    2, 'MRU CSE 6CSTI+R&I Technical HT09'],
    ['Tuesday',   0, 'MRIIRS CSE 6SPL Technical AF15'],
    ['Tuesday',   1, 'MRIIRS CSE 6SPL Technical AF15'],
    ['Tuesday',   4, 'MRU CSE 6A Technical HF09'],
    ['Tuesday',   5, 'MRU CSE 6A Technical HF09'],
    ['Wednesday', 5, 'MRIIRS CSE 6F Technical AS19'],
    ['Wednesday', 6, 'MRIIRS CSE 6F Technical AS19'],
    ['Thursday',  0, 'MRIIRS CSE 6A Technical AF13'],
    ['Thursday',  1, 'MRIIRS CSE 6A Technical AF13'],
    ['Thursday',  3, 'MRIIRS MCA 2A Technical CS22'],
    ['Thursday',  4, 'MRIIRS MCA 2A Technical CS22'],
    ['Friday',    4, 'MRIIRS CSE 6BSML+DS Technical AF24'],
    ['Friday',    5, 'MRIIRS CSE 6BSML+DS Technical AF24'],
  ],
  'kirtiaggarwal.set@mriu.edu.in': [
    ['Thursday',  3, 'MRIIRS MCA 2B Technical CT24'],
    ['Monday',    1, 'MRU CSE 6AIML B Technical LS03'],
    ['Monday',    2, 'MRU CSE 6AIML B Technical LS03'],
    ['Monday',    4, 'MRIIRS CSE 6B Technical AF15'],
    ['Monday',    5, 'MRIIRS CSE 6B Technical AF15'],
    ['Tuesday',   0, 'MRU CSE 6AIML C+FSD Technical LS03'],
    ['Tuesday',   1, 'MRU CSE 6AIML C+FSD Technical LS03'],
    ['Wednesday', 0, 'MRU CSE 6B Technical HF09'],
    ['Wednesday', 1, 'MRU CSE 6B Technical HF09'],
    ['Wednesday', 4, 'MRIIRS CSE 6C Technical AF14'],
    ['Wednesday', 5, 'MRIIRS CSE 6C Technical AF14'],
    ['Thursday',  3, 'MRIIRS MCA 2B Technical CT24'],
    ['Thursday',  4, 'MRIIRS MCA 2B Technical CT24'],
    ['Friday',    0, 'MRIIRS CSE 6AIML B Technical AF14'],
    ['Friday',    1, 'MRIIRS CSE 6AIML B Technical AF14'],
  ],
  'vipinyadav.cdc@mriu.edu.in': [
    ['Monday',    1, 'MRIIRS 6ECE-EE Aptitude AS09'],
    ['Monday',    4, 'MRU MBA 2 Aptitude ILG06'],
    ['Monday',    5, 'MRU MBA 2 Aptitude ILG06'],
    ['Tuesday',   1, 'MRIIRS 6ECE-EE Aptitude AS09'],
    ['Tuesday',   5, 'MRIIRS CSE 6F Aptitude AF13'],
    ['Tuesday',   6, 'MRIIRS CSE 4AIML A Aptitude'],
    ['Wednesday', 4, 'MRIIRS CSE 6D Aptitude'],
    ['Wednesday', 5, 'MRIIRS CSE 4AIML B Aptitude'],
    ['Thursday',  1, 'MRIIRS CSE 6C Aptitude AF14'],
    ['Thursday',  4, 'MRU Law 8A Aptitude KF02'],
    ['Thursday',  5, 'MRU Law 8A Aptitude KF02'],
    ['Friday',    2, 'MRIIRS CSE 4AIML B Aptitude'],
    ['Friday',    4, 'MRIIRS CSE 4AIML A Aptitude AF13'],
  ],
  'prakashjha.cdc@mrvpl.in': [
    ['Monday',    1, 'MRIIRS MCA 2A Aptitude CS08'],
    ['Monday',    4, 'MRU CSE 6B Aptitude HF10'],
    ['Monday',    5, 'MRU CSE 6A Aptitude HF09'],
    ['Tuesday',   1, 'MRIIRS MCA 2A Aptitude CS08'],
    ['Tuesday',   4, 'MRIIRS MBA 2A Aptitude'],
    ['Tuesday',   5, 'MRIIRS MBA 2B Aptitude'],
    ['Wednesday', 2, 'MRU CSE 6C Aptitude HF09'],
    ['Wednesday', 4, 'MRU Law 8B Aptitude KF03'],
    ['Wednesday', 5, 'MRU Law 8B Aptitude KF03'],
    ['Thursday',  0, 'MRIIRS CSE 6E Aptitude AF15'],
    ['Thursday',  2, 'MRU CSE 6AIML A Aptitude KS10'],
    ['Thursday',  4, 'MRU CSE 6AIML A Aptitude LF09'],
    ['Thursday',  5, 'MRU CSE 6C Aptitude HF10'],
    ['Friday',    0, 'MRU CSE 6A Aptitude HF09'],
    ['Friday',    1, 'MRU CSE 6B Aptitude HF09'],
  ],
  'sahilnagpal.cdc@mriu.edu.in': [
    ['Monday',    2, 'MRU CSE 4AIML B Aptitude LS10'],
    ['Monday',    4, 'MRIIRS 6BT Aptitude AT18'],
    ['Monday',    5, 'MRIIRS BCA 4A Aptitude CT06'],
    ['Monday',    6, 'MRIIRS BCA 4B+BscIT Aptitude CT07'],
    ['Tuesday',   1, 'MRIIRS BCA 4A Aptitude CT06'],
    ['Tuesday',   2, 'MRIIRS BCA 4B+BscIT Aptitude CT07'],
    ['Tuesday',   4, 'MRU CSE 4AIML A Aptitude'],
    ['Tuesday',   5, 'MRIIRS BCOM 4ACCA Aptitude'],
    ['Wednesday', 0, 'MRU CSE 4AIML A Aptitude LF03'],
    ['Wednesday', 4, 'MRIIRS CSE 6BSML+DS Aptitude AF23'],
    ['Wednesday', 5, 'MRIIRS CSE 6SPL Aptitude AF23'],
    ['Thursday',  0, 'MRU CSE 4AIML B Aptitude LF09'],
    ['Thursday',  1, 'KEDGE Class'],
    ['Thursday',  2, 'MRIIRS BCOM 4ACCA Aptitude TT15'],
    ['Thursday',  4, 'MRIIRS 6BT Aptitude AT18'],
  ],
  'geetika.cdc@mrvpl.in': [
    ['Monday',    0, 'MRU CSE 4C Aptitude KS02'],
    ['Monday',    1, 'MRU CSE 4D Aptitude LT10'],
    ['Tuesday',   0, 'MRIIRS CSE 4B Aptitude AF20'],
    ['Tuesday',   2, 'MRIIRS BCA 4C Aptitude CT08'],
    ['Tuesday',   4, 'MRU CSE 4A Aptitude LT03'],
    ['Tuesday',   5, 'MRU CSE 4B Aptitude KS02'],
    ['Wednesday', 1, 'MRIIRS BCA 2A Aptitude CT03'],
    ['Wednesday', 2, 'MRIIRS BCA 2C Aptitude CT05'],
    ['Wednesday', 4, 'MRU CSE 4C Aptitude LS03'],
    ['Wednesday', 5, 'MRU CSE 4D Aptitude KS02'],
    ['Thursday',  0, 'MRIIRS BCA 4C Aptitude CT08'],
    ['Thursday',  1, 'MRIIRS BCA 2A Aptitude CT03'],
    ['Thursday',  2, 'MRIIRS BCA 2C Aptitude CT05'],
    ['Friday',    0, 'MRIIRS CSE 4B Aptitude AF15'],
    ['Friday',    4, 'MRU CSE 4A Aptitude LT09'],
    ['Friday',    5, 'MRU CSE 4B Aptitude KS02'],
  ],
  'karansardana.cdc@mriu.edu.in': [
    ['Monday',    1, 'MRIIRS 4ECE+EE Aptitude AS25'],
    ['Monday',    4, 'MRIIRS CSE 4D Aptitude AF20'],
    ['Monday',    5, 'MRIIRS CSE 4C Aptitude AF20'],
    ['Tuesday',   1, 'MRIIRS CSE 6AIML A Aptitude AF24'],
    ['Tuesday',   2, 'MRIIRS CSE 6AIML B Aptitude AF24'],
    ['Tuesday',   4, 'MRU MSc 2 Aptitude IS08'],
    ['Tuesday',   5, 'MRU MSc 2 Aptitude IS08'],
    ['Wednesday', 0, 'MRIIRS CSE 6B Aptitude AF14'],
    ['Wednesday', 1, 'MRIIRS CSE 6A Aptitude AF14'],
    ['Wednesday', 4, 'MRIIRS CSE 4D Aptitude AF24'],
    ['Wednesday', 5, 'MRIIRS CSE 4E Aptitude AF20'],
    ['Thursday',  1, 'MRIIRS CSE 4C Aptitude AS18'],
    ['Thursday',  2, 'MRIIRS CSE 4E Aptitude AS18'],
    ['Thursday',  4, 'MRIIRS ME+Civil 6 Aptitude CS20'],
    ['Friday',    1, 'MRIIRS 4ECE+EE Aptitude AS25'],
    ['Friday',    2, 'MRIIRS ME+Civil 6 Aptitude CS20'],
  ],
  'amjadchaudhary.cdc@mriu.edu.in': [
    ['Friday',    3, 'MRIIRS MCA 2B Aptitude CS09'],
    ['Monday',    2, 'MRU CSE 6AIML C+FSD Aptitude LF03'],
    ['Monday',    4, 'MRU CSE 6AIML B Aptitude LS03'],
    ['Monday',    5, 'MRU CSE 6AIML C+FSD Aptitude LT03'],
    ['Tuesday',   1, 'MRU ECE+ME 6 Aptitude HF08'],
    ['Tuesday',   2, 'MRIIRS BCOM 4B Aptitude TT11'],
    ['Tuesday',   4, 'MRU CSE 6AIML B Aptitude LF10'],
    ['Tuesday',   5, 'MRU CSE 6CSTI+R&I Aptitude HT03'],
    ['Wednesday', 0, 'MRIIRS 4BT+Microbiology Aptitude AT17'],
    ['Wednesday', 1, 'MRIIRS CSE 4BAIML/BSML Aptitude AF24'],
    ['Wednesday', 6, 'MRIIRS BCOM 4B Aptitude TT11'],
    ['Thursday',  1, 'MRIIRS CSE 4BSML Aptitude AS19'],
    ['Thursday',  5, 'MRU CSE 6CSTI+R&I Aptitude HT03'],
    ['Friday',    0, 'MRIIRS 4BT+Microbiology Aptitude AT17'],
    ['Friday',    2, 'MRU ECE+ME 6 Aptitude HF08'],
    ['Friday',    3, 'MRIIRS MCA 2B Aptitude CS09'],
    ['Friday',    4, 'MRIIRS MCA 2B Aptitude CS09'],
  ],
  'snigdha.cdc@mrvpl.in': [
    ['Wednesday', 3, 'MRIIRS BCA 4D Aptitude CT06'],
    ['Thursday',  3, 'MRIIRS BCA 4D Aptitude CT06'],
    ['Monday',    1, 'MRIIRS 4ME+Civil Aptitude'],
    ['Monday',    2, 'MRIIRS BCA 2B+BscIT Aptitude CT04'],
    ['Monday',    4, 'MRIIRS CSE 4A Aptitude'],
    ['Monday',    5, 'MRIIRS CSE 4SPL Aptitude'],
    ['Tuesday',   1, 'MRU CSE 4CSTI+FSD Aptitude LF03'],
    ['Tuesday',   6, 'MRIIRS BCOM 4A Aptitude'],
    ['Wednesday', 0, 'MRU CSE 4ECE+ME+R&I Aptitude'],
    ['Wednesday', 2, 'MRIIRS 4ME+Civil Aptitude'],
    ['Wednesday', 3, 'MRIIRS BCA 4D Aptitude CT06'],
    ['Thursday',  0, 'MRIIRS CSE 4SPL Aptitude AF23'],
    ['Thursday',  1, 'MRIIRS CSE 4A Aptitude AF23'],
    ['Thursday',  3, 'MRIIRS BCA 4D Aptitude CT06'],
    ['Thursday',  4, 'MRIIRS BCA 2B+BscIT Aptitude CT04'],
    ['Friday',    1, 'MRU CSE 4CSTI+FSD Aptitude LT03'],
    ['Friday',    2, 'MRU CSE 4ECE+ME+R&I Aptitude'],
    ['Friday',    5, 'MRIIRS BCOM 4A Aptitude TT10'],
  ],
  'anand.cdc@mriu.edu.in': [
    ['Monday',    0, 'MRIIRS CSE 4D Soft Skills AF21'],
    ['Monday',    1, 'MRIIRS CSE 4C Soft Skills AF21'],
    ['Monday',    4, 'MRU B.Ed 2 Soft Skills JUG05'],
    ['Monday',    6, 'MRIIRS BCA 2A Soft Skills CT03'],
    ['Tuesday',   0, 'MRIIRS BBA 2A Soft Skills TS02'],
    ['Tuesday',   1, 'MRIIRS BBA 2B Soft Skills TS25'],
    ['Tuesday',   2, 'MRU 4ECE+ME+R&I Soft Skills HT10'],
    ['Tuesday',   4, 'MRIIRS SBSS UG 2A Soft Skills BF02'],
    ['Tuesday',   5, 'MRIIRS SBSS UG 4A Soft Skills BF04'],
    ['Wednesday', 1, 'MRIIRS CSE 4D Soft Skills AF21'],
    ['Wednesday', 2, 'MRIIRS CSE 4C Soft Skills AF21'],
    ['Wednesday', 4, 'MRIIRS BCA 2A Soft Skills CT03'],
    ['Thursday',  0, 'MRU LAW 4B Soft Skills KF10'],
    ['Thursday',  1, 'MRU B.Ed 2 Soft Skills JUG05'],
    ['Thursday',  4, 'MRU CSE 4ECE+ME+R&I Soft Skills HT10'],
    ['Friday',    0, 'MRIIRS SBSS UG 4A Soft Skills BF04'],
    ['Friday',    1, 'MRIIRS SBSS UG 2A Soft Skills BF02'],
    ['Friday',    4, 'MRIIRS BBA 2A Soft Skills TS02'],
    ['Friday',    5, 'MRIIRS BBA 2B Soft Skills TS25'],
    ['Friday',    6, 'MRU LAW 4B Soft Skills KF10'],
  ],
  'soniagupta.cdc@mriu.edu.in': [
    ['Monday',    1, 'MRU CSE 2R&I Soft Skills HT03'],
    ['Monday',    2, 'MRU LAW 2B Soft Skills GF04'],
    ['Monday',    4, 'MRIIRS BBA 2C Soft Skills TS23'],
    ['Monday',    5, 'MRIIRS BBA 2D Soft Skills TS03'],
    ['Monday',    6, 'MRIIRS BCOM 2ACCA Soft Skills TT03'],
    ['Tuesday',   1, 'MRIIRS BSc ID+Design 2A Soft Skills'],
    ['Tuesday',   4, 'MRIIRS BCOM 2A Soft Skills'],
    ['Tuesday',   5, 'MRIIRS BBA 2D Soft Skills'],
    ['Tuesday',   6, 'MRIIRS BCOM 2ACCA Soft Skills'],
    ['Wednesday', 1, 'MRU ECE 2 Soft Skills HT10'],
    ['Wednesday', 2, 'MRU ME 2 Soft Skills HF03'],
    ['Wednesday', 4, 'MRU BCA 2CC+Fintec Soft Skills'],
    ['Wednesday', 5, 'MRU LAW 2B Soft Skills GF04'],
    ['Thursday',  1, 'MRIIRS BCOM 2A Soft Skills TT02'],
    ['Thursday',  2, 'MRIIRS BBA 2C Soft Skills TT23'],
    ['Thursday',  4, 'MRU ECE 2 Soft Skills HS09'],
    ['Thursday',  5, 'MRU ME 2 Soft Skills HF03'],
    ['Friday',    1, 'MRIIRS BSc ID+Design 2A Soft Skills ES06'],
    ['Friday',    4, 'MRU BCA 2CC+Fintec Soft Skills LT03'],
    ['Friday',    5, 'MRU CSE 2R&I Soft Skills HT03'],
  ],
  'akshi.cdc@mriu.edu.in': [
    ['Monday',    1, 'MRU CSE 2AIML A Soft Skills LF09'],
    ['Monday',    2, 'MRU CSE 2AIML B Soft Skills LF09'],
    ['Monday',    4, 'MRIIRS BSc N&D+FST 2 Soft Skills QS04'],
    ['Monday',    6, 'MRIIRS SMEH UG 2B Soft Skills FT09'],
    ['Tuesday',   1, 'MRU CSE 2AIML B Soft Skills LF09'],
    ['Tuesday',   2, 'MRU CSE 2CSTI+Gen AI Soft Skills LT10'],
    ['Tuesday',   5, 'MRIIRS CSE 4A Soft Skills AF20'],
    ['Tuesday',   6, 'MRIIRS 6ECE-EE Soft Skills AS09'],
    ['Wednesday', 0, 'MRU CSE 2AIML A Soft Skills LS03'],
    ['Wednesday', 2, 'MRIIRS BCOM 4B Verbal TT11'],
    ['Wednesday', 4, 'MRIIRS BSc N&D+FST 2 Soft Skills QS04'],
    ['Wednesday', 5, 'MRIIRS BPT 2nd Year Soft Skills'],
    ['Thursday',  0, 'MRU CSE 6A Soft Skills HF09'],
    ['Thursday',  1, 'MRU CSE 6B Soft Skills HF09'],
    ['Thursday',  2, 'MRU CSE 6C Soft Skills HF09'],
    ['Thursday',  4, 'MRU CSE 2CSTI+Gen AI Soft Skills LT09'],
    ['Thursday',  5, 'MRU CSE 6AIML A Soft Skills LT03'],
    ['Friday',    0, 'MRIIRS CSE 4A Soft Skills AF20'],
    ['Friday',    2, 'MRIIRS SMEH UG 2B Soft Skills FT09'],
    ['Friday',    5, 'MRIIRS BCOM 4B Verbal TT11'],
  ],
  'shivangeearora.cdc@mriu.edu.in': [
    ['Monday',    1, 'MRIIRS CSE 6C Verbal+Soft Skills'],
    ['Monday',    2, 'MRIIRS 6ECE-EE Verbal'],
    ['Monday',    4, 'MRU LAW 8B Soft Skills KF03'],
    ['Monday',    5, 'MRIIRS MBA 4B Soft Skills'],
    ['Monday',    6, 'MRIIRS MSc N&D+FST 2 Soft Skills'],
    ['Tuesday',   1, 'Kedge Class'],
    ['Tuesday',   2, 'MRIIRS MSc N&D+FST 2 Soft Skills'],
    ['Tuesday',   5, 'MRIIRS MBA 4B Soft Skills'],
    ['Tuesday',   6, 'MRIIRS SBSS UG 4B Soft Skills BS11'],
    ['Wednesday', 0, 'MRU CSE 4AIML B Soft Skills LF10'],
    ['Wednesday', 1, 'MRU CSE 4A Soft Skills LT03'],
    ['Wednesday', 2, 'MRU CSE 4B Soft Skills LS03'],
    ['Wednesday', 6, 'MRIIRS SMEH UG 4B Soft Skills'],
    ['Thursday',  0, 'MRU LAW 8B Soft Skills KF03'],
    ['Thursday',  1, 'MRU CSE 4A Soft Skills LT09'],
    ['Thursday',  2, 'MRU CSE 4B Soft Skills LT03'],
    ['Thursday',  5, 'MRIIRS BPT 4th Year Soft Skills'],
    ['Friday',    1, 'MRIIRS SBSS UG 4B Soft Skills BS11'],
    ['Friday',    4, 'MRIIRS SMEH UG 4B Soft Skills'],
    ['Friday',    5, 'MRU CSE 4AIML B Soft Skills LF03'],
  ],
  'priyasingh.cdc@mriu.edu.in': [
    ['Monday',    0, 'MRIIRS SET 2B Soft Skills CF07'],
    ['Monday',    1, 'MRIIRS SET 2H Soft Skills CF04'],
    ['Monday',    2, 'MRIIRS SET 2I Soft Skills CF05'],
    ['Monday',    4, 'MRU CSE 6A Verbal HF09'],
    ['Monday',    5, 'MRU CSE 6B Verbal HF10'],
    ['Tuesday',   0, 'MRIIRS CSE 6A Verbal+Soft Skills'],
    ['Tuesday',   1, 'MRIIRS CSE 6AIML B Verbal+Soft Skills'],
    ['Tuesday',   4, 'MRU CSE 6EC+ME Verbal'],
    ['Tuesday',   5, 'MRU CSE 6AIML C Verbal LS03'],
    ['Wednesday', 0, 'MRIIRS BCA 4D Soft Skills CT08'],
    ['Wednesday', 2, 'MRIIRS 6BT Verbal'],
    ['Wednesday', 5, 'MRIIRS BSc ID+Design 6A Soft Skills'],
    ['Thursday',  0, 'MRIIRS CSE 6SPL Verbal+Soft Skills'],
    ['Thursday',  1, 'MRIIRS CSE 6B Verbal+Soft Skills'],
    ['Thursday',  2, 'MRIIRS CSE 6BSML+DS Verbal+Soft Skills'],
    ['Thursday',  4, 'MRU CSE 6CSTI+R&I Verbal HT09'],
    ['Friday',    0, 'MRIIRS SET 2B Soft Skills'],
    ['Friday',    1, 'MRIIRS SET 2H Soft Skills'],
    ['Friday',    2, 'MRIIRS SET 2I Soft Skills'],
    ['Friday',    5, 'MRIIRS BSc ID+Design 6A Soft Skills'],
  ],
  'monikaaggarwal.cdc@mriu.edu.in': [
    ['Monday',    0, 'MRIIRS BDS 5 Soft Skills'],
    ['Monday',    1, 'MRIIRS BDS 5 Soft Skills'],
    ['Tuesday',   1, 'MRIIRS CSE 6D Verbal+Soft Skills AF13'],
    ['Tuesday',   4, 'MRIIRS CSE 6E Verbal+Soft Skills AS24'],
    ['Wednesday', 0, 'MRU CSE 4CSTI+FSD Soft Skills LT10'],
    ['Wednesday', 1, 'MRU CSE 6AIML B Verbal LS09'],
    ['Wednesday', 2, 'MRIIRS ME+Civil 6 Verbal CS20'],
    ['Thursday',  1, 'MRU LAW 6A Verbal GS03'],
    ['Thursday',  2, 'MRU LAW 6B Verbal GS04'],
    ['Friday',    0, 'MRU CSE 4CSTI+FSD Soft Skills LS03'],
    ['Friday',    1, 'MRIIRS MBA 2A Verbal'],
    ['Friday',    2, 'MRIIRS MBA 2B Verbal'],
  ],
  'swapnilvinod@mru.edu.in': [
    ['Monday',    0, 'MRIIRS CSE 6F Verbal+Soft Skills AF13'],
    ['Monday',    1, 'MRIIRS CSE 6AIML A Verbal+Soft Skills AF13'],
    ['Monday',    4, 'MRIIRS MCA 2A Soft Skills CS08'],
    ['Tuesday',   2, 'MRIIRS 6BT Soft Skills AT18'],
    ['Tuesday',   4, 'MRIIRS MCA 2B Verbal CS09'],
    ['Tuesday',   5, 'MRIIRS MCA 2A Soft Skills CS08'],
    ['Wednesday', 0, 'MRU CSE 2A Soft Skills KS02'],
    ['Wednesday', 1, 'MRU CSE 2B Soft Skills LS03'],
    ['Wednesday', 4, 'MBA 4A Soft Skills TF16'],
    ['Wednesday', 5, 'MRIIRS BCOM 4ACCA Verbal TT15'],
    ['Thursday',  0, 'MRU CSE 6C Verbal HT09'],
    ['Thursday',  1, 'MRU CSE 6AIML A Verbal LT03'],
    ['Friday',    0, 'MRU CSE 2A Soft Skills KS02'],
    ['Friday',    1, 'MRU CSE 2B Soft Skills KS02'],
    ['Friday',    4, 'MBA 4A Soft Skills TF15'],
    ['Friday',    5, 'MRIIRS BCOM 4ACCA Verbal TT15'],
  ],
  'avikchakraborty.cdc@mriu.edu.in': [
    ['Saturday',  3, 'MRIIRS BDS 3 Soft Skills QLT01'],
    ['Monday',    1, 'MRU CSE 2C Soft Skills KS02'],
    ['Monday',    4, 'MRIIRS BCOM 2B Soft Skills TT25'],
    ['Monday',    5, 'MRIIRS BSc N&D+FST 4 Soft Skills QS05'],
    ['Monday',    6, 'MRIIRS BSc N&D+FST 4 Soft Skills QS05'],
    ['Tuesday',   1, 'MRU CSE 2C Soft Skills KS02'],
    ['Tuesday',   2, 'MRU CSE 2FSD+AIML C Soft Skills LF09'],
    ['Tuesday',   5, 'MRIIRS 6ME+CIVIL Soft Skills CS20'],
    ['Tuesday',   6, 'MRIIRS SET 2E Soft Skills CS05'],
    ['Wednesday', 0, 'MRIIRS BCOM 2B Soft Skills TT25'],
    ['Wednesday', 1, 'MRIIRS BCOM 4A Verbal TT10'],
    ['Wednesday', 4, 'MRIIRS SBSS PG 2A Soft Skills BS09'],
    ['Wednesday', 6, 'MRIIRS MPT 1st Year Soft Skills QS11'],
    ['Thursday',  1, 'MRIIRS BCOM 4A Verbal TT10'],
    ['Thursday',  4, 'MRU CSE 2FSD+AIML C Soft Skills LF03'],
    ['Thursday',  5, 'MRIIRS BPT 1st Year Soft Skills QLT05'],
    ['Friday',    0, 'MRIIRS SET 2F Soft Skills CS20'],
    ['Friday',    1, 'MRIIRS SBSS PG 2A Soft Skills BS09'],
    ['Friday',    4, 'MRIIRS SET 2E Soft Skills CF05'],
    ['Friday',    7, 'MRIIRS SET 2F Soft Skills CS20'],
    ['Saturday',  3, 'MRIIRS BDS 3 Soft Skills QLT01'],
  ],
  'pranamika.cdc@mriu.edu.in': [
    ['Monday',    0, 'MRIIRS SMEH PG 2A Soft Skills FT03'],
    ['Monday',    1, 'MRIIRS SMEH UG 4A Soft Skills FS06'],
    ['Monday',    2, 'MRIIRS SMEH UG 2A Soft Skills FS07'],
    ['Monday',    5, 'MRIIRS BCA 4B+BSC IT Verbal CT07'],
    ['Monday',    6, 'MRIIRS BCA 4A Verbal CT05'],
    ['Tuesday',   0, 'MRIIRS SMEH PG 2A Soft Skills FT03'],
    ['Tuesday',   1, 'MRIIRS SMEH UG 4A Soft Skills FS06'],
    ['Tuesday',   2, 'MRIIRS SMEH UG 2A Soft Skills FS07'],
    ['Tuesday',   4, 'MRU MBA 2 Soft Skills ILG06'],
    ['Tuesday',   6, 'MRIIRS SBSS UG 2B Soft Skills BF08'],
    ['Wednesday', 0, 'MRIIRS HHA&CA 2 Soft Skills TG10'],
    ['Wednesday', 1, 'MRIIRS SBSS UG 2B Soft Skills BF08'],
    ['Wednesday', 4, 'MRIIRS BCA 4D Verbal CT06'],
    ['Wednesday', 5, 'MRIIRS BCA 4C Verbal CT08'],
    ['Thursday',  0, 'MRIIRS HHA&CA 2 Soft Skills TG11'],
    ['Thursday',  5, 'MRU MBA 2 Soft Skills ILG06'],
    ['Thursday',  6, 'MRIIRS HHA&CA 4 Soft Skills TG11'],
    ['Thursday',  7, 'MRIIRS HHA&CA 4 Soft Skills TG11'],
    ['Friday',    2, 'MRU LAW 10 Soft Skills GF01'],
    ['Friday',    5, 'MRU LAW 6B Soft Skills GS04'],
  ],
  'premaanand.cdc@mriu.edu.in': [
    ['Monday',    0, 'MRIIRS SET 2G Soft Skills CS05'],
    ['Monday',    1, 'MRIIRS SET 2M Soft Skills CG22'],
    ['Monday',    2, 'MRIIRS BCA 4C Soft Skills CT06'],
    ['Monday',    4, 'MRU LAW 8 Soft Skills KF02'],
    ['Monday',    5, 'MRU LAW 6A Soft Skills GS03'],
    ['Tuesday',   0, 'MRIIRS SET 2A Soft Skills CG27'],
    ['Tuesday',   1, 'MRIIRS SET 2C Soft Skills CF19'],
    ['Tuesday',   2, 'MRIIRS SET 2D Soft Skills CF17'],
    ['Tuesday',   4, 'MRIIRS SET 2 Microbiology Soft Skills AT20'],
    ['Wednesday', 0, 'MRIIRS SET 2G Soft Skills CS06'],
    ['Wednesday', 1, 'MRIIRS SET 2M Soft Skills CG22'],
    ['Wednesday', 4, 'MRIIRS SET 2 Microbiology Soft Skills AT20'],
    ['Wednesday', 6, 'MRIIRS BSc ID+Design 4A Soft Skills'],
    ['Thursday',  0, 'MRU LAW 8 Soft Skills KF02'],
    ['Thursday',  1, 'MRU LAW 2A Soft Skills GF03'],
    ['Thursday',  5, 'MRIIRS SET 2A Soft Skills CG27'],
    ['Thursday',  6, 'MRIIRS SET 2D Soft Skills CF17'],
    ['Thursday',  7, 'MRIIRS SET 2C Soft Skills CF19'],
    ['Friday',    2, 'MRU LAW 2A Soft Skills GF03'],
    ['Friday',    4, 'MRIIRS BSc ID+Design 4A Soft Skills'],
  ],
  'nitya.cdc@mriu.edu.in': [
    ['Monday',    0, 'MRIIRS SBSS UG 2C Soft Skills BG08'],
    ['Monday',    1, 'MRIIRS CSE 4B Soft Skills AF20'],
    ['Tuesday',   0, 'MRIIRS SBSS UG 2C Soft Skills BG08'],
    ['Tuesday',   1, 'MRIIRS CSE 4B Soft Skills AF23'],
    ['Tuesday',   2, 'MRIIRS CSE 4BSML Soft Skills AF23'],
    ['Wednesday', 0, 'MRIIRS 4ME+Civil Soft Skills CS18'],
    ['Wednesday', 1, 'MRIIRS 4ECE+EE Soft Skills AS25'],
    ['Wednesday', 2, 'MRIIRS 4BT+Micro Soft Skills AT17'],
    ['Wednesday', 4, 'MRIIRS MCA 2B Soft Skills CS09'],
    ['Thursday',  0, 'MRIIRS 4BT+Micro Soft Skills AT17'],
    ['Thursday',  1, 'MRIIRS 4ECE+EE Soft Skills AS25'],
    ['Thursday',  2, 'MRIIRS 4ME+Civil Soft Skills CS18'],
    ['Thursday',  4, 'MRIIRS CSE 4BSML Soft Skills AS12'],
  ],
  'vibha.cdc@mriu.edu.in': [
    ['Tuesday',   0, 'MRIIRS CSE 4SPL Soft Skills AS19'],
    ['Tuesday',   1, 'MRIIRS BCA 2C Soft Skills CT05'],
    ['Tuesday',   2, 'MRIIRS BCA 2C Soft Skills CT05'],
    ['Tuesday',   4, 'MRIIRS CSE 4E Soft Skills AF15'],
    ['Tuesday',   5, 'MRIIRS CSE 4AIML B Soft Skills AF21'],
    ['Wednesday', 0, 'MRIIRS CSE 4E Soft Skills AF13'],
    ['Wednesday', 1, 'MRIIRS CSE 4AIML A Soft Skills AF13'],
    ['Wednesday', 2, 'MRIIRS CSE 4AIML B Soft Skills AF13'],
    ['Wednesday', 5, 'MRU CSE 4AIML A Soft Skills LT03'],
    ['Thursday',  1, 'MRIIRS CSE 4AIML A Soft Skills AF20'],
    ['Thursday',  2, 'MRIIRS CSE 4SPL Soft Skills AS19'],
    ['Thursday',  4, 'MRU LAW 4A Soft Skills KF09'],
    ['Thursday',  5, 'MRU CSE 4AIML A Soft Skills KS09'],
  ],
  'aarti.cdc@mriu.edu.in': [
    ['Wednesday', 0, 'MRIIRS BCA 4A Soft Skills CT06'],
    ['Wednesday', 1, 'MRIIRS BCA 2B+BscIT Soft Skills CT04'],
    ['Wednesday', 2, 'MRIIRS BCA 2B+BscIT Soft Skills CT04'],
    ['Wednesday', 4, 'MRIIRS BCA 4B+BSC IT Soft Skills CT07'],
  ],
};

async function seed() {
  const client = await pool.connect();
  try {
    console.log('🔄 Creating schema...');
    await client.query(schema);
    console.log('✅ Schema created');

    console.log('🔄 Creating users...');
    const userMap = {};
    for (const t of trainers) {
      const hash = await bcrypt.hash(t.employee_id, 10);
      const r = await client.query(
        `INSERT INTO users (name,email,employee_id,password_hash,role,must_change_password)
         VALUES ($1,$2,$3,$4,$5,true) RETURNING id`,
        [t.name, t.email, t.employee_id, hash, t.role]
      );
      userMap[t.email] = r.rows[0].id;
      console.log(`  ✅ ${t.name}`);
    }
    console.log(`✅ ${trainers.length} users created`);

    console.log('🔄 Seeding timetable from Excel data...');
    let count = 0;
    for (const [email, slots] of Object.entries(rawTT)) {
      const trainerId = userMap[email];
      if (!trainerId) { console.warn(`  ⚠️ No user found for ${email}`); continue; }
      for (const [day, colIdx, cellVal] of slots) {
        const slotNum = COL_TO_SLOT[colIdx];
        if (!slotNum) continue; // skip lunch
        const parsed = parseCell(cellVal);
        if (!parsed) continue;
        await client.query(
          `INSERT INTO timetable (trainer_id,day,slot_number,class_name,session_type,room,institution)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (trainer_id,day,slot_number) DO UPDATE
           SET class_name=$4,session_type=$5,room=$6,institution=$7`,
          [trainerId, day, slotNum, parsed.class_name, parsed.session_type, parsed.room, parsed.institution]
        );
        count++;
      }
    }
    console.log(`✅ ${count} timetable entries seeded`);
    console.log('🎉 Database seeded successfully!');
    console.log('\n📋 Login: vipinyadav.cdc@mriu.edu.in / 4500466');
  } catch(e) {
    console.error('❌', e);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(console.error);
// Note: schema additions handled separately
