/**
 * @fileoverview Login form displayed when the server returns 401 Unauthorized.
 */

import { useState, useCallback } from 'react';
import { API_BASE_URL } from '../../constants/config';
import './LoginForm.css';

/**
 * @param {{ onSuccess: () => void }} props
 */
export function LoginForm({ onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      setError('');
      setLoading(true);
      try {
        const res = await fetch(`${API_BASE_URL}/api/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ password }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error || 'Incorrect password');
          return;
        }
        onSuccess();
      } catch {
        setError('Cannot reach the server');
      } finally {
        setLoading(false);
      }
    },
    [password, onSuccess]
  );

  return (
    <div className="login-container">
      <form className="login-form" onSubmit={handleSubmit}>
        <h2 className="login-title">SIM Station</h2>
        <input
          className="login-input"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          disabled={loading}
        />
        <button className="login-button" type="submit" disabled={loading || !password}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <p className="login-error">{error}</p>}
      </form>
    </div>
  );
}
