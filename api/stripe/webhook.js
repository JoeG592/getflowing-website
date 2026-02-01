// Stripe Webhook Handler
// Path: /api/stripe/webhook.js

import Stripe from 'stripe';
import { createClient } from '@vercel/postgres';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

export const config = {
  api: {
    bodyParser: false,
  },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(buf, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const client = createClient();
  await client.connect();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { userId, tier } = session.metadata;

        // Get subscription details
        const subscription = await stripe.subscriptions.retrieve(session.subscription);

        // Create subscription record
        await client.query(
          `INSERT INTO subscriptions (
            user_id, stripe_subscription_id, stripe_price_id, tier, status,
            current_period_start, current_period_end
          ) VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7))`,
          [
            userId,
            subscription.id,
            subscription.items.data[0].price.id,
            tier,
            subscription.status,
            subscription.current_period_start,
            subscription.current_period_end
          ]
        );

        // Update user tier
        await client.query(
          'UPDATE users SET subscription_tier = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
          [tier, userId]
        );

        // Log event
        await client.query(
          'INSERT INTO usage_logs (user_id, action_type, metadata) VALUES ($1, $2, $3)',
          [userId, 'subscription_created', JSON.stringify({ tier, subscriptionId: subscription.id })]
        );

        console.log(`✅ Subscription created for user ${userId}: ${tier}`);
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;

        // Update subscription record
        await client.query(
          `UPDATE subscriptions 
           SET status = $1, current_period_end = to_timestamp($2), cancel_at_period_end = $3, updated_at = CURRENT_TIMESTAMP
           WHERE stripe_subscription_id = $4`,
          [
            subscription.status,
            subscription.current_period_end,
            subscription.cancel_at_period_end,
            subscription.id
          ]
        );

        console.log(`✅ Subscription updated: ${subscription.id}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;

        // Update subscription status
        await client.query(
          'UPDATE subscriptions SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE stripe_subscription_id = $2',
          ['canceled', subscription.id]
        );

        // Downgrade user to free tier
        const subResult = await client.query(
          'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1',
          [subscription.id]
        );

        if (subResult.rows.length > 0) {
          const userId = subResult.rows[0].user_id;
          await client.query(
            'UPDATE users SET subscription_tier = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            ['free', userId]
          );

          console.log(`✅ User ${userId} downgraded to free tier`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        console.log(`✅ Payment succeeded: ${invoice.id}`);
        
        // Could send receipt email here
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.log(`❌ Payment failed: ${invoice.id}`);
        
        // Could send payment failed email here
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });

  } catch (error) {
    console.error('Webhook handler error:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  } finally {
    await client.end();
  }
}
