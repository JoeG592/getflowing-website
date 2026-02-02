// API endpoint: /api/stripe/create-portal-session.js
// Creates a Stripe Customer Portal session for subscription management

import Stripe from 'stripe';
import { sql } from '@vercel/postgres';
import { clerkClient } from '@clerk/backend';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get the authorization token from headers
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);

    // Verify the token with Clerk
    let userId;
    try {
      const decoded = await clerkClient.verifyToken(token);
      userId = decoded.sub;
    } catch (error) {
      console.error('Token verification failed:', error);
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get user from database
    const userResult = await sql`
      SELECT * FROM users WHERE clerk_user_id = ${userId}
    `;

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Check if user has an active subscription
    const subResult = await sql`
      SELECT * FROM subscriptions
      WHERE user_id = ${user.id}
      AND status = 'active'
      LIMIT 1
    `;

    if (subResult.rows.length === 0) {
      return res.status(400).json({ 
        error: 'No active subscription',
        message: 'You need an active subscription to manage billing'
      });
    }

    const subscription = subResult.rows[0];

    // Get the Stripe customer ID from the subscription
    // First, get the Stripe subscription to find the customer
    const stripeSubscription = await stripe.subscriptions.retrieve(
      subscription.stripe_subscription_id
    );

    // Create a Stripe Customer Portal session
    const session = await stripe.billingPortal.sessions.create({
      customer: stripeSubscription.customer,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/pages/dashboard.html`,
    });

    return res.status(200).json({ url: session.url });

  } catch (error) {
    console.error('Error creating portal session:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
}
