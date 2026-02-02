// API endpoint: /api/user/subscription.js
// Fetches user's subscription tier and usage data

import { sql } from '@vercel/postgres';
import { clerkClient } from '@clerk/backend';

export default async function handler(req, res) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get the authorization token from headers
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Verify the token with Clerk
    let userId;
    try {
      const decoded = await clerkClient.verifyToken(token);
      userId = decoded.sub;
    } catch (error) {
      console.error('Token verification failed:', error);
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get user data from Clerk
    const clerkUser = await clerkClient.users.getUser(userId);
    const userEmail = clerkUser.emailAddresses[0].emailAddress;

    // Check if user exists in database
    let dbUser = await sql`
      SELECT * FROM users WHERE clerk_user_id = ${userId}
    `;

    // If user doesn't exist in database yet, create them with Free tier defaults
    if (dbUser.rows.length === 0) {
      await sql`
        INSERT INTO users (clerk_user_id, email, tier, flows_this_month, total_flows)
        VALUES (${userId}, ${userEmail}, 'Free', 0, 0)
      `;
      
      // Fetch the newly created user
      dbUser = await sql`
        SELECT * FROM users WHERE clerk_user_id = ${userId}
      `;
    }

    const user = dbUser.rows[0];

    // Get user's recent flows (limit to last 5)
    const recentFlows = await sql`
      SELECT flow_name, created_at, status
      FROM flows
      WHERE user_id = ${user.id}
      ORDER BY created_at DESC
      LIMIT 5
    `;

    // Get subscription info if exists
    let subscription = null;
    const subResult = await sql`
      SELECT * FROM subscriptions
      WHERE user_id = ${user.id}
      AND status = 'active'
      LIMIT 1
    `;

    if (subResult.rows.length > 0) {
      subscription = subResult.rows[0];
    }

    // Return user data
    return res.status(200).json({
      tier: user.tier,
      flowsThisMonth: user.flows_this_month,
      totalFlows: user.total_flows,
      recentFlows: recentFlows.rows.map(flow => ({
        name: flow.flow_name,
        createdAt: flow.created_at,
        status: flow.status
      })),
      subscription: subscription ? {
        stripeSubscriptionId: subscription.stripe_subscription_id,
        currentPeriodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end
      } : null,
      limits: {
        Free: 3,
        Pro: 50,
        Enterprise: 999999
      }
    });

  } catch (error) {
    console.error('Error fetching user subscription:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}
