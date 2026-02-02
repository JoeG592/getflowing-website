import { createUser, createToken } from '../../lib/auth';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password, name } = req.body;

  // Validation
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

  // Create user
  const result = await createUser(email.toLowerCase(), password, name);
  
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  // Create token
  const token = await createToken(result.userId, email.toLowerCase());

  // Set cookie
  res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`);

  return res.status(200).json({
    success: true,
    user: {
      id: result.userId,
      email: email.toLowerCase(),
      name: name || ''
    }
  });
}
