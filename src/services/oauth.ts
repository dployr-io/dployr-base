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
    scope: "https://graph.microsoft.com/User.Read openid email profile",
  }),
  github: (env) => ({
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    scope: "user:email",
  }),
};

export class OAuthService {
  constructor(private env: Bindings) { }

  getAuthUrl(provider: OAuthProvider, state: string): string {
    const config = providers[provider](this.env);
    const redirectUri = `${this.env.BASE_URL}/api/auth/callback/${provider}`;

    const params = new URLSearchParams({
      client_id: this.getClientId(provider),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: config.scope,
      state,
    });



    return `${config.authUrl}?${params}`;
  }

  async exchangeCode(provider: OAuthProvider, code: string): Promise<string> {
    const config = providers[provider](this.env);
    const redirectUri = `${this.env.BASE_URL}/api/auth/callback/${provider}`;

    const body = new URLSearchParams({
      client_id: this.getClientId(provider),
      client_secret: this.getClientSecret(provider),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };

    // GitHub requires Accept header for JSON response
    if (provider === "github") {
      headers["Accept"] = "application/json";
    }

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers,
      body: body.toString(),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(error);
      throw new Error(`Token exchange failed: ${error}`);
    }

    const data = (await response.json()) as TokenResponse;
    return data.access_token;
  }

  async getUserInfo(
    provider: OAuthProvider,
    accessToken: string
  ): Promise<OAuthUser> {
    const config = providers[provider](this.env);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    };

    // GitHub requires User-Agent header
    if (provider === "github") {
      headers["User-Agent"] = "dployr";
    }

    const response = await fetch(config.userInfoUrl, { headers });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`User info error response: ${errorText}`);
      throw new Error(`Failed to fetch user info: ${errorText}`);
    }

    const data = await response.json() as any;

    // For GitHub, we need to fetch email separately if it's not public
    if (provider === "github" && !data.email) {
      const emailResponse = await fetch("https://api.github.com/user/emails", { headers });
      if (emailResponse.ok) {
        const emails = await emailResponse.json() as any[];
        const primaryEmail = emails.find((email: any) => email.primary);
        if (primaryEmail) {
          data.email = primaryEmail.email;
        }
      }
    }

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
      case "github":
        return {
          id: data.id.toString(),
          email: data.email,
          name: data.name || data.login,
          picture: data.avatar_url,
          provider: "github",
        };
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }


  private getClientId(provider: OAuthProvider): string {
    switch (provider) {
      case "google":
        return this.env.GOOGLE_CLIENT_ID;
      case "github":
        return this.env.GITHUB_CLIENT_ID;
      case "microsoft":
        return this.env.MICROSOFT_CLIENT_ID;
    }
  }

  private getClientSecret(provider: OAuthProvider): string {
    switch (provider) {
      case "google":
        return this.env.GOOGLE_CLIENT_SECRET;
      case "github":
        return this.env.GITHUB_CLIENT_SECRET;
      case "microsoft":
        return this.env.MICROSOFT_CLIENT_SECRET;
    }
  }
}
