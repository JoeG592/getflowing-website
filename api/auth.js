import { sql } from '@vercel/postgres';
import crypto from 'crypto';

// Simple cookie parser
function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  
  cookieHeader.split(';').forEach(cookie => {
    const [name, ...rest] = cookie.split('=');
    cookies[name.trim()] = rest.join('=').trim();
  });
  return cookies;
}

// Hash password
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// Verify password
function verifyPassword(password, storedHash) {
  try {
    const [salt, hash] = storedHash.split(':');
    const testHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
    return hash === testHash;
  } catch {
    return false;
  }
}

// Create simple token (just base64 encoded JSON - good enough for now)
function createToken(userId, email) {
  const payload = {
    userId,
    email,
    exp: Date.now() + (7 * 24 * 60 * 60 * 1000) // 7 days
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

// Verify token
function verifyToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action } = req.query;

  try {
    // SIGNUP
    if (action === 'signin' && req.method === 'POST') {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }

      const result = await sql`
        SELECT id, email, password_hash, name, tier
        FROM users
        WHERE email = ${email.toLowerCase()}
      `;
      
      const user = result.rows[0];
      
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const valid = verifyPassword(password, user.password_hash);
      
      if (!valid) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const token = createToken(user.id, user.email);
      res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);

      return res.status(200).json({
        success: true,
        user: { id: user.id, email: user.email, name: user.name, tier: user.tier }
      });
    }

    // SIGNUP
    if (action === 'signup' && req.method === 'POST') {
      const { email, password, name } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }

      if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }

      const hashedPassword = hashPassword(password);
      const userId = crypto.randomUUID();
      
      await sql`
        INSERT INTO users (id, email, password_hash, name, tier, created_at)
        VALUES (${userId}, ${email.toLowerCase()}, ${hashedPassword}, ${name || ''}, 'free', NOW())
      `;

      const token = createToken(userId, email.toLowerCase());
      res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);

      return res.status(200).json({
        success: true,
        user: { id: userId, email: email.toLowerCase(), name: name || '' }
      });
    }

    // SIGNOUT
    if (action === 'signout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'auth_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
      return res.status(200).json({ success: true });
    }

    // ME
    if (action === 'me' && req.method === 'GET') {
      const cookies = parseCookies(req.headers.cookie);
      const token = cookies.auth_token;
      
      if (!token) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      
      const payload = verifyToken(token);
      if (!payload) {
        return res.status(401).json({ error: 'Invalid token' });
      }
      
      const result = await sql`
        SELECT id, email, name, tier, created_at
        FROM users
        WHERE id = ${payload.userId}
      `;
      
      const user = result.rows[0];
      if (!user) {
        return res.status(401).json({ error: 'User not found' });
      }

      return res.status(200).json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tier: user.tier,
          createdAt: user.created_at
        }
      });
    }

    return res.status(404).json({ error: 'Not found' });

  } catch (error) {
    console.error('Auth error:', error);
    
    if (error.message && error.message.includes('duplicate key')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
}
