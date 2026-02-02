import { getUserByEmail, verifyPassword, createToken } from '../../lib/auth';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, password } = req.body;

  // Validation
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  // Get user
  const user = await getUserByEmail(email.toLowerCase());
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Verify password
  const valid = verifyPassword(password, user.password_hash);
  
  if (!valid) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Create token
  const token = await createToken(user.id, user.email);

  // Set cookie
  res.setHeader('Set-Cookie', `auth_token=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`);

  return res.status(200).json({
    success: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      tier: user.tier
    }
  });
}
