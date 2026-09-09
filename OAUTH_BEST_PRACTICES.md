# Google OAuth 2.0 Best Practices

> Production-ready implementation guide for Web Application + API Server architecture.
> Use this as a reference when implementing OAuth in new projects.

---

## Quick Reference Checklist

```
□ PKCE (code_verifier + code_challenge with S256)
□ State parameter for CSRF protection
□ Cookies: httpOnly, secure, sameSite=lax
□ ID Token validation (not userinfo API)
□ Claims validation: iss, aud, exp, email_verified
□ Environment variables for all secrets
□ Proper redirect URI configuration
```

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (Untrusted)                                            │
│  - Stores: session cookie (httpOnly)                            │
│  - NEVER stores: tokens, secrets                                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  API Server (Trust Boundary)                                    │
│  - Stores: client_secret, signing keys                          │
│  - Validates: Google ID tokens                                  │
│  - Issues: internal session/JWT                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. OAuth Flow Implementation

### 2.1 Login Endpoint

```typescript
// GET /auth/google/login
async function googleLogin({ set, cookie: { oauth_state } }) {
    // 1. Generate PKCE
    const codeVerifier = generateRandomString(64);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    
    // 2. Generate state for CSRF protection
    const state = generateRandomString(32);
    
    // 3. Store state -> verifier mapping (server-side)
    stateStore.set(state, { codeVerifier, createdAt: Date.now() });
    
    // 4. Set state cookie (for double validation)
    const isProduction = process.env.FRONTEND_URL?.includes('https://');
    oauth_state.value = state;
    oauth_state.httpOnly = true;
    oauth_state.secure = isProduction;  // ⚠️ CRITICAL for HTTPS
    oauth_state.sameSite = "lax";
    oauth_state.maxAge = 600;
    
    // 5. Redirect to Google
    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: GOOGLE_REDIRECT_URI,
        response_type: "code",
        scope: "email profile openid",
        state: state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256"
    });
    
    set.redirect = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
```

### 2.2 Callback Endpoint

```typescript
// GET /auth/google/callback
async function googleCallback({ query, cookie: { session, oauth_state } }) {
    const { code, state, error } = query;
    
    // 1. Handle errors from Google
    if (error) {
        return redirect(`/signin?error=${error}`);
    }
    
    // 2. Validate state (CSRF protection)
    const storedData = stateStore.get(state);
    if (!storedData || oauth_state.value !== state) {
        return { error: "Invalid state - CSRF attack?" };
    }
    
    // 3. Exchange code for tokens (with PKCE verifier)
    const tokens = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,  // Server-side only!
            redirect_uri: GOOGLE_REDIRECT_URI,
            grant_type: "authorization_code",
            code_verifier: storedData.codeVerifier  // PKCE
        })
    });
    
    // 4. Validate ID Token
    const userData = validateGoogleIdToken(tokens.id_token);
    
    // 5. Create/update user
    const user = await upsertUser(userData);
    
    // 6. Set session cookie
    session.value = createSession(user.id);
    session.httpOnly = true;
    session.secure = isProduction;
    session.sameSite = "lax";
    
    // 7. Redirect to frontend
    return redirect(FRONTEND_URL);
}
```

---

## 3. Cookie Configuration

### ⚠️ Critical Settings

| Setting | Value | Why |
|---------|-------|-----|
| `httpOnly` | `true` | Prevents JavaScript access (XSS protection) |
| `secure` | `true` in production | Required for HTTPS, prevents MitM |
| `sameSite` | `"lax"` | CSRF protection while allowing navigation |
| `path` | `"/"` | Cookie sent to all routes |

### Common Mistake

```typescript
// ❌ WRONG - Cookie won't work over HTTPS
session.httpOnly = true;
session.path = "/";

// ✅ CORRECT - Works with HTTPS (Cloudflare Tunnel, etc.)
const isProduction = process.env.FRONTEND_URL?.includes('https://');
session.httpOnly = true;
session.secure = isProduction;
session.sameSite = "lax";
session.path = "/";
```

---

## 4. ID Token Validation

### Required Claims

