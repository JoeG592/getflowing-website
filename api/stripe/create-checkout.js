// Stripe Checkout & Subscription Management
// Path: /api/stripe/create-checkout.js

import Stripe from 'stripe';
import { createClient } from '@vercel/postgres';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId, priceId, tier } = req.body;

    if (!userId || !priceId || !tier) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const client = createClient();
    await client.connect();

    try {
      // Get user
      const userResult = await client.query(
        'SELECT * FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult.rows[0];

      // Create or retrieve Stripe customer
      let customerId = user.stripe_customer_id;

      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: {
            userId: user.id,
            clerkUserId: user.clerk_user_id
          }
        });
        customerId = customer.id;

        // Update user with Stripe customer ID
        await client.query(
          'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, userId]
        );
      }

      // Create checkout session
      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        payment_method_types: ['card'],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        mode: 'subscription',
        success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/pricing`,
        metadata: {
          userId: user.id,
          tier: tier
        }
      });

      return res.status(200).json({ 
        sessionId: session.id,
        url: session.url
      });

    } finally {
      await client.end();
    }

  } catch (error) {
    console.error('Stripe checkout error:', error);
    return res.status(500).json({ 
      error: 'Failed to create checkout session',
      message: error.message 
    });
  }
}
