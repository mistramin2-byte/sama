-- ============================================================
--   schema.sql — إنشاء قاعدة بيانات UniAbsence من الصفر
--   شغّله في pgAdmin مرة واحدة على قاعدة بيانات فارغة
-- ============================================================

-- تفعيل uuid
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── جدول المستخدمين ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    registration_number   VARCHAR(50)  UNIQUE NOT NULL,
    password_hash         TEXT         NOT NULL,
    role                  VARCHAR(20)  NOT NULL CHECK (role IN ('admin','professor','student')),
    full_name_ar          VARCHAR(150) NOT NULL,
    email                 VARCHAR(150) UNIQUE,
    faculty_code          VARCHAR(20)  DEFAULT 'GEN',
    department            VARCHAR(100),
    specialization        VARCHAR(100),
    year_of_study         INTEGER      CHECK (year_of_study IS NULL OR (year_of_study >= 1 AND year_of_study <= 7)),
    is_active             BOOLEAN      DEFAULT TRUE,
    is_locked             BOOLEAN      DEFAULT FALSE,
    failed_login_attempts INTEGER      DEFAULT 0,
    last_login            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ  DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  DEFAULT NOW()
);

-- ─── جدول التخصصات ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS specialties (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name         VARCHAR(100) UNIQUE NOT NULL,
    faculty_code VARCHAR(20)  DEFAULT 'GEN',
    is_active    BOOLEAN      DEFAULT TRUE,
    created_at   TIMESTAMPTZ  DEFAULT NOW()
);

-- ─── جدول المواد الدراسية ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subjects (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code          VARCHAR(50)  UNIQUE NOT NULL,
    name_ar       VARCHAR(150) NOT NULL,
    professor_id  UUID         REFERENCES users(id) ON DELETE SET NULL,
    faculty_code  VARCHAR(20)  DEFAULT 'GEN',
    department    VARCHAR(100),
    semester      VARCHAR(10)  DEFAULT '1',
    academic_year VARCHAR(10)  DEFAULT '1',
    is_active     BOOLEAN      DEFAULT TRUE,
    created_at    TIMESTAMPTZ  DEFAULT NOW()
);

-- ─── جدول الغيابات ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS absences (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id    UUID        NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    absence_date  DATE        NOT NULL,
    session_type  VARCHAR(20) DEFAULT 'cours' CHECK (session_type IN ('cours','td','tp','exam')),
    session_time  VARCHAR(20),
    is_justified  BOOLEAN     DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─── جدول التبريرات ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS justifications (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    absence_id         UUID        NOT NULL REFERENCES absences(id) ON DELETE CASCADE,
    student_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text_content       TEXT,
    file_path          TEXT,
    file_original_name VARCHAR(255),
    file_type          VARCHAR(100),
    status             VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','info_requested')),
    submitted_at       TIMESTAMPTZ DEFAULT NOW(),
    reviewed_at        TIMESTAMPTZ,
    reviewed_by        UUID        REFERENCES users(id) ON DELETE SET NULL,
    review_notes       TEXT
);

-- ─── جدول الطعون ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS appeals (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    justification_id   UUID        NOT NULL REFERENCES justifications(id) ON DELETE CASCADE,
    student_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    appeal_text        TEXT        NOT NULL,
    status             VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
    created_at         TIMESTAMPTZ DEFAULT NOW(),
    resolved_at        TIMESTAMPTZ,
    resolved_by        UUID        REFERENCES users(id) ON DELETE SET NULL
);

-- ─── جدول Refresh Tokens ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT  NOT NULL UNIQUE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── جدول سجل الأحداث ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID         REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(80)  NOT NULL,
    resource    VARCHAR(50),
    resource_id VARCHAR(100),
    ip          VARCHAR(50),
    metadata    JSONB        DEFAULT '{}',
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ─── فهارس للأداء ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_absences_student   ON absences(student_id);
CREATE INDEX IF NOT EXISTS idx_absences_subject   ON absences(subject_id);
CREATE INDEX IF NOT EXISTS idx_justs_student      ON justifications(student_id);
CREATE INDEX IF NOT EXISTS idx_justs_status       ON justifications(status);
CREATE INDEX IF NOT EXISTS idx_appeals_student    ON appeals(student_id);
CREATE INDEX IF NOT EXISTS idx_audit_user         ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_users_reg          ON users(registration_number);

-- ─── حساب الإدارة الافتراضي ──────────────────────────────────────────────────
-- كلمة المرور: Admin@123456
INSERT INTO users (
    registration_number, password_hash, role,
    full_name_ar, email, faculty_code, is_active
) VALUES (
    'FAC-INFO-01',
    '$2b$12$9SG1aKzeF1kbY0yo9t/coOyYucRxLjtcHp0HyLn6tgjWHkYUMCJJG',
    'admin',
    'معهد العلوم',
    'admin@univ.dz',
    'GEN',
    true
) ON CONFLICT (registration_number) DO UPDATE SET
    is_active             = true,
    is_locked             = false,
    failed_login_attempts = 0;

-- ─── تحقق من النتيجة ─────────────────────────────────────────────────────────
SELECT 'تم إنشاء قاعدة البيانات بنجاح ✅' AS النتيجة;

SELECT registration_number, full_name_ar, role, is_active
FROM users;