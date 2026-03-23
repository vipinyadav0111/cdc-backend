-- Sections table
CREATE TABLE IF NOT EXISTS sections (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  institution VARCHAR(20),
  branch VARCHAR(100),
  year INTEGER,
  semester INTEGER,
  domain VARCHAR(50),
  trainer_id INTEGER REFERENCES users(id),
  cr1_name VARCHAR(100),
  cr1_phone VARCHAR(20),
  cr2_name VARCHAR(100),
  cr2_phone VARCHAR(20),
  semester_start DATE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(name, domain, institution)
);

-- Students table
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  roll_no VARCHAR(50) NOT NULL,
  name VARCHAR(150) NOT NULL,
  section_id INTEGER REFERENCES sections(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(roll_no, section_id)
);

-- Attendance sessions (one per class conducted)
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id SERIAL PRIMARY KEY,
  section_id INTEGER REFERENCES sections(id) ON DELETE CASCADE,
  trainer_id INTEGER REFERENCES users(id),
  date DATE NOT NULL,
  slot_number INTEGER,
  domain VARCHAR(50),
  topic_covered VARCHAR(200),
  remarks TEXT,
  is_locked BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(section_id, date, slot_number)
);

-- Attendance records (one per student per session)
CREATE TABLE IF NOT EXISTS attendance_records (
  id SERIAL PRIMARY KEY,
  session_id INTEGER REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  status VARCHAR(10) DEFAULT 'A' CHECK (status IN ('P','A')),
  marked_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(session_id, student_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_attendance_records_student ON attendance_records(student_id);
CREATE INDEX IF NOT EXISTS idx_attendance_sessions_section ON attendance_sessions(section_id);
CREATE INDEX IF NOT EXISTS idx_students_section ON students(section_id);
CREATE INDEX IF NOT EXISTS idx_sections_trainer ON sections(trainer_id);
