-- ============================================================
-- ระบบเช็คชื่อผู้เรียน - วิทยาลัยอาชีวศึกษากาญจนบุรี
-- Database Schema for PostgreSQL
-- Version: 1.0
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. TEACHERS (ครูผู้สอน)
-- ============================================================
CREATE TABLE teachers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    line_user_id    VARCHAR(50) UNIQUE,              -- LINE User ID (U...)
    name            VARCHAR(100) NOT NULL,
    email           VARCHAR(100),
    phone           VARCHAR(20),
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert เชิดพงษ์ as first teacher
INSERT INTO teachers (line_user_id, name, email) VALUES
('U43dc8eaba35120851bc4fe413fde0900', 'เชิดพงษ์', 'teacher@kvc.ac.th');

COMMENT ON TABLE teachers IS 'ครูผู้สอนที่ใช้ระบบ';
COMMENT ON COLUMN teachers.line_user_id IS 'LINE User ID จาก LIFF getProfile()';

-- ============================================================
-- 2. STUDENTS (นักเรียน/นักศึกษา)
-- ============================================================
CREATE TABLE students (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_code    VARCHAR(20) UNIQUE NOT NULL,      -- รหัสนักศึกษา เช่น 6701
    line_user_id    VARCHAR(50) UNIQUE,               -- LINE User ID
    name            VARCHAR(100) NOT NULL,
    group_name      VARCHAR(20) NOT NULL,             -- เช่น ปวช.2/1
    education_level VARCHAR(10) NOT NULL DEFAULT 'ปวช.',  -- ปวช. / ปวส.
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_students_group ON students(group_name);
CREATE INDEX idx_students_line_uid ON students(line_user_id);

COMMENT ON TABLE students IS 'นักเรียน/นักศึกษา';
COMMENT ON COLUMN students.student_code IS 'รหัสนักศึกษาจากทะเบียน เช่น 6701';
COMMENT ON COLUMN students.group_name IS 'ห้องเรียน เช่น ปวช.2/1, ปวส.1/2';

-- ============================================================
-- 3. SUBJECTS (รายวิชา)
-- ============================================================
CREATE TABLE subjects (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject_code    VARCHAR(20) UNIQUE NOT NULL,      -- รหัสวิชา เช่น 30201-2102
    subject_name    VARCHAR(200) NOT NULL,
    credits         INTEGER DEFAULT 3,
    education_level VARCHAR(10),                      -- ปวช. / ปวส.
    teacher_id      UUID REFERENCES teachers(id) ON DELETE SET NULL,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert sample subjects
INSERT INTO subjects (subject_code, subject_name, credits, education_level, teacher_id) VALUES
('30201-2102', 'การประยุกต์โปรแกรมตารางงานเพื่อสารสนเทศทางบัญชี', 3, 'ปวช.',
    (SELECT id FROM teachers WHERE name = 'เชิดพงษ์')),
('30201-2003', 'การบัญชีต้นทุน 1', 3, 'ปวช.',
    (SELECT id FROM teachers WHERE name = 'เชิดพงษ์')),
('30201-2001', 'การบัญชีชั้นกลาง 1', 3, 'ปวช.',
    (SELECT id FROM teachers WHERE name = 'เชิดพงษ์'));

COMMENT ON TABLE subjects IS 'รายวิชาที่เปิดสอน';

-- ============================================================
-- 4. CLASSROOMS (ห้องเรียน + พิกัด GPS)
-- ============================================================
CREATE TABLE classrooms (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    room_name       VARCHAR(50) NOT NULL,             -- เช่น ห้อง 301
    building        VARCHAR(100),                     -- อาคาร
    floor           INTEGER,
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    allowed_radius_m INTEGER DEFAULT 100,             -- รัศมีที่อนุญาต (เมตร)
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Insert default classroom (วิทยาลัยอาชีวศึกษากาญจนบุรี)
INSERT INTO classrooms (room_name, building, latitude, longitude, allowed_radius_m) VALUES
('ห้อง 301', 'อาคารเรียน 3', 14.0208, 99.5322, 100),
('ห้อง 302', 'อาคารเรียน 3', 14.0208, 99.5322, 100),
('ห้อง 303', 'อาคารเรียน 3', 14.0208, 99.5322, 100);

COMMENT ON TABLE classrooms IS 'ห้องเรียนพร้อมพิกัด GPS สำหรับตรวจสอบตำแหน่ง';
COMMENT ON COLUMN classrooms.allowed_radius_m IS 'รัศมีอนุญาตจากจุดศูนย์กลาง (เมตร)';

-- ============================================================
-- 5. LINE_GROUPS (ไลน์กลุ่ม)
-- ============================================================
CREATE TABLE line_groups (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    line_group_id   VARCHAR(50) UNIQUE NOT NULL,      -- GROUP ID จาก LINE Platform
    group_name      VARCHAR(100),                     -- ชื่อกลุ่ม
    member_count    INTEGER DEFAULT 0,
    is_active       BOOLEAN DEFAULT TRUE,
    joined_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE line_groups IS 'ไลน์กลุ่มที่ Bot เข้าร่วม สำหรับส่ง QR Code';
COMMENT ON COLUMN line_groups.line_group_id IS 'Group ID ที่ได้จาก webhook event เมื่อ Bot เข้ากลุ่ม';

-- ============================================================
-- 6. SCHEDULES (ตารางสอน)
-- ============================================================
CREATE TABLE schedules (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subject_id          UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    teacher_id          UUID NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
    classroom_id        UUID NOT NULL REFERENCES classrooms(id) ON DELETE SET NULL,
    line_group_id       UUID REFERENCES line_groups(id) ON DELETE SET NULL,
    day_of_week         SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
                        -- 0=อาทิตย์, 1=จันทร์, ..., 6=เสาร์
    start_period        SMALLINT NOT NULL CHECK (start_period BETWEEN 1 AND 10),
    end_period          SMALLINT NOT NULL CHECK (end_period BETWEEN 1 AND 10),
    auto_send           BOOLEAN DEFAULT TRUE,          -- ส่ง QR อัตโนมัติ
    send_minutes_before INTEGER DEFAULT 5,             -- ส่งล่วงหน้ากี่นาที
    semester            VARCHAR(10) DEFAULT '1/2568',   -- ภาคเรียน
    is_active           BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT chk_period_order CHECK (end_period >= start_period)
);

CREATE INDEX idx_schedules_day ON schedules(day_of_week);
CREATE INDEX idx_schedules_teacher ON schedules(teacher_id);

COMMENT ON TABLE schedules IS 'ตารางสอน กำหนดว่าวิชาไหนสอนวันไหน คาบไหน ส่ง QR เข้ากลุ่มไหน';
COMMENT ON COLUMN schedules.auto_send IS 'ถ้า true ระบบจะสร้างและส่ง QR Code อัตโนมัติตามเวลา';

-- ============================================================
-- 7. PERIOD_TIMES (ตารางเวลาคาบเรียน)
-- ============================================================
CREATE TABLE period_times (
    period_number   SMALLINT PRIMARY KEY,
    start_time      TIME NOT NULL,
    end_time        TIME NOT NULL,
    CONSTRAINT chk_time_order CHECK (end_time > start_time)
);

INSERT INTO period_times (period_number, start_time, end_time) VALUES
(1, '08:30', '09:20'),
(2, '09:20', '10:10'),
(3, '10:20', '11:10'),
(4, '11:10', '12:00'),
(5, '13:00', '13:50'),
(6, '13:50', '14:40'),
(7, '14:50', '15:40'),
(8, '15:40', '16:30');

COMMENT ON TABLE period_times IS 'เวลาเริ่ม-สิ้นสุดของแต่ละคาบเรียน';

-- ============================================================
-- 8. QR_SESSIONS (QR Code ที่สร้างแต่ละครั้ง)
-- ============================================================
CREATE TABLE qr_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    schedule_id     UUID REFERENCES schedules(id) ON DELETE SET NULL,
    subject_id      UUID NOT NULL REFERENCES subjects(id),
    teacher_id      UUID NOT NULL REFERENCES teachers(id),
    line_group_id   UUID REFERENCES line_groups(id),
    token           VARCHAR(20) UNIQUE NOT NULL,       -- รหัส QR เช่น A1B2C3D4
    qr_type         VARCHAR(10) NOT NULL CHECK (qr_type IN ('check_in', 'check_out')),
    status          VARCHAR(15) DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
    sent_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
    session_date    DATE DEFAULT CURRENT_DATE,         -- วันที่ของ session
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_qr_token ON qr_sessions(token);
CREATE INDEX idx_qr_date ON qr_sessions(session_date);
CREATE INDEX idx_qr_schedule ON qr_sessions(schedule_id, session_date);

COMMENT ON TABLE qr_sessions IS 'QR Code ที่สร้างในแต่ละคาบ แยก check_in และ check_out';
COMMENT ON COLUMN qr_sessions.token IS 'รหัส 8 ตัวอักษร ที่ encode ใน QR Code';
COMMENT ON COLUMN qr_sessions.qr_type IS 'check_in = เข้าเรียน, check_out = หลังเรียน';

-- ============================================================
-- 9. ATTENDANCE_RECORDS (บันทึกการเช็คชื่อ)
-- ============================================================
CREATE TABLE attendance_records (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id      UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    qr_session_id   UUID NOT NULL REFERENCES qr_sessions(id) ON DELETE CASCADE,
    check_type      VARCHAR(10) NOT NULL CHECK (check_type IN ('check_in', 'check_out')),
    student_lat     DOUBLE PRECISION,                  -- พิกัดนักเรียนตอนเช็คชื่อ
    student_lng     DOUBLE PRECISION,
    distance_meters DOUBLE PRECISION,                  -- ระยะห่างจากห้องเรียน (เมตร)
    face_verified   BOOLEAN DEFAULT FALSE,
    face_confidence DOUBLE PRECISION,                  -- ความมั่นใจ 0-100%
    status          VARCHAR(10) DEFAULT 'present'
                    CHECK (status IN ('present', 'late', 'absent')),
    checked_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    synced_to_rms   BOOLEAN DEFAULT FALSE,             -- ส่งเข้า RMS แล้วหรือยัง
    rms_synced_at   TIMESTAMP WITH TIME ZONE,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_student_session UNIQUE (student_id, qr_session_id)
);

CREATE INDEX idx_attendance_student ON attendance_records(student_id);
CREATE INDEX idx_attendance_date ON attendance_records(checked_at);
CREATE INDEX idx_attendance_rms ON attendance_records(synced_to_rms) WHERE NOT synced_to_rms;

COMMENT ON TABLE attendance_records IS 'บันทึกการเช็คชื่อของนักเรียนแต่ละครั้ง';
COMMENT ON COLUMN attendance_records.distance_meters IS 'ระยะห่างที่คำนวณจาก Haversine formula';
COMMENT ON COLUMN attendance_records.face_confidence IS 'ความมั่นใจจาก face-api.js (0-100)';
COMMENT ON COLUMN attendance_records.synced_to_rms IS 'false = ยังไม่ส่ง RMS, true = ส่งแล้ว';

-- ============================================================
-- 10. FACE_EMBEDDINGS (ข้อมูลใบหน้าสำหรับ Face Recognition)
-- ============================================================
CREATE TABLE face_embeddings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id      UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    embedding_data  BYTEA NOT NULL,                    -- 128-dimension face descriptor จาก face-api.js
    photo_url       TEXT,                              -- URL รูปต้นฉบับ
    is_primary      BOOLEAN DEFAULT FALSE,             -- ใช้เป็นรูปหลักหรือไม่
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_face_student ON face_embeddings(student_id);

COMMENT ON TABLE face_embeddings IS 'เก็บ face descriptor 128 มิติจาก face-api.js สำหรับเปรียบเทียบใบหน้า';

-- ============================================================
-- 11. SYSTEM_LOGS (Log ระบบ)
-- ============================================================
CREATE TABLE system_logs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_type      VARCHAR(50) NOT NULL,              -- qr_sent, checkin_success, rms_sync, etc.
    event_data      JSONB,                             -- รายละเอียด
    teacher_id      UUID REFERENCES teachers(id),
    student_id      UUID REFERENCES students(id),
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_logs_type ON system_logs(event_type);
CREATE INDEX idx_logs_date ON system_logs(created_at);

COMMENT ON TABLE system_logs IS 'Log กิจกรรมทั้งหมดของระบบ';

-- ============================================================
-- VIEWS (มุมมองสำหรับ Query ง่าย)
-- ============================================================

-- มุมมอง: สรุปการเช็คชื่อรายวัน
CREATE VIEW daily_attendance_summary AS
SELECT
    qs.session_date,
    s.subject_name,
    qs.qr_type,
    COUNT(DISTINCT ar.student_id) AS total_checked,
    COUNT(DISTINCT ar.student_id) FILTER (WHERE ar.status = 'present') AS present_count,
    COUNT(DISTINCT ar.student_id) FILTER (WHERE ar.status = 'late') AS late_count,
    COUNT(DISTINCT ar.student_id) FILTER (WHERE ar.synced_to_rms = TRUE) AS synced_count
FROM qr_sessions qs
JOIN subjects s ON qs.subject_id = s.id
LEFT JOIN attendance_records ar ON ar.qr_session_id = qs.id
GROUP BY qs.session_date, s.subject_name, qs.qr_type
ORDER BY qs.session_date DESC, s.subject_name;

-- มุมมอง: รายชื่อที่ยังไม่ sync เข้า RMS
CREATE VIEW pending_rms_sync AS
SELECT
    ar.id AS record_id,
    st.student_code,
    st.name AS student_name,
    s.subject_code,
    s.subject_name,
    ar.check_type,
    ar.status,
    ar.checked_at
FROM attendance_records ar
JOIN students st ON ar.student_id = st.id
JOIN qr_sessions qs ON ar.qr_session_id = qs.id
JOIN subjects s ON qs.subject_id = s.id
WHERE ar.synced_to_rms = FALSE
ORDER BY ar.checked_at;

-- ============================================================
-- FUNCTIONS (ฟังก์ชันช่วย)
-- ============================================================

-- ฟังก์ชันคำนวณระยะห่าง Haversine (เมตร)
CREATE OR REPLACE FUNCTION haversine_distance(
    lat1 DOUBLE PRECISION, lng1 DOUBLE PRECISION,
    lat2 DOUBLE PRECISION, lng2 DOUBLE PRECISION
) RETURNS DOUBLE PRECISION AS $$
DECLARE
    r DOUBLE PRECISION := 6371000;  -- รัศมีโลก (เมตร)
    dlat DOUBLE PRECISION;
    dlng DOUBLE PRECISION;
    a DOUBLE PRECISION;
BEGIN
    dlat := RADIANS(lat2 - lat1);
    dlng := RADIANS(lng2 - lng1);
    a := SIN(dlat/2)^2 + COS(RADIANS(lat1)) * COS(RADIANS(lat2)) * SIN(dlng/2)^2;
    RETURN r * 2 * ATAN2(SQRT(a), SQRT(1-a));
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ฟังก์ชันสร้าง QR Token แบบสุ่ม
CREATE OR REPLACE FUNCTION generate_qr_token()
RETURNS VARCHAR(8) AS $$
DECLARE
    chars VARCHAR(36) := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  -- ไม่มี 0,O,1,I,L เลี่ยงอ่านผิด
    token VARCHAR(8) := '';
    i INTEGER;
BEGIN
    FOR i IN 1..8 LOOP
        token := token || SUBSTR(chars, FLOOR(RANDOM() * LENGTH(chars) + 1)::INT, 1);
    END LOOP;
    RETURN token;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ============================================================
-- TRIGGERS
-- ============================================================

-- อัปเดต updated_at อัตโนมัติ
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_teachers_updated
    BEFORE UPDATE ON teachers
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER trg_students_updated
    BEFORE UPDATE ON students
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER trg_schedules_updated
    BEFORE UPDATE ON schedules
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER trg_line_groups_updated
    BEFORE UPDATE ON line_groups
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();

CREATE TRIGGER trg_face_embeddings_updated
    BEFORE UPDATE ON face_embeddings
    FOR EACH ROW EXECUTE FUNCTION update_timestamp();

-- ============================================================
-- SAMPLE DATA (ข้อมูลตัวอย่าง)
-- ============================================================

-- นักเรียนตัวอย่าง
INSERT INTO students (student_code, name, group_name, education_level) VALUES
('6701', 'นายสมชาย ใจดี', 'ปวช.2/1', 'ปวช.'),
('6702', 'นางสาวสมหญิง รักเรียน', 'ปวช.2/1', 'ปวช.'),
('6703', 'นายวิชัย เก่งมาก', 'ปวช.2/1', 'ปวช.'),
('6704', 'นางสาวพิมพ์ใจ ศรีสุข', 'ปวช.2/1', 'ปวช.'),
('6705', 'นายธนกร สว่างใส', 'ปวช.2/1', 'ปวช.');

-- ============================================================
-- เสร็จสิ้น! Database พร้อมใช้งาน
-- ============================================================
