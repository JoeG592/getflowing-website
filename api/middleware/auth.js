// Authentication middleware for protected API routes
// Path: /api/middleware/auth.js

import { createClient } from '@vercel/postgres';

export async function requireAuth(req) {
  // Get auth token from header
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('No authorization token provided');
  }

  const token = authHeader.substring(7);
  
  // Verify with Clerk (in production, use Clerk's verify function)
  // For now, we'll use a simple JWT decode
  // In production: import { verifyToken } from '@clerk/backend';
  
  try {
    // Decode the Clerk session token
    // const session = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    
    // For MVP, we'll extract user ID from a simpler token
    // TODO: Implement proper Clerk verification
    
    const userId = token; // Temporary - in production use Clerk session
    
    if (!userId) {
      throw new Error('Invalid token');
    }

    return userId;
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
}

export async function getUserFromDb(clerkUserId) {
  const client = createClient();
  await client.connect();

  try {
    const result = await client.query(
      'SELECT * FROM users WHERE clerk_user_id = $1',
      [clerkUserId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return result.rows[0];
  } finally {
    await client.end();
  }
}

export async function createOrUpdateUser(userData) {
  const client = createClient();
  await client.connect();

  try {
    const { clerkUserId, email, name } = userData;

    // Check if user exists
    const existingUser = await client.query(
      'SELECT * FROM users WHERE clerk_user_id = $1',
      [clerkUserId]
    );

    if (existingUser.rows.length > 0) {
      // Update existing user
      const result = await client.query(
        `UPDATE users 
         SET email = $2, name = $3, last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE clerk_user_id = $1
         RETURNING *`,
        [clerkUserId, email, name]
      );
      return result.rows[0];
    } else {
      // Create new user
      const result = await client.query(
        `INSERT INTO users (clerk_user_id, email, name, subscription_tier, flows_generated_this_month)
         VALUES ($1, $2, $3, 'free', 0)
         RETURNING *`,
        [clerkUserId, email, name]
      );
      
      // Log signup
      await client.query(
        'INSERT INTO usage_logs (user_id, action_type, metadata) VALUES ($1, $2, $3)',
        [result.rows[0].id, 'signup', JSON.stringify({ email, name })]
      );

      return result.rows[0];
    }
  } finally {
    await client.end();
  }
}

export async function checkUsageLimit(userId) {
  const client = createClient();
  await client.connect();

  try {
    const result = await client.query(
      'SELECT subscription_tier, flows_generated_this_month FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error('User not found');
    }

    const user = result.rows[0];
    const limits = {
      free: 3,
      pro: 50,
      enterprise: 999999
    };

    const limit = limits[user.subscription_tier] || 3;
    const remaining = limit - user.flows_generated_this_month;

    return {
      tier: user.subscription_tier,
      limit,
      used: user.flows_generated_this_month,
      remaining,
      canGenerate: remaining > 0
    };
  } finally {
    await client.end();
  }
}

export async function incrementFlowCount(userId) {
  const client = createClient();
  await client.connect();

  try {
    await client.query(
      `UPDATE users 
       SET flows_generated_this_month = flows_generated_this_month + 1,
           total_flows_generated = total_flows_generated + 1
       WHERE id = $1`,
      [userId]
    );
  } finally {
    await client.end();
  }
}
