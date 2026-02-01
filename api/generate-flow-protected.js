// Updated Flow Generation API with Auth & Usage Limits
// Path: /api/generate-flow-protected.js

import { createClient } from '@vercel/postgres';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const client = createClient();
  await client.connect();

  try {
    const { prompt, flowName, userId } = req.body;

    // Validate input
    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    if (!userId) {
      return res.status(401).json({ error: 'User ID required' });
    }

    // Get user and check limits
    const userResult = await client.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Check usage limits
    const limits = {
      free: 3,
      pro: 50,
      enterprise: 999999
    };

    const limit = limits[user.subscription_tier] || 3;
    const remaining = limit - user.flows_generated_this_month;

    if (remaining <= 0) {
      return res.status(429).json({ 
        error: 'Usage limit exceeded',
        limit: limit,
        used: user.flows_generated_this_month,
        tier: user.subscription_tier,
        upgradeRequired: true
      });
    }

    // Get Claude API key
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY not configured');
      return res.status(500).json({ error: 'API key not configured' });
    }

    // Call Claude API
    console.log(`Generating flow for user ${userId} (${user.subscription_tier})...`);
    const startTime = Date.now();

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: `You are a Power Automate flow generation expert. Generate a complete, valid Power Automate Cloud Flow JSON definition based on this request:

"${prompt}"

${flowName ? `Flow name should be: "${flowName}"` : ''}

CRITICAL REQUIREMENTS:
1. Use ONLY the standard Power Automate schema: "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#"
2. Include proper contentVersion: "1.0.0.0"
3. Use valid triggers (manual, recurrence, SharePoint, etc.)
4. Use valid actions with proper runAfter dependencies
5. Include connection references where needed
6. Return ONLY the JSON - no markdown, no explanations
7. Ensure all expressions use proper Power Automate syntax (@{}, triggerOutputs(), etc.)
8. Make sure the flow is production-ready and follows best practices

Generate the flow JSON now:`
          }
        ]
      })
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error('Claude API error:', response.status, errorData);
      return res.status(response.status).json({
        error: `Claude API error: ${response.status}`,
        details: errorData
      });
    }

    const data = await response.json();
    const generationTime = (Date.now() - startTime) / 1000;

    // Extract flow JSON
    const flowJson = data.content.find(c => c.type === 'text')?.text;
    if (!flowJson) {
      console.error('No flow JSON in response');
      return res.status(500).json({ error: 'No flow JSON returned from Claude' });
    }

    // Clean up JSON
    let cleanJson = flowJson.trim();
    if (cleanJson.startsWith('```json')) {
      cleanJson = cleanJson.replace(/```json\n?/, '').replace(/```$/, '').trim();
    } else if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.replace(/```\n?/, '').replace(/```$/, '').trim();
    }

    // Parse and validate
    let parsed;
    try {
      parsed = JSON.parse(cleanJson);
    } catch (parseError) {
      console.error('Failed to parse flow JSON:', parseError);
      return res.status(500).json({
        error: 'Invalid JSON returned from Claude',
        rawResponse: cleanJson.substring(0, 500)
      });
    }

    // Calculate tokens used (approximate)
    const tokensUsed = Math.ceil((prompt.length + flowJson.length) / 4);

    // Save flow to database
    const flowResult = await client.query(
      `INSERT INTO flows (
        user_id, flow_name, prompt, generated_json, tokens_used, 
        generation_time_seconds, success
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id`,
      [userId, flowName || 'Untitled Flow', prompt, parsed, tokensUsed, generationTime, true]
    );

    // Increment user flow count
    await client.query(
      `UPDATE users 
       SET flows_generated_this_month = flows_generated_this_month + 1,
           total_flows_generated = total_flows_generated + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [userId]
    );

    // Log usage
    await client.query(
      'INSERT INTO usage_logs (user_id, action_type, metadata) VALUES ($1, $2, $3)',
      [userId, 'flow_generated', JSON.stringify({ 
        flowId: flowResult.rows[0].id, 
        tokensUsed, 
        generationTime 
      })]
    );

    console.log(`✅ Flow generated successfully for user ${userId}`);

    return res.status(200).json({
      success: true,
      flow: parsed,
      rawJson: cleanJson,
      usage: {
        tier: user.subscription_tier,
        limit: limit,
        used: user.flows_generated_this_month + 1,
        remaining: remaining - 1
      },
      stats: {
        tokensUsed,
        generationTime
      }
    });

  } catch (error) {
    console.error('Server error:', error);
    
    // Log error
    try {
      await client.query(
        'INSERT INTO usage_logs (user_id, action_type, metadata) VALUES ($1, $2, $3)',
        [req.body.userId, 'flow_generation_error', JSON.stringify({ 
          error: error.message,
          prompt: req.body.prompt?.substring(0, 100)
        })]
      );
    } catch (logError) {
      console.error('Failed to log error:', logError);
    }

    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  } finally {
    await client.end();
  }
}
