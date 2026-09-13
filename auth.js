#!/usr/bin/env node
/**
 * One-time OAuth consent flow for the Drive MCP server.
 *
 * Reads the OAuth client JSON (a Desktop-app client downloaded from Google
 * Cloud Console) and writes a token file holding the refresh token.
 *
 * Run:  npm run auth
 */
import http from 'node:http';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { google } from 'googleapis';
import { CREDENTIALS, TOKEN, EXPECTED_ACCOUNT, SCOPES } from './config.js';

if (!existsSync(CREDENTIALS)) {
  console.error(
    `Missing ${CREDENTIALS}\n\n` +
      'Download the OAuth client JSON from Google Cloud Console\n' +
      '(APIs & Services -> Credentials -> Desktop app) and save it there,\n' +
      'or point DRIVE_MCP_CREDENTIALS at it.'
  );
  process.exit(1);
}

const raw = JSON.parse(readFileSync(CREDENTIALS, 'utf8'));
const cfg = raw.installed ?? raw.web ?? raw;
const clientId = cfg.client_id;
const clientSecret = cfg.client_secret;

if (!clientId || !clientSecret) {
  console.error('The credentials file has no client_id/client_secret. Re-download it as a Desktop app client.');
  process.exit(1);
}

/** Open a URL in the default browser without depending on any one platform. */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The URL is printed to the terminal as a fallback.
  }
}

// Loopback redirect on an ephemeral port; Desktop clients allow any 127.0.0.1 port.
const server = http.createServer();
server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',   // ask for a refresh token
    prompt: 'consent',        // force one so re-runs still return it
    scope: SCOPES,
  });

  console.log('\nOpening the Google consent screen in your browser.');
  if (EXPECTED_ACCOUNT) console.log(`Sign in as ${EXPECTED_ACCOUNT}.\n`);
  console.log(`If the browser does not open, visit:\n${authUrl}\n`);
  openBrowser(authUrl);

  server.on('request', async (req, res) => {
    const url = new URL(req.url, redirectUri);
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    const reply = (msg) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<html><body style="font-family:system-ui;background:#fff;color:#111;padding:3rem">
           <h2>${msg}</h2><p>You can close this tab and return to the terminal.</p>
         </body></html>`
      );
    };

    if (error) {
      reply(`Authorization failed: ${error}`);
      console.error(`\nAuthorization failed: ${error}`);
      server.close();
      process.exit(1);
    }
    if (!code) return;

    try {
      const { tokens } = await oauth2.getToken(code);
      if (!tokens.refresh_token) {
        reply('No refresh token returned.');
        console.error(
          '\nGoogle returned no refresh token. Revoke this app at\n' +
            'https://myaccount.google.com/permissions and run `npm run auth` again.'
        );
        server.close();
        process.exit(1);
      }
      writeFileSync(TOKEN, JSON.stringify(tokens, null, 2));
      chmodSync(TOKEN, 0o600);

      // Confirm which account this token belongs to.
      oauth2.setCredentials(tokens);
      const drive = google.drive({ version: 'v3', auth: oauth2 });
      const { data } = await drive.about.get({ fields: 'user(emailAddress)' });
      const address = data.user?.emailAddress ?? '(unknown)';

      reply(`Authorized ${address}`);
      console.log(`\nToken saved to ${TOKEN} (mode 600).`);
      console.log(`Authorized account: ${address}`);
      if (EXPECTED_ACCOUNT && address !== EXPECTED_ACCOUNT) {
        console.log(`\nWARNING: expected ${EXPECTED_ACCOUNT} but got ${address}.`);
        console.log('Delete the token file and re-run `npm run auth`, signing in as the intended account.');
      }
      server.close();
      process.exit(0);
    } catch (e) {
      reply('Token exchange failed.');
      console.error(`\nToken exchange failed: ${e.message}`);
      server.close();
      process.exit(1);
    }
  });
});
