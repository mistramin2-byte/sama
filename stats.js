// routes/stats.js — إحصائيات لوحة الإدارة
const express = require('express');
const { query }  = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('admin', 'professor'));

// ─── GET /api/stats — إحصائيات عامة ─────────────────────────────────────────
router.get('/', async (req, res) => {
    try {
        const [
            totalJusts, pendingJusts, acceptedJusts, rejectedJusts,
            totalAppeals, pendingAppeals,
            totalProfs, totalStudents, totalSpecs
        ] = await Promise.all([
            query('SELECT COUNT(*) FROM justifications'),
            query("SELECT COUNT(*) FROM justifications WHERE status = 'pending'"),
            query("SELECT COUNT(*) FROM justifications WHERE status = 'accepted'"),
            query("SELECT COUNT(*) FROM justifications WHERE status = 'rejected'"),
            query('SELECT COUNT(*) FROM appeals'),
            query("SELECT COUNT(*) FROM appeals WHERE status = 'pending'"),
            query("SELECT COUNT(*) FROM users WHERE role = 'professor' AND is_active = true"),
            query("SELECT COUNT(*) FROM users WHERE role = 'student' AND is_active = true"),
            query("SELECT COUNT(*) FROM specialties WHERE is_active = true")
        ]);

        const accept   = parseInt(acceptedJusts.rows[0].count);
        const reject   = parseInt(rejectedJusts.rows[0].count);
        const reviewed = accept + reject;
        const acceptanceRate = reviewed > 0 ? Math.round((accept / reviewed) * 100) : 0;

        const monthlyResult = await query(`
            SELECT TO_CHAR(DATE_TRUNC('month', submitted_at), 'YYYY-MM') AS month,
                   COUNT(*) AS count
            FROM justifications
            WHERE submitted_at >= NOW() - INTERVAL '6 months'
            GROUP BY month ORDER BY month
        `);

        const thisMonthResult = await query(`
            SELECT COUNT(*) FROM justifications
            WHERE submitted_at >= DATE_TRUNC('month', NOW())
        `);

        res.json({
            totalJustifications:    parseInt(totalJusts.rows[0].count),
            pendingJustifications:  parseInt(pendingJusts.rows[0].count),
            acceptedJustifications: accept,
            rejectedJustifications: reject,
            acceptanceRate,
            totalAppeals:     parseInt(totalAppeals.rows[0].count),
            pendingAppeals:   parseInt(pendingAppeals.rows[0].count),
            totalProfessors:  parseInt(totalProfs.rows[0].count),
            totalStudents:    parseInt(totalStudents.rows[0].count),
            totalSpecialties: parseInt(totalSpecs.rows[0].count),
            thisMonth:    parseInt(thisMonthResult.rows[0].count),
            monthlyData:  monthlyResult.rows
        });
    } catch (err) {
        console.error('[GET /stats]', err);
        res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
    }
});

module.exports = router;