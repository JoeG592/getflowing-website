import { sql } from '@vercel/postgres';
import crypto from 'crypto';
import { SignJWT } from 'jose';

// Hash password
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// Create JWT
async function createToken(userId, email) {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET || 'change-this-secret-key');
  const token = await new SignJWT({ userId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
  return token;
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, password, name } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Create user
    const hashedPassword = hashPassword(password);
    const userId = crypto.randomUUID();
    
    await sql`
      INSERT INTO users (id, email, password_hash, name, tier, created_at)
      VALUES (${userId}, ${email.toLowerCase()}, ${hashedPassword}, ${name || ''}, 'free', NOW())
    `;

    // Create token
    const token = await createToken(userId, email.toLowerCase());

    // Set cookie
    res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);

    return res.status(200).json({
      success: true,
      user: {
        id: userId,
        email: email.toLowerCase(),
        name: name || ''
      }
    });
  } catch (error) {
    console.error('Signup error:', error);
    
    if (error.message && error.message.includes('duplicate key')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    
    return res.status(500).json({ error: 'Internal server error' });
  }
}