```typescript
function validateGoogleIdToken(token: string): GoogleClaims {
    const payload = decodeJwt(token);
    
    // ✅ Issuer must be Google
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss)) {
        throw new Error('Invalid issuer');
    }
    
    // ✅ Audience must be YOUR client_id
    if (payload.aud !== GOOGLE_CLIENT_ID) {
        throw new Error('Invalid audience');
    }
    
    // ✅ Not expired (with 60s clock skew tolerance)
    if (payload.exp < Date.now() / 1000 - 60) {
        throw new Error('Token expired');
    }
    
    // ✅ Email must be verified
    if (!payload.email_verified) {
        throw new Error('Email not verified');
    }
    
    return payload;
}
```

---

## 5. Environment Variables

```bash
# Backend (.env)
GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxx        # ⚠️ NEVER in frontend
GOOGLE_REDIRECT_URI=https://yourdomain.com/api/auth/google/callback
FRONTEND_URL=https://yourdomain.com

# Google Cloud Console must have:
# Authorized redirect URIs: https://yourdomain.com/api/auth/google/callback
```

---

## 6. Common Pitfalls

### ❌ DON'T: Trust frontend-provided data

```typescript
// ❌ DANGEROUS
const email = req.body.email;  // Attacker can send any email!

// ✅ SAFE
const email = validateGoogleIdToken(req.body.id_token).email;
```

### ❌ DON'T: Put secrets in frontend

```typescript
// ❌ CATASTROPHIC
const response = await fetch('/token', {
    body: { client_secret: 'xxx' }  // Visible in browser!
});
```

### ❌ DON'T: Skip PKCE

```
Without PKCE:
1. Attacker intercepts authorization code
2. Attacker exchanges code for tokens
3. Account compromised

With PKCE:
1. Attacker intercepts authorization code
2. Attacker tries to exchange code
3. Google rejects: no code_verifier
4. Attack FAILS ✅
```

### ❌ DON'T: Forget cookie Secure flag

```
Problem: Cookie set without Secure flag
Result: Browser won't send cookie over HTTPS
Symptom: Login succeeds but session lost on redirect
```

---

## 7. Debugging Tips

### Check if cookies are being set

```bash
curl -sI http://localhost:5175/auth/google/login | grep cookie
# Should show: set-cookie: oauth_state=...; Secure; HttpOnly
```

### Check environment variables

```typescript
console.log('OAuth Config:');
console.log('FRONTEND_URL:', process.env.FRONTEND_URL);
console.log('GOOGLE_REDIRECT_URI:', process.env.GOOGLE_REDIRECT_URI);
console.log('GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? 'SET' : 'NOT SET');
```

### Common errors

| Error | Cause | Fix |
|-------|-------|-----|
| `redirect_uri_mismatch` | URI not registered in Google Console | Add exact URI to Google Cloud Console |
| `Invalid state` | CSRF validation failed | Check cookie `Secure` flag for HTTPS |
| `Token expired` | Clock skew or old token | Add 60s tolerance to exp check |
| Session lost after login | Cookie not sent | Add `Secure` + `SameSite` flags |

---

## 8. Proxy Configuration (Vite)

```typescript
// vite.config.ts
export default defineConfig({
    server: {
        proxy: {
            '/api': {
                target: 'http://localhost:5175',
                changeOrigin: true,
            },
        },
    },
});
```

**Note**: Vite proxy only works in development. For production, use nginx/Caddy or same-origin deployment.

---

## 9. Frontend Auth Context

```typescript
// AuthContext.tsx
const checkAuth = async () => {
    const res = await fetch("/api/auth/me", {
        credentials: "include"  // ⚠️ Required for cookies
    });
    const data = await res.json();
    setAuthenticated(data.authenticated);
};
```

---

## Summary

| Requirement | Implementation |
|-------------|----------------|
| CSRF Protection | State parameter + cookie validation |
| Code Interception | PKCE (S256) |
| Token Security | ID Token validation, not userinfo API |
| Cookie Security | `httpOnly`, `secure`, `sameSite` |
| Secrets | Backend only, never in frontend |

---

*Last updated: 2026-01-04*
