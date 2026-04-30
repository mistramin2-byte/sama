// routes/justifications.js — التبريرات والغيابات
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { query, getClient } = require('../db');
const { authenticate, requireRole, logAudit } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─── إعداد multer لرفع الملفات ───────────────────────────────────────────────
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename:    (req, file, cb) => {
        const ext  = path.extname(file.originalname);
        const name = `just_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
        cb(null, name);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE) || 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
        allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('نوع الملف غير مدعوم'));
    }
});

// ─── دالة تنسيق التبرير ──────────────────────────────────────────────────────
function formatJust(row) {
    return {
        id:              row.id,
        studentId:       row.student_id,
        studentName:     row.student_name || '',
        studentSpecialty: row.student_specialty || '',
        absenceId:       row.absence_id,
        date:            row.absence_date ? new Date(row.absence_date).toISOString().slice(0, 10) : '',
        status:          row.status,
        notes:           row.text_content || '',
        fileName:        row.file_original_name || null,
        filePath:        row.file_path || null,
        fileType:        row.file_type || null,
        sessionType:     (row.session_type || '').toLowerCase(),
        sessionTypeLabel: { cours: 'Cours (محاضرة)', td: 'TD (أعمال موجهة)', tp: 'TP (أعمال تطبيقية)', exam: 'Exam (امتحان)' }[(row.session_type || '').toLowerCase()] || row.session_type || '',
        timeFrom:        row.session_time ? row.session_time.split('-')[0] : '',
        timeTo:          row.session_time ? row.session_time.split('-')[1] || '' : '',
        sessions:        row.sessions || [],
        rejectionReason: row.review_notes || '',
        hasAppeal:       row.has_appeal || false,
        appealStatus:    row.appeal_status || null,
        appealReason:    row.appeal_text || '',
        submittedAt:     row.submitted_at,
        reviewedAt:      row.reviewed_at,
        reviewedBy:      row.reviewer_name || null,
        submissionAttempt: row.submission_attempt || 1
    };
}

// ─── GET /api/justifications — قائمة التبريرات ──────────────────────────────
router.get('/', async (req, res) => {
    try {
        const { status, specialty, student_id } = req.query;
        let conditions = ['1=1'];
        const params   = [];

        if (req.user.role === 'student') {
            params.push(req.user.id);
            conditions.push(`j.student_id = $${params.length}`);
        } else if (req.user.role === 'professor') {
            params.push(req.user.id);
            conditions.push(`s.professor_id = $${params.length}`);
        } else {
            if (student_id) { params.push(student_id); conditions.push(`j.student_id = $${params.length}`); }
            if (specialty)  { params.push(specialty);  conditions.push(`u.specialization = $${params.length}`); }
        }

        if (status && status !== 'all') {
            params.push(status); conditions.push(`j.status = $${params.length}`);
        }

        const sql = `
            SELECT j.*, a.absence_date, a.session_type, a.session_time, a.notes AS absence_notes,
                   u.full_name_ar AS student_name, u.specialization AS student_specialty,
                   s.name_ar AS subject_name, s.id AS subject_id,
                   rev.full_name_ar AS reviewer_name,
                   ap.status AS appeal_status, ap.appeal_text,
                   (ap.id IS NOT NULL) AS has_appeal
            FROM justifications j
            JOIN absences a     ON j.absence_id   = a.id
            JOIN users u        ON j.student_id   = u.id AND u.is_active = true
            JOIN subjects s     ON a.subject_id   = s.id
            LEFT JOIN users rev ON j.reviewed_by  = rev.id
            LEFT JOIN appeals ap ON ap.justification_id = j.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY j.submitted_at DESC NULLS LAST, j.id DESC
        `;

        const result = await query(sql, params);

        const map = new Map();
        for (const row of result.rows) {
            const key = row.id;
            if (!map.has(key)) {
                map.set(key, { ...formatJust(row), sessions: [] });
            }
            if (row.subject_name) {
                map.get(key).sessions.push({ subject: row.subject_name, subjectId: row.subject_id });
            }
        }

        res.json({ justifications: Array.from(map.values()) });
    } catch (err) {
        console.error('[GET /justifications]', err);
        res.status(500).json({ error: 'خطأ في جلب التبريرات' });
    }
});

// ─── POST /api/justifications — تقديم تبرير جديد ─────────────────────────────
router.post('/', requireRole('student'), upload.single('file'), async (req, res) => {
    const client = await getClient();
    try {
        await client.query('BEGIN');

        const { date, sessions, notes, session_type, time_from, time_to } = req.body;
        const sessionsArr = typeof sessions === 'string' ? JSON.parse(sessions) : (sessions || []);

        if (!date) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'التاريخ مطلوب' });
        }
        if (!sessionsArr || sessionsArr.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'يجب اختيار مادة واحدة على الأقل' });
        }

        // ✅ إزالة قيد المهلة (7 أيام) — الطلاب يمكنهم التقديم في أي وقت
        // const absDate  = new Date(date);
        // const diffDays = (new Date() - absDate) / (1000 * 60 * 60 * 24);
        // if (diffDays > 7) { ... }

        const sessionTime = (time_from && time_to) ? `${time_from}-${time_to}` : null;
        const absenceIds  = [];

        // ✅ تطبيع نوع الحصة وقبول كل القيم الممكنة
        const VALID_SESSION_TYPES = ['cours', 'td', 'tp', 'exam'];
        const normalizedSessionType = VALID_SESSION_TYPES.includes((session_type || '').toLowerCase())
            ? session_type.toLowerCase()
            : 'cours';

        for (const sess of sessionsArr) {
            const subResult = await client.query(
                'SELECT id FROM subjects WHERE name_ar = $1 AND is_active = true LIMIT 1',
                [sess.subject]
            );
            if (subResult.rows.length === 0) continue;
            const subjectId = subResult.rows[0].id;

            // ✅ إصلاح: البحث عن غياب موجود وتحديثه بنوع الحصة الصحيح
            let absResult = await client.query(
                'SELECT id FROM absences WHERE student_id=$1 AND subject_id=$2 AND absence_date=$3',
                [req.user.id, subjectId, date]
            );

            if (absResult.rows.length === 0) {
                // إنشاء غياب جديد
                absResult = await client.query(
                    `INSERT INTO absences (student_id, subject_id, recorded_by, absence_date, session_type, session_time, notes)
                     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
                    [req.user.id, subjectId, req.user.id, date, normalizedSessionType, sessionTime, notes || null]
                );
            } else {
                // ✅ تحديث نوع الحصة والوقت للغياب الموجود
                await client.query(
                    `UPDATE absences SET session_type=$1, session_time=$2, notes=$3 WHERE id=$4`,
                    [normalizedSessionType, sessionTime, notes || null, absResult.rows[0].id]
                );
            }
            absenceIds.push(absResult.rows[0].id);
        }

        if (absenceIds.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'لم يتم العثور على المواد المحددة' });
        }

        // ✅ التحقق من وجود تبرير سابق لنفس الغياب
        const existingJust = await client.query(
            'SELECT id FROM justifications WHERE absence_id = $1 AND student_id = $2',
            [absenceIds[0], req.user.id]
        );

        let justResult;
        if (existingJust.rows.length > 0) {
            // تحديث التبرير الموجود
            justResult = await client.query(
                `UPDATE justifications
                 SET text_content=$1, file_path=COALESCE($2, file_path),
                     file_original_name=COALESCE($3, file_original_name),
                     file_type=COALESCE($4, file_type),
                     file_size=COALESCE($5, file_size),
                     submission_attempt=submission_attempt+1,
                     status='pending'
                 WHERE id=$6 RETURNING *`,
                [
                    notes || null,
                    req.file?.filename || null,
                    req.file?.originalname || null,
                    req.file?.mimetype || null,
                    req.file?.size || null,
                    existingJust.rows[0].id
                ]
            );
        } else {
            // إنشاء تبرير جديد
            justResult = await client.query(
                `INSERT INTO justifications (absence_id, student_id, text_content, file_path, file_original_name, file_type, file_size, submitted_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7, NOW()) RETURNING *`,
                [
                    absenceIds[0], req.user.id, notes || null,
                    req.file?.filename || null,
                    req.file?.originalname || null,
                    req.file?.mimetype || null,
                    req.file?.size || null
                ]
            );
        }

        await client.query('COMMIT');
        await logAudit(req.user.id, 'JUSTIFICATION_SUBMITTED', 'justifications', justResult.rows[0].id, req, 201, {});

        // جلب بيانات الغياب المحفوظة لضمان صحة session_type
        const absRow = await query(
            'SELECT session_type, session_time FROM absences WHERE id = $1',
            [absenceIds[0]]
        );
        const savedSessionType = absRow.rows[0]?.session_type || session_type || 'cours';
        const savedSessionTime = absRow.rows[0]?.session_time || null;

        res.status(201).json({
            message: 'تم تقديم التبرير بنجاح',
            justification: formatJust({
                ...justResult.rows[0],
                absence_date:  new Date(date),
                session_type:  savedSessionType,
                session_time:  savedSessionTime,
                sessions:      sessionsArr
            })
        });
    } catch (err) {
        await client.query('ROLLBACK');
        if (req.file) fs.unlink(path.join(UPLOAD_DIR, req.file.filename), () => {});
        console.error('[POST /justifications]', err);
        res.status(500).json({ error: 'خطأ في تقديم التبرير' });
    } finally {
        client.release();
    }
});

