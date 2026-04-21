import { loginAction } from './actions';

/**
 * MVP mock login. Accepts any email and sets a signed session cookie.
 * Real Cognito-backed sign-in replaces this page in the next slice;
 * everything else (audit log, requireSession, middleware) works the
 * same against the replacement.
 */
export default function LoginPage() {
  return (
    <div style={{ maxWidth: 420 }}>
      <h1>Sign in</h1>
      <p style={{ color: '#a00', fontSize: 13 }}>
        DEV MODE: This is a placeholder login. Do not deploy this page to
        production. Replace with Cognito SAML federation before pilot.
      </p>
      <form action={loginAction}>
        <label>
          Email
          <br />
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            style={{ width: '100%', padding: 8 }}
          />
        </label>
        <button type="submit" style={{ marginTop: 12, padding: '8px 16px' }}>
          Sign in
        </button>
      </form>
    </div>
  );
}
