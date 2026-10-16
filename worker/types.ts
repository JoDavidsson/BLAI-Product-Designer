export interface Env {
  DB: D1Database;
  ASSETS_BUCKET: R2Bucket;
  ASSETS?: Fetcher;
  DEV_AUTH?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  AUTH_ALLOWED_EMAILS?: string;
  DESIGNER_OWNER_EMAIL?: string;
  DESIGNER_BRIDGE_SECRET?: string;
  DESIGNER_ACCESS_CLIENT_ID?: string;
  DESIGNER_ACCESS_CLIENT_SECRET?: string;
  GITHUB_TOKEN?: string;
}
export interface Identity {
  owner: string;
  email: string;
  local: boolean;
}
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
