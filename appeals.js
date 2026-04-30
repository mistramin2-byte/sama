// routes/appeals.js — إدارة الطعون
const express = require('express');
const { query }  = require('../db');
const { authenticate, requireRole, logAudit } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ─── GET /api/appeals — جلب الطعون ──────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        let sql, params = [];

        if (req.user.role === 'student') {
            sql = `
                SELECT ap.id, ap.justification_id, ap.appeal_text, ap.status,
                       ap.created_at, ap.resolved_at,
                       j.review_notes AS rejection_reason,
                       a.absence_date, s.name_ar AS subject_name,
                       u.full_name_ar AS student_name
                FROM appeals ap
                JOIN justifications j ON ap.justification_id = j.id
                JOIN absences a        ON j.absence_id = a.id
                JOIN subjects s        ON a.subject_id = s.id
                JOIN users u           ON ap.student_id = u.id
                WHERE ap.student_id = $1
                ORDER BY ap.created_at DESC`;
            params = [req.user.id];
        } else {
            sql = `
                SELECT ap.id, ap.justification_id, ap.appeal_text, ap.status,
                       ap.created_at, ap.resolved_at,
                       j.review_notes AS rejection_reason,
                       a.absence_date, s.name_ar AS subject_name,
                       u.full_name_ar AS student_name, u.specialization AS student_specialty
                FROM appeals ap
                JOIN justifications j ON ap.justification_id = j.id
                JOIN absences a        ON j.absence_id = a.id
                JOIN subjects s        ON a.subject_id = s.id
                JOIN users u           ON ap.student_id = u.id
                ORDER BY ap.created_at DESC`;
        }

        const result = await query(sql, params);
        res.json({
            appeals: result.rows.map(ap => ({
                id:              ap.id,
                justificationId: ap.justification_id,
                appealText:      ap.appeal_text,
                status:          ap.status,
                rejectionReason: ap.rejection_reason || '',
                absenceDate:     ap.absence_date,
                subjectName:     ap.subject_name,
                studentName:     ap.student_name || '',
                createdAt:       ap.created_at,
                resolvedAt:      ap.resolved_at
            }))
        });
    } catch (err) {
        console.error('[GET /appeals]', err);
        res.status(500).json({ error: 'خطأ في جلب الطعون' });
    }
});

// ─── POST /api/appeals — تقديم طعن جديد (طالب) ─────────────────────────────
router.post('/', requireRole('student'), async (req, res) => {
    const { justification_id, appeal_text } = req.body;
    if (!justification_id || !appeal_text?.trim()) {
        return res.status(400).json({ error: 'معرف التبرير وسبب الطعن مطلوبان' });
    }

    try {
        // التحقق من أن التبرير مرفوض وينتمي للطالب
        const justCheck = await query(
            `SELECT id, status FROM justifications WHERE id = $1 AND student_id = $2`,
            [justification_id, req.user.id]
        );
        if (justCheck.rows.length === 0) {
            return res.status(404).json({ error: 'التبرير غير موجود' });
        }
        if (justCheck.rows[0].status !== 'rejected') {
            return res.status(400).json({ error: 'لا يمكن تقديم طعن إلا على التبريرات المرفوضة' });
        }

        // التحقق من عدم وجود طعن مسبق
        const existing = await query(
            'SELECT id FROM appeals WHERE justification_id = $1 AND student_id = $2',
            [justification_id, req.user.id]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'لقد قدّمت طعناً على هذا التبرير مسبقاً' });
        }

        const result = await query(
            `INSERT INTO appeals (justification_id, student_id, appeal_text)
             VALUES ($1, $2, $3) RETURNING *`,
            [justification_id, req.user.id, appeal_text.trim()]
        );

        await logAudit(req.user.id, 'APPEAL_SUBMITTED', 'appeals', result.rows[0].id, req, 201, {});
        res.status(201).json({ message: 'تم تقديم الطعن بنجاح', appeal: result.rows[0] });
    } catch (err) {
        console.error('[POST /appeals]', err);
        res.status(500).json({ error: 'خطأ في تقديم الطعن' });
    }
});

// ─── PUT /api/appeals/:id — تعديل طعن معلق (طالب) ──────────────────────────
router.put('/:id', requireRole('student'), async (req, res) => {
    const { appeal_text } = req.body;
    if (!appeal_text?.trim()) return res.status(400).json({ error: 'سبب الطعن مطلوب' });

    try {
        const existing = await query(
            'SELECT * FROM appeals WHERE id = $1 AND student_id = $2',
            [req.params.id, req.user.id]
        );
        if (existing.rows.length === 0) return res.status(404).json({ error: 'الطعن غير موجود' });
        if (existing.rows[0].status !== 'pending') return res.status(400).json({ error: 'لا يمكن تعديل طعن تمت مراجعته' });

        const result = await query(
            'UPDATE appeals SET appeal_text = $1 WHERE id = $2 RETURNING *',
            [appeal_text.trim(), req.params.id]
        );
        res.json({ message: 'تم تعديل الطعن', appeal: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في تعديل الطعن' });
    }
});

// ─── POST /api/appeals/:id/resolve — البت في الطعن (إدارة) ─────────────────
router.post('/:id/resolve', requireRole('admin'), async (req, res) => {
    const { decision } = req.body;
    if (!['accepted', 'rejected'].includes(decision)) {
        return res.status(400).json({ error: 'القرار يجب أن يكون accepted أو rejected' });
    }

    try {
        const appeal = await query('SELECT * FROM appeals WHERE id = $1', [req.params.id]);
        if (appeal.rows.length === 0) return res.status(404).json({ error: 'الطعن غير موجود' });

        await query(
            'UPDATE appeals SET status = $1, resolved_at = NOW(), resolved_by = $2 WHERE id = $3',
            [decision, req.user.id, req.params.id]
        );

        // إذا قُبل الطعن → نعيد التبرير لحالة accepted
        if (decision === 'accepted') {
            await query(
                'UPDATE justifications SET status = $1, review_notes = NULL WHERE id = $2',
                ['accepted', appeal.rows[0].justification_id]
            );
        }

        await logAudit(req.user.id, `APPEAL_${decision.toUpperCase()}`, 'appeals', req.params.id, req, 200, {});
        res.json({ message: decision === 'accepted' ? 'تم قبول الطعن' : 'تم رفض الطعن' });
    } catch (err) {
        console.error('[POST /appeals/:id/resolve]', err);
        res.status(500).json({ error: 'خطأ في البت في الطعن' });
    }
});

// ─── DELETE /api/appeals/:id — حذف طعن (إدارة أو الطالب لطعنه المعلق) ──────
router.delete('/:id', async (req, res) => {
    try {
        let sql, params;
        if (req.user.role === 'admin') {
            sql = 'DELETE FROM appeals WHERE id = $1 RETURNING id';
            params = [req.params.id];
        } else {
            sql = 'DELETE FROM appeals WHERE id = $1 AND student_id = $2 AND status = $3 RETURNING id';
            params = [req.params.id, req.user.id, 'pending'];
        }

        const result = await query(sql, params);
        if (result.rows.length === 0) return res.status(404).json({ error: 'الطعن غير موجود أو لا يمكن حذفه' });

        await logAudit(req.user.id, 'APPEAL_DELETED', 'appeals', req.params.id, req, 200, {});
        res.json({ message: 'تم حذف الطعن' });
    } catch (err) {
        res.status(500).json({ error: 'خطأ في حذف الطعن' });
    }
});

module.exports = router;