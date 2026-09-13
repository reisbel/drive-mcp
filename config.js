/**
 * Shared configuration for auth.js and server.js.
 *
 * Both secret files default to the repository directory and are gitignored.
 * Override the locations with environment variables when the server runs
 * from somewhere else, or when several accounts share one checkout.
 *
 *   DRIVE_MCP_CREDENTIALS  path to the OAuth client JSON from Google Cloud Console
 *   DRIVE_MCP_TOKEN        path where the refresh token is stored
 *   DRIVE_MCP_ACCOUNT      optional; the address the token is expected to belong to
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

export const CREDENTIALS = process.env.DRIVE_MCP_CREDENTIALS ?? join(DIR, 'credentials.json');
export const TOKEN = process.env.DRIVE_MCP_TOKEN ?? join(DIR, 'token.json');
export const EXPECTED_ACCOUNT = process.env.DRIVE_MCP_ACCOUNT || undefined;

// drive: read and write every file the account can reach. The narrower
// drive.file scope only covers files this app created, which would rule out
// editing or organizing existing files, so the full scope is required here.
// The tool surface is the safety boundary: nothing permanently deletes.
export const SCOPES = ['https://www.googleapis.com/auth/drive'];
