-- GET FLOWING COMPLETE DATABASE SCHEMA
-- Vercel Postgres / PostgreSQL

-- Users table
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id VARCHAR(255) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255),
  subscription_tier VARCHAR(50) DEFAULT 'free',
  flows_generated_this_month INTEGER DEFAULT 0,
  total_flows_generated INTEGER DEFAULT 0,
  stripe_customer_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP,
  is_active BOOLEAN DEFAULT true
);

-- Subscriptions table
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id VARCHAR(255) UNIQUE,
  stripe_price_id VARCHAR(255),
  tier VARCHAR(50) NOT NULL,
  status VARCHAR(50) DEFAULT 'active',
  current_period_start TIMESTAMP,
  current_period_end TIMESTAMP,
  cancel_at_period_end BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Flows table
CREATE TABLE flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  flow_name VARCHAR(255),
  prompt TEXT NOT NULL,
  generated_json JSONB,
  tokens_used INTEGER,
  generation_time_seconds DECIMAL(10,2),
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Usage logs table
CREATE TABLE usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  action_type VARCHAR(100) NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Admin metrics table (for quick dashboard queries)
CREATE TABLE daily_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE UNIQUE NOT NULL,
  total_users INTEGER DEFAULT 0,
  active_users INTEGER DEFAULT 0,
  new_signups INTEGER DEFAULT 0,
  total_flows INTEGER DEFAULT 0,
  total_revenue DECIMAL(10,2) DEFAULT 0,
  mrr DECIMAL(10,2) DEFAULT 0,
  free_tier_users INTEGER DEFAULT 0,
  pro_tier_users INTEGER DEFAULT 0,
  enterprise_tier_users INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_users_clerk_id ON users(clerk_user_id);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_tier ON users(subscription_tier);
CREATE INDEX idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX idx_subscriptions_stripe_id ON subscriptions(stripe_subscription_id);
CREATE INDEX idx_flows_user_id ON flows(user_id);
CREATE INDEX idx_flows_created_at ON flows(created_at);
CREATE INDEX idx_usage_logs_user_id ON usage_logs(user_id);
CREATE INDEX idx_usage_logs_created_at ON usage_logs(created_at);
CREATE INDEX idx_daily_metrics_date ON daily_metrics(date);

-- Function to reset monthly flow counts (run on 1st of each month)
CREATE OR REPLACE FUNCTION reset_monthly_flows()
RETURNS void AS $$
BEGIN
  UPDATE users SET flows_generated_this_month = 0;
END;
$$ LANGUAGE plpgsql;

-- Function to update daily metrics
CREATE OR REPLACE FUNCTION update_daily_metrics()
RETURNS void AS $$
BEGIN
  INSERT INTO daily_metrics (
    date,
    total_users,
    active_users,
    new_signups,
    total_flows,
    free_tier_users,
    pro_tier_users,
    enterprise_tier_users
  )
  VALUES (
    CURRENT_DATE,
    (SELECT COUNT(*) FROM users WHERE is_active = true),
    (SELECT COUNT(*) FROM users WHERE last_login_at >= CURRENT_DATE - INTERVAL '30 days'),
    (SELECT COUNT(*) FROM users WHERE DATE(created_at) = CURRENT_DATE),
    (SELECT COUNT(*) FROM flows WHERE DATE(created_at) = CURRENT_DATE),
    (SELECT COUNT(*) FROM users WHERE subscription_tier = 'free' AND is_active = true),
    (SELECT COUNT(*) FROM users WHERE subscription_tier = 'pro' AND is_active = true),
    (SELECT COUNT(*) FROM users WHERE subscription_tier = 'enterprise' AND is_active = true)
  )
  ON CONFLICT (date) DO UPDATE SET
    total_users = EXCLUDED.total_users,
    active_users = EXCLUDED.active_users,
    new_signups = EXCLUDED.new_signups,
    total_flows = EXCLUDED.total_flows,
    free_tier_users = EXCLUDED.free_tier_users,
    pro_tier_users = EXCLUDED.pro_tier_users,
    enterprise_tier_users = EXCLUDED.enterprise_tier_users,
    created_at = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- Sample pricing tiers (for reference)
-- FREE: 3 flows/month, $0
-- PRO: 50 flows/month, $39
-- ENTERPRISE: unlimited flows, $399
