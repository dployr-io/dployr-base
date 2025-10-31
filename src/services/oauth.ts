// services/oauth.ts
import { OAuthProvider, OAuthUser, Bindings } from "@/types";

interface OAuthConfig {
  authUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scope: string;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

const providers: Record<OAuthProvider, (env: Bindings) => OAuthConfig> = {
  google: (env) => ({
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    scope: "openid email profile",
  }),
  microsoft: (env) => ({
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userInfoUrl: "https://graph.microsoft.com/v1.0/me",
    scope: "openid email profile",
  }),
  apple: (env) => ({
    authUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    userInfoUrl: "", // Apple returns user info in ID token
    scope: "name email",
  }),
};

export class OAuthService {
  constructor(private env: Bindings) {}

  getAuthUrl(provider: OAuthProvider, state: string): string {
    const config = providers[provider](this.env);
    const redirectUri = `${this.env.DPLOYR_BASE_URL}/api/auth/callback/${provider}`;

    const params = new URLSearchParams({
      client_id: this.getClientId(provider),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: config.scope,
      state,
    });

    if (provider === "apple") {
      params.append("response_mode", "form_post");
    }

    return `${config.authUrl}?${params}`;
  }

  async exchangeCode(provider: OAuthProvider, code: string): Promise<string> {
    const config = providers[provider](this.env);
    const redirectUri = `${this.env.DPLOYR_BASE_URL}/api/auth/callback/${provider}`;

    const body = new URLSearchParams({
      client_id: this.getClientId(provider),
      client_secret: this.getClientSecret(provider),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${await response.text()}`);
    }

    const data = (await response.json()) as TokenResponse;
    return data.access_token;
  }

  async getUserInfo(
    provider: OAuthProvider,
    accessToken: string
  ): Promise<OAuthUser> {
    const config = providers[provider](this.env);

    if (provider === "apple") {
      // Decode ID token for Apple
      return this.decodeAppleIdToken(accessToken);
    }

    const response = await fetch(config.userInfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch user info: ${await response.text()}`);
    }

    const data = await response.json();
    return this.normalizeUserInfo(provider, data);
  }

  private normalizeUserInfo(provider: OAuthProvider, data: any): OAuthUser {
    switch (provider) {
      case "google":
        return {
          id: data.id,
          email: data.email,
          name: data.name,
          picture: data.picture,
          provider: "google",
        };
      case "microsoft":
        return {
          id: data.id,
          email: data.mail || data.userPrincipalName,
          name: data.displayName,
          picture: "",
          provider: "microsoft",
        };
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  private decodeAppleIdToken(idToken: string): OAuthUser {
    // Simple JWT decode 
    // TODO: use a proper library
    const payload = JSON.parse(
      atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))
    );

    return {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      provider: "apple",
    };
  }

  private getClientId(provider: OAuthProvider): string {
    switch (provider) {
      case "google":
        return this.env.GOOGLE_CLIENT_ID;
      case "apple":
        return this.env.APPLE_CLIENT_ID;
      case "microsoft":
        return this.env.MICROSOFT_CLIENT_ID;
    }
  }

  private getClientSecret(provider: OAuthProvider): string {
    switch (provider) {
      case "google":
        return this.env.GOOGLE_CLIENT_SECRET;
      case "microsoft":
        return this.env.MICROSOFT_CLIENT_SECRET;
      case "apple":
        return this.generateAppleClientSecret();
    }
  }

  private generateAppleClientSecret(): string {
    // Apple requires JWT signed with private key
    // TOOD: Use a proper library
    throw new Error("Apple client secret generation not implemented");
  }
}