// ─── PUT /api/justifications/:id — تعديل تبرير معلق (طالب) ──────────────────
router.put('/:id', requireRole('student'), upload.single('file'), async (req, res) => {
    try {
        const just = await query(
            'SELECT * FROM justifications WHERE id = $1 AND student_id = $2',
            [req.params.id, req.user.id]
        );
        if (just.rows.length === 0) return res.status(404).json({ error: 'التبرير غير موجود' });
        if (!['pending', 'info_requested'].includes(just.rows[0].status)) {
            return res.status(400).json({ error: 'لا يمكن تعديل هذا التبرير' });
        }

        const { notes, session_type, time_from, time_to } = req.body;
        const sessionTime = (time_from && time_to) ? `${time_from}-${time_to}` : null;

        await query(
            'UPDATE absences SET session_type=COALESCE($1,session_type), session_time=COALESCE($2,session_time) WHERE id=$3',
            [session_type, sessionTime, just.rows[0].absence_id]
        );

        let fileSql = '';
        const fileParams = [];
        if (req.file) {
            if (just.rows[0].file_path) {
                fs.unlink(path.join(UPLOAD_DIR, just.rows[0].file_path), () => {});
            }
            fileSql = ', file_path=$3, file_original_name=$4, file_type=$5, file_size=$6';
            fileParams.push(req.file.filename, req.file.originalname, req.file.mimetype, req.file.size);
        }

        const result = await query(
            `UPDATE justifications SET text_content=$1, submission_attempt=submission_attempt+1 ${fileSql}
             WHERE id=$2 RETURNING *`,
            [notes || just.rows[0].text_content, req.params.id, ...fileParams]
        );

        res.json({ message: 'تم تحديث التبرير', justification: result.rows[0] });
    } catch (err) {
        console.error('[PUT /justifications/:id]', err);
        res.status(500).json({ error: 'خطأ في تحديث التبرير' });
    }
});

