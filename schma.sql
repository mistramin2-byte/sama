-- ============================================================
--   cleanup.sql — حذف جميع البيانات الوهمية
--   شغّله في pgAdmin مرة واحدة فقط
-- ============================================================

-- 1. حذف سجلات الأحداث
DELETE FROM audit_logs;

-- 2. حذف الطعون
DELETE FROM appeals;

-- 3. حذف التبريرات
DELETE FROM justifications;

-- 4. حذف الغيابات
DELETE FROM absences;

-- 5. حذف المواد الدراسية
DELETE FROM subjects;

-- 6. حذف Refresh Tokens
DELETE FROM refresh_tokens;

-- 7. حذف جميع المستخدمين ما عدا الإدارة
DELETE FROM users WHERE registration_number != 'FAC-INFO-01';

-- 8. التأكد من أن حساب الإدارة سليم
UPDATE users SET
    full_name_ar          = 'معهد العلوم',
    is_locked             = false,
    is_active             = true,
    failed_login_attempts = 0,
    password_hash         = '$2b$12$9SG1aKzeF1kbY0yo9t/coOyYucRxLjtcHp0HyLn6tgjWHkYUMCJJG'
WHERE registration_number = 'FAC-INFO-01';

-- 9. إصلاح قيد السنة الدراسية (يقبل 1-7)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_year_of_study_check;
ALTER TABLE users ADD CONSTRAINT users_year_of_study_check
    CHECK (year_of_study IS NULL OR (year_of_study >= 1 AND year_of_study <= 7));

-- تحقق من النتيجة النهائية
SELECT
    (SELECT COUNT(*) FROM users)          AS المستخدمون,
    (SELECT COUNT(*) FROM subjects)       AS المواد,
    (SELECT COUNT(*) FROM absences)       AS الغيابات,
    (SELECT COUNT(*) FROM justifications) AS التبريرات,
    (SELECT COUNT(*) FROM appeals)        AS الطعون;

SELECT registration_number, full_name_ar, role, is_active, is_locked
FROM users;