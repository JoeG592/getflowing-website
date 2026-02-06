// api/waitlist.js
// TenantSync Waitlist API - Collects email signups from tenantsync.io
// No auth required - public endpoint with bot protection
// Authors: Joe Green and Claude AI

export default async function handler(req, res) {
    // CORS - only allow from our domains
    const origin = req.headers.origin || '';
    const allowedOrigins = [
        'https://tenantsync.io',
        'https://www.tenantsync.io',
        'https://tenantsync-website.vercel.app',
        'http://localhost',
        'http://127.0.0.1'
    ];
    
    if (allowedOrigins.some(o => origin.startsWith(o))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        res.setHeader('Access-Control-Allow-Origin', 'https://www.tenantsync.io');
    }
    
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
            const { email, source, website } = req.body || {};

            // Honeypot: if 'website' field is filled, it's a bot
            if (website) {
                // Silently accept to not alert the bot
                return res.status(200).json({
                    success: true,
                    message: "You're on the list!"
                });
            }

            // Reject empty or missing email
            if (!email || typeof email !== 'string') {
                return res.status(400).json({ error: 'Valid email required' });
            }

            // Reject absurdly long input (bot payloads)
            if (email.length > 254) {
                return res.status(400).json({ error: 'Valid email required' });
            }

            // Email format validation
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
                return res.status(400).json({ error: 'Valid email required' });
            }

            // Block disposable email domains (common spam)
            const disposable = ['mailinator.com', 'guerrillamail.com', 'tempmail.com', 
                'throwaway.email', 'yopmail.com', 'sharklasers.com', 'guerrillamailblock.com',
                'grr.la', 'dispostable.com', '10minutemail.com', 'trashmail.com'];
            const domain = email.split('@')[1]?.toLowerCase();
            if (disposable.includes(domain)) {
                return res.status(400).json({ error: 'Please use a work or personal email' });
            }

            // Rate limit: max 5 signups per IP per hour
            const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() 
                || req.headers['x-real-ip'] 
                || 'unknown';
            const rateCheck = await sql`
                SELECT COUNT(*) as cnt FROM ts_waitlist 
                WHERE ip_address = ${ip} 
                AND created_at > NOW() - INTERVAL '1 hour'
            `;
            if (parseInt(rateCheck[0].cnt) >= 5) {
                return res.status(429).json({ error: 'Too many requests. Try again later.' });
            }

            // Normalize email
            const normalizedEmail = email.trim().toLowerCase();

            // Upsert - don't error on duplicate, just update timestamp
            const result = await sql`
                INSERT INTO ts_waitlist (email, source, ip_address, user_agent)
                VALUES (
                    ${normalizedEmail},
                    ${source || 'landing-page'},
                    ${ip},
                    ${(req.headers['user-agent'] || 'unknown').substring(0, 500)}
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
                SELECT id, email, source, ip_address, created_at, signup_count, contacted
                FROM ts_waitlist
                ORDER BY created_at DESC
                LIMIT 100
            `;

            const stats = await sql`
                SELECT 
                    COUNT(*) as total,
                    COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as last_24h,
                    COUNT(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN 1 END) as last_7d,
                    COUNT(CASE WHEN contacted = true THEN 1 END) as contacted
                FROM ts_waitlist
            `;

            return res.status(200).json({
                stats: stats[0],
                signups
            });
        }

        return res.status(405).json({ error: 'Method not allowed' });

    } catch (error) {
        console.error('Waitlist error:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
