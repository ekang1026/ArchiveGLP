import { CognitoUserPool } from 'amazon-cognito-identity-js';
import { env } from './env';

/**
 * Returns a Cognito pool bound to this deploy's firm. Dashboard auth is a
 * supervisor-only surface; agents never use this.
 *
 * Returns null when Cognito env vars aren't set (local dev without AWS).
 */
export function getUserPool(): CognitoUserPool | null {
  if (!env.NEXT_PUBLIC_COGNITO_USER_POOL_ID || !env.NEXT_PUBLIC_COGNITO_CLIENT_ID) {
    return null;
  }
  return new CognitoUserPool({
    UserPoolId: env.NEXT_PUBLIC_COGNITO_USER_POOL_ID,
    ClientId: env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
  });
}
