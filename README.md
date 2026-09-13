# drive-mcp

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server for one Google Drive account, served over stdio.
It gives an MCP client such as Claude Code the ability to search, read, download, create, edit, organize and share files using your own Google OAuth client.

## Why

Google's hosted Drive MCP endpoint requires the Cloud project to be enrolled in the Google Workspace Developer Preview Program, which asks for a Workspace account.
A personal Google account cannot use it.
This server sidesteps that by talking to the Drive API itself with a Desktop-app OAuth client that you create in your own Google Cloud project.
No third party sits between the client and your files.

## Scope and safety

The server requests the full `drive` scope.
That is deliberate: the narrower `drive.file` scope only reaches files the app itself created, which would rule out reading, editing or organizing anything already in the account.

Because the scope is broad, the tool surface is the safety boundary:

- Nothing permanently deletes.
  `trash_file` moves to the trash, where Drive keeps things for 30 days and `untrash_file` brings them back.
  There is no tool to empty the trash.
- Sharing never emails anyone unless `sendNotificationEmail` is set to true.
- Link sharing is created with `allowFileDiscovery` off, so shared links are never searchable.
- `download_file` refuses to overwrite a local file unless told to.

Pin every write tool to an "ask" rule in your MCP client so it prompts on every call regardless of the session's permission mode.
In Claude Code that is a block in `.claude/settings.local.json` of the project where the server is registered:

```json
{
  "permissions": {
    "ask": [
      "mcp__drive__create_file",
      "mcp__drive__create_folder",
      "mcp__drive__upload_file",
      "mcp__drive__update_file_content",
      "mcp__drive__update_file_metadata",
      "mcp__drive__copy_file",
      "mcp__drive__trash_file",
      "mcp__drive__untrash_file",
      "mcp__drive__share_file",
      "mcp__drive__unshare_file"
    ]
  }
}
```

The tool name prefix is `mcp__<server name>__`, so adjust it to whatever name you register the server under.

## Tools

### Read

| Tool | Effect |
| --- | --- |
| `search_files` | Structured search: name, full text, type, folder, modified after, owned by me. Paginated |
| `list_recent_files` | Most recently modified files, default 10 |
| `list_folder` | Direct children of a folder, folders first. `root` is My Drive |
| `get_file_metadata` | One file with its folder path and web link |
| `read_file_content` | Content as text. Docs export as Markdown, Sheets as CSV, Slides as plain text; text-like files as-is |
| `get_file_permissions` | Who has access and with what role |
| `download_file` | Save to a local absolute path. Docs, Sheets, Slides and Drawings export to docx, xlsx, pptx and png by default |

### Write

| Tool | Effect |
| --- | --- |
| `create_file` | **Writes.** New file from text. `convertTo` imports Markdown, HTML or plain text as a Doc, CSV as a Sheet |
| `create_folder` | **Writes.** New folder |
| `upload_file` | **Writes.** Upload a local file, optionally importing it as a Google-native file |
| `update_file_content` | **Writes.** Replace a file's content. For a Doc, Markdown replaces the whole document |
| `update_file_metadata` | **Writes.** Rename, move, describe or star |
| `copy_file` | **Writes.** Copy, optionally renamed and into another folder |
| `trash_file` / `untrash_file` | **Writes.** Reversible trash |
| `share_file` | **Writes, reaches other people.** Grant reader, commenter or writer to a user, group, domain or anyone with the link |
| `unshare_file` | **Writes.** Remove a permission by id or by email; `anyone` removes link sharing |

## Files

| File | Purpose |
| --- | --- |
| `server.js` | The MCP server |
| `auth.js` | One-time OAuth consent flow; writes the token file |
| `config.js` | File locations and scope, overridable through environment variables |
| `credentials.json` | OAuth client from Google Cloud Console. Gitignored, never commit it |
| `token.json` | Refresh token, written with mode 600. Gitignored, never commit it |

## Setup

Requires Node.js 20 or newer.

1. In [Google Cloud Console](https://console.cloud.google.com), signed in as the Google account you want to expose: create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen as **External** and add that same account as a **test user**.
3. Create an **OAuth client ID** of type **Desktop app** and download its JSON to `credentials.json` in this directory.
   If you already have a Desktop client from another tool in the same project, the same file works here; each server keeps its own token.
4. Install dependencies and run the consent flow:

   ```sh
   npm install
   npm run auth
   ```

   A browser opens on the Google consent screen.
   When it finishes, the script prints which account the token belongs to.
   Set `DRIVE_MCP_ACCOUNT` to the expected address if you want a warning when the wrong account was used.
5. Register the server with your MCP client.
   For Claude Code, from the project where you want it available:

   ```sh
   claude mcp add drive -- node /absolute/path/to/drive-mcp/server.js
   ```

## Configuration

Everything defaults to files next to the code.
Override with environment variables when the server runs from elsewhere or when several accounts share one checkout.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DRIVE_MCP_CREDENTIALS` | `./credentials.json` | Path to the OAuth client JSON |
| `DRIVE_MCP_TOKEN` | `./token.json` | Path where the refresh token is stored |
| `DRIVE_MCP_ACCOUNT` | unset | Expected address; `auth.js` warns if the token belongs to another account |

To change the scope, edit `SCOPES` in `config.js` and re-run `npm run auth`.
An existing token keeps its old scope, and API calls fail with `insufficient authentication scopes` until it is reissued.

## Notes

- Staying in OAuth "Testing" status is fine for personal use; no Google verification is needed.
  Refresh tokens for unverified apps expire after 7 days of disuse, so re-run `npm run auth` if calls start failing with `invalid_grant`.
- `credentials.json` and `token.json` are secrets.
  They are gitignored here, but treat any copy of them like a password.
- Sibling projects: [gmail-mcp](https://github.com/reisbel/gmail-mcp) and [calendar-mcp](https://github.com/reisbel/calendar-mcp).

## License

MIT. See `LICENSE`.
