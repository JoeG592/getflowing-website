// api/waitlist.js
// TenantSync Waitlist API - Collects email signups from tenantsync.io
// No auth required - public endpoint
// Authors: Joe Green and Claude AI

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const { neon } = await import('@neondatabase/serverless');
        const sql = neon(process.env.DATABASE_URL);

        // POST = new signup
        if (req.method === 'POST') {
            const { email, source } = req.body || {};

            if (!email || !email.includes('@')) {
                return res.status(400).json({ error: 'Valid email required' });
            }

            // Normalize email
            const normalizedEmail = email.trim().toLowerCase();

            // Upsert - don't error on duplicate, just update timestamp
            const result = await sql`
                INSERT INTO ts_waitlist (email, source, ip_address, user_agent)
                VALUES (
                    ${normalizedEmail},
                    ${source || 'landing-page'},
                    ${req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown'},
                    ${req.headers['user-agent'] || 'unknown'}
                )
                ON CONFLICT (email) DO UPDATE SET
                    updated_at = NOW(),
                    signup_count = ts_waitlist.signup_count + 1
                RETURNING id, email, created_at
            `;

            return res.status(200).json({
                success: true,
                message: "You're on the list!",
                signup: {
                    email: result[0].email,
                    created_at: result[0].created_at
                }
            });
        }

        // GET = list signups (protected by simple secret)
        if (req.method === 'GET') {
            const secret = req.query.secret;
            if (secret !== process.env.WAITLIST_SECRET) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const signups = await sql`
                SELECT id, email, source, created_at, signup_count
                FROM ts_waitlist
                ORDER BY created_at DESC
                LIMIT 100
            `;

            return res.status(200).json({
                total: signups.length,
                signups
            });
        }

        return res.status(405).json({ error: 'Method not allowed' });

    } catch (error) {
        console.error('Waitlist error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
