import { sql } from '@vercel/postgres';
import crypto from 'crypto';
import { SignJWT, jwtVerify } from 'jose';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'change-this-secret-key');

// Hash password
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// Verify password
function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  const testHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === testHash;
}

// Create JWT
async function createToken(userId, email) {
  const token = await new SignJWT({ userId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(JWT_SECRET);
  return token;
}

// Verify JWT
async function verifyToken(token) {
  try {
    const verified = await jwtVerify(token, JWT_SECRET);
    return verified.payload;
  } catch {
    return null;
  }
}

// SIGNUP HANDLER
async function handleSignup(req, res) {
  try {
    const { email, password, name } = req.body;

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

    const hashedPassword = hashPassword(password);
    const userId = crypto.randomUUID();
    
    await sql`
      INSERT INTO users (id, email, password_hash, name, tier, created_at)
      VALUES (${userId}, ${email.toLowerCase()}, ${hashedPassword}, ${name || ''}, 'free', NOW())
    `;

    const token = await createToken(userId, email.toLowerCase());
    res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);

    return res.status(200).json({
      success: true,
      user: { id: userId, email: email.toLowerCase(), name: name || '' }
    });
  } catch (error) {
    console.error('Signup error:', error);
    if (error.message && error.message.includes('duplicate key')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// SIGNIN HANDLER
async function handleSignin(req, res) {
  try {
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

    const token = await createToken(user.id, user.email);
    res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);

    return res.status(200).json({
      success: true,
      user: { id: user.id, email: user.email, name: user.name, tier: user.tier }
    });
  } catch (error) {
    console.error('Signin error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// SIGNOUT HANDLER
async function handleSignout(req, res) {
  res.setHeader('Set-Cookie', 'auth_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  return res.status(200).json({ success: true });
}

// ME HANDLER
async function handleMe(req, res) {
  try {
    const token = req.cookies?.auth_token;
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    
    const payload = await verifyToken(token);
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
  } catch (error) {
    console.error('Me error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// MAIN HANDLER - Routes based on URL
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Route based on query parameter
  const { action } = req.query;

  switch (action) {
    case 'signup':
      return handleSignup(req, res);
    case 'signin':
      return handleSignin(req, res);
    case 'signout':
      return handleSignout(req, res);
    case 'me':
      return handleMe(req, res);
    default:
      return res.status(404).json({ error: 'Not found' });
  }
}