// ─── POST /api/justifications/:id/review — مراجعة تبرير (أستاذ/إدارة) ───────
router.post('/:id/review', requireRole('professor', 'admin'), async (req, res) => {
    const { decision, notes } = req.body;
    if (!['accepted', 'rejected', 'info_requested'].includes(decision))
        return res.status(400).json({ error: 'قرار غير صالح' });

    try {
        if (req.user.role === 'professor') {
            const check = await query(
                `SELECT j.id FROM justifications j JOIN absences a ON j.absence_id=a.id JOIN subjects s ON a.subject_id=s.id
                 WHERE j.id=$1 AND s.professor_id=$2`,
                [req.params.id, req.user.id]
            );
            if (check.rows.length === 0) return res.status(403).json({ error: 'غير مصرح لك بمراجعة هذا التبرير' });
        }

        const result = await query(
            `UPDATE justifications SET status=$1, reviewed_at=NOW(), reviewed_by=$2, review_notes=$3
             WHERE id=$4 RETURNING *`,
            [decision, req.user.id, notes || null, req.params.id]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: 'التبرير غير موجود' });

        // تحويل قرار التبرير إلى حالة الغياب المناسبة
        const absenceStatus = decision === 'accepted'
            ? 'justified'
            : decision === 'rejected'
                ? 'unjustified'
                : 'pending';   // info_requested
        await query('UPDATE absences SET status=$1 WHERE id=$2', [absenceStatus, result.rows[0].absence_id]);

        await logAudit(req.user.id, `JUSTIFICATION_${decision.toUpperCase()}`, 'justifications', req.params.id, req, 200, { notes });
        res.json({ message: 'تم تحديث القرار', justification: result.rows[0] });
    } catch (err) {
        console.error('[POST /justifications/:id/review]', err);
        res.status(500).json({ error: 'خطأ في مراجعة التبرير' });
    }
});

// ─── DELETE /api/justifications/:id — حذف تبرير (إدارة) ─────────────────────
router.delete('/:id', requireRole('admin'), async (req, res) => {
    try {
        const just = await query('SELECT file_path FROM justifications WHERE id=$1', [req.params.id]);
        if (just.rows.length === 0) return res.status(404).json({ error: 'التبرير غير موجود' });
        if (just.rows[0].file_path) {
            fs.unlink(path.join(UPLOAD_DIR, just.rows[0].file_path), () => {});
        }
        await query('DELETE FROM justifications WHERE id=$1', [req.params.id]);
        await logAudit(req.user.id, 'JUSTIFICATION_DELETED', 'justifications', req.params.id, req, 200, {});
        res.json({ message: 'تم حذف التبرير' });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في حذف التبرير' });
    }
});

// ─── GET /api/justifications/:id/file — تحميل ملف التبرير ───────────────────
router.get('/:id/file', async (req, res) => {
    try {
        const just = await query(
            'SELECT j.file_path, j.file_original_name, j.file_type, j.student_id FROM justifications j WHERE j.id=$1',
            [req.params.id]
        );
        if (just.rows.length === 0 || !just.rows[0].file_path)
            return res.status(404).json({ error: 'الملف غير موجود' });

        if (req.user.role === 'student' && just.rows[0].student_id !== req.user.id)
            return res.status(403).json({ error: 'غير مصرح' });

        const filePath = path.resolve(UPLOAD_DIR, just.rows[0].file_path);
        if (!fs.existsSync(filePath))
            return res.status(404).json({ error: 'الملف غير موجود على الخادم' });

        const mimeType = just.rows[0].file_type || 'application/octet-stream';
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(just.rows[0].file_original_name || 'document')}"`);
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.sendFile(filePath, { root: '/' });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في تحميل الملف' });
    }
});

module.exports = router;