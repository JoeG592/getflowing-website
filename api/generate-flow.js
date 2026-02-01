// Vercel Serverless Function - Generate Flow with Claude API
// Path: /api/generate-flow.js

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { prompt, flowName } = req.body;

    // Validate input
    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Get Claude API key from environment variable
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY not configured');
      return res.status(500).json({ error: 'API key not configured' });
    }

    // Call Claude API
    console.log('Calling Claude API...');
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
    console.log('Claude API response received');

    // Extract the flow JSON from Claude's response
    const flowJson = data.content.find(c => c.type === 'text')?.text;

    if (!flowJson) {
      console.error('No flow JSON in response');
      return res.status(500).json({ error: 'No flow JSON returned from Claude' });
    }

    // Clean up the JSON (remove markdown formatting if present)
    let cleanJson = flowJson.trim();
    if (cleanJson.startsWith('```json')) {
      cleanJson = cleanJson.replace(/```json\n?/, '').replace(/```$/, '').trim();
    } else if (cleanJson.startsWith('```')) {
      cleanJson = cleanJson.replace(/```\n?/, '').replace(/```$/, '').trim();
    }

    // Parse to validate it's valid JSON
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

    console.log('Flow generated successfully');

    // Return the generated flow
    return res.status(200).json({
      success: true,
      flow: parsed,
      rawJson: cleanJson
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
}
