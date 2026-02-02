// Authentication utilities for Get Flowing
import { SignJWT, jwtVerify } from 'jose';
import { sql } from '@vercel/postgres';
import crypto from 'crypto';

const JWT_SECRET = new TextEncoder().encode(process.env.JWT_SECRET || 'your-secret-key-change-this');

// Hash password with salt
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// Verify password
export function verifyPassword(password, storedHash) {
  const [salt, hash] = storedHash.split(':');
  const testHash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return hash === testHash;
}

// Create JWT token
export async function createToken(userId, email) {
  const token = await new SignJWT({ userId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d') // Token valid for 7 days
    .sign(JWT_SECRET);
  return token;
}

// Verify JWT token
export async function verifyToken(token) {
  try {
    const verified = await jwtVerify(token, JWT_SECRET);
    return verified.payload;
  } catch (error) {
    return null;
  }
}

// Create user in database
export async function createUser(email, password, name = '') {
  const hashedPassword = hashPassword(password);
  const userId = crypto.randomUUID();
  
  try {
    await sql`
      INSERT INTO users (id, email, password_hash, name, tier, created_at)
      VALUES (${userId}, ${email}, ${hashedPassword}, ${name}, 'free', NOW())
    `;
    return { success: true, userId };
  } catch (error) {
    if (error.message.includes('duplicate key')) {
      return { success: false, error: 'Email already exists' };
    }
    return { success: false, error: 'Failed to create user' };
  }
}

// Get user by email
export async function getUserByEmail(email) {
  const result = await sql`
    SELECT id, email, password_hash, name, tier, created_at
    FROM users
    WHERE email = ${email}
  `;
  return result.rows[0] || null;
}

// Get user by ID
export async function getUserById(userId) {
  const result = await sql`
    SELECT id, email, name, tier, created_at
    FROM users
    WHERE id = ${userId}
  `;
  return result.rows[0] || null;
}

// Get user from request
export async function getUserFromRequest(req) {
  const token = req.cookies?.auth_token;
  if (!token) return null;
  
  const payload = await verifyToken(token);
  if (!payload) return null;
  
  return await getUserById(payload.userId);
}
