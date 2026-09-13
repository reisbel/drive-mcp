#!/usr/bin/env node
/**
 * Google Drive MCP server for a single Google account, served over stdio.
 *
 * Scope is the full `drive` scope: read and write every file the account can
 * reach. The tool surface is the safety boundary. Nothing here permanently
 * deletes a file or empties the trash; trash_file is reversible for 30 days.
 *
 * Read tools are safe to call freely. The write tools (create_file,
 * create_folder, upload_file, update_file_content, update_file_metadata,
 * copy_file, trash_file, untrash_file, share_file, unshare_file) change the
 * account's Drive and, for sharing, reach other people, so pin them to an
 * "ask" permission rule in your MCP client (see README.md).
 */
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CREDENTIALS, TOKEN } from './config.js';

function driveClient() {
  if (!existsSync(CREDENTIALS)) throw new Error(`Missing ${CREDENTIALS}. See README.md.`);
  if (!existsSync(TOKEN)) throw new Error(`Missing ${TOKEN}. Run: npm run auth`);

  const raw = JSON.parse(readFileSync(CREDENTIALS, 'utf8'));
  const cfg = raw.installed ?? raw.web ?? raw;
  const oauth2 = new google.auth.OAuth2(cfg.client_id, cfg.client_secret);
  oauth2.setCredentials(JSON.parse(readFileSync(TOKEN, 'utf8')));
  return google.drive({ version: 'v3', auth: oauth2 });
}

const G = {
  folder: 'application/vnd.google-apps.folder',
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
  drawing: 'application/vnd.google-apps.drawing',
  shortcut: 'application/vnd.google-apps.shortcut',
};

/** Friendly names accepted by search_files `type` and create_file `convertTo`. */
const TYPE_MIME = {
  folder: G.folder,
  document: G.document,
  spreadsheet: G.spreadsheet,
  presentation: G.presentation,
  drawing: G.drawing,
  pdf: 'application/pdf',
};

/** Export targets for Google-native files, keyed by friendly format name. */
const EXPORT_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  png: 'image/png',
  svg: 'image/svg+xml',
};

const DEFAULT_EXPORT = {
  [G.document]: 'docx',
  [G.spreadsheet]: 'xlsx',
  [G.presentation]: 'pptx',
  [G.drawing]: 'png',
};

const FILE_FIELDS =
  'id,name,mimeType,size,createdTime,modifiedTime,parents,owners(emailAddress,displayName),' +
  'webViewLink,trashed,shared,starred,description,shortcutDetails,capabilities(canEdit,canShare,canTrash)';

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const escapeQ = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const isGoogleNative = (mime) => mime?.startsWith('application/vnd.google-apps.');
const isTextLike = (mime) =>
  /^text\//.test(mime) || /^application\/(json|xml|x-yaml|yaml|javascript|x-sh|toml)$/.test(mime) || /\+(json|xml)$/.test(mime);

function formatFile(f) {
  const kind = f.mimeType === G.folder ? 'folder' : isGoogleNative(f.mimeType) ? f.mimeType.split('.').pop() : 'file';
  return {
    id: f.id,
    name: f.name,
    kind,
    mimeType: f.mimeType,
    size: f.size ? Number(f.size) : undefined,
    createdTime: f.createdTime,
    modifiedTime: f.modifiedTime,
    parents: f.parents,
    owners: f.owners?.map((o) => o.emailAddress),
    webViewLink: f.webViewLink,
    trashed: f.trashed || undefined,
    shared: f.shared || undefined,
    starred: f.starred || undefined,
    description: f.description,
    shortcutTarget: f.shortcutDetails?.targetId,
    capabilities: f.capabilities,
  };
}

/** Walk parents up to the root and render "My Drive/Folder/Sub". */
async function folderPath(drive, parents, depth = 0) {
  const parentId = parents?.[0];
  if (!parentId || depth > 15) return '';
  try {
    const { data } = await drive.files.get({ fileId: parentId, fields: 'id,name,parents' });
    if (!data.parents?.length) return data.name; // root: "My Drive" or a shared drive name
    return `${await folderPath(drive, data.parents, depth + 1)}/${data.name}`;
  } catch {
    return '(unknown)';
  }
}

async function getFile(drive, fileId, fields = FILE_FIELDS) {
  const { data } = await drive.files.get({ fileId, fields, supportsAllDrives: true });
  return data;
}

function requireAbsolute(p, label) {
  if (!p || !isAbsolute(p)) throw new Error(`${label} must be an absolute path.`);
  return p;
}

async function streamToString(stream, maxChars) {
  let out = '';
  let truncated = false;
  for await (const chunk of stream) {
    out += chunk.toString('utf8');
    if (out.length > maxChars) {
      out = out.slice(0, maxChars);
      truncated = true;
      break;
    }
  }
  return { text: out, truncated };
}

const TOOLS = [
  {
    name: 'search_files',
    description:
      'Search Drive by name, full text, type, folder and modification date. All constraints are ANDed. ' +
      'Returns metadata only; use read_file_content or download_file for contents. Trashed files are excluded unless includeTrashed is true.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Substring of the file name (case-insensitive).' },
        fullText: { type: 'string', description: 'Words that must appear in the content, title or description.' },
        type: { type: 'string', enum: ['folder', 'document', 'spreadsheet', 'presentation', 'drawing', 'pdf', 'image', 'video'], description: 'Friendly type filter.' },
        mimeType: { type: 'string', description: 'Exact MIME type filter, for when `type` is not specific enough.' },
        folderId: { type: 'string', description: 'Only direct children of this folder. "root" is My Drive.' },
        modifiedAfter: { type: 'string', description: 'RFC 3339 timestamp; only files modified after it.' },
        ownedByMe: { type: 'boolean', description: 'Only files the account owns.' },
        includeTrashed: { type: 'boolean' },
        orderBy: { type: 'string', description: 'e.g. "modifiedTime desc" (default), "name", "createdTime desc", "viewedByMeTime desc".' },
        maxResults: { type: 'number', description: 'Default 25, max 100.' },
        pageToken: { type: 'string', description: 'From a previous result to fetch the next page.' },
      },
    },
  },
  {
    name: 'list_recent_files',
    description: 'The most recently modified files that are not in the trash. Default 10.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Default 10, max 100.' },
        orderBy: { type: 'string', enum: ['modifiedTime desc', 'modifiedByMeTime desc', 'viewedByMeTime desc'], description: 'Default "modifiedTime desc".' },
      },
    },
  },
  {
    name: 'list_folder',
    description: 'List the direct children of a folder, folders first then by name. Use "root" for My Drive.',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'Default "root".' },
        maxResults: { type: 'number', description: 'Default 100, max 1000.' },
        pageToken: { type: 'string' },
      },
    },
  },
  {
    name: 'get_file_metadata',
    description: 'Full metadata for one file, including its folder path and web link.',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
  },
  {
    name: 'read_file_content',
    description:
      'Return a file\'s content as text. Google Docs export as Markdown, Sheets as CSV (first sheet), Slides as plain text; ' +
      'text, Markdown, CSV, JSON and similar files are returned as-is. Binary files such as PDFs and images cannot be read this way; use download_file.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        format: { type: 'string', enum: ['md', 'txt', 'csv', 'html'], description: 'Export format for Google-native files. Default md for Docs, csv for Sheets, txt for Slides.' },
        maxChars: { type: 'number', description: 'Truncate after this many characters (default 50000).' },
      },
      required: ['fileId'],
    },
  },
  {
    name: 'get_file_permissions',
    description: 'Who can access a file and with what role.',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
  },
  {
    name: 'download_file',
    description:
      'Save a file to a local absolute path. Google-native files are exported (Docs to docx, Sheets to xlsx, Slides to pptx, Drawings to png by default; pass format to change). ' +
      'Refuses to overwrite unless overwrite is true.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        destinationPath: { type: 'string', description: 'Absolute path of the file to write, or of an existing directory to save into using the Drive name.' },
        format: { type: 'string', enum: Object.keys(EXPORT_MIME), description: 'Export format for Google-native files.' },
        overwrite: { type: 'boolean' },
      },
      required: ['fileId', 'destinationPath'],
    },
  },
  {
    name: 'create_file',
    description:
      'WRITES. Create a file from text. With convertTo, the text is imported as a Google Doc (from Markdown, HTML or plain text), Sheet (from CSV) or Slides. ' +
      'Without it a plain file of the given mimeType is created. Omit content to create an empty Google file.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        content: { type: 'string', description: 'Text content.' },
        mimeType: { type: 'string', description: 'MIME type of `content`. Default text/markdown when convertTo is document, text/csv for spreadsheet, otherwise text/plain.' },
        convertTo: { type: 'string', enum: ['document', 'spreadsheet', 'presentation'], description: 'Import as a Google-native file.' },
        folderId: { type: 'string', description: 'Parent folder. Default My Drive root.' },
        description: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_folder',
    description: 'WRITES. Create a folder.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        parentId: { type: 'string', description: 'Default My Drive root.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'upload_file',
    description: 'WRITES. Upload a local file. With convertTo the upload is imported as a Google-native file (e.g. a .docx or .md into a Google Doc, a .csv or .xlsx into a Sheet).',
    inputSchema: {
      type: 'object',
      properties: {
        localPath: { type: 'string', description: 'Absolute path of the file to upload.' },
        name: { type: 'string', description: 'Name in Drive. Default: the local file name.' },
        mimeType: { type: 'string', description: 'MIME type of the local file. Guessed from the extension when omitted.' },
        convertTo: { type: 'string', enum: ['document', 'spreadsheet', 'presentation'] },
        folderId: { type: 'string', description: 'Parent folder. Default My Drive root.' },
      },
      required: ['localPath'],
    },
  },
  {
    name: 'update_file_content',
    description:
      'WRITES. Replace a file\'s content with new text. For a Google Doc the text is re-imported (Markdown, HTML or plain text), replacing the whole document; ' +
      'for a Sheet pass CSV. The file id, name, sharing and location are unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        content: { type: 'string' },
        mimeType: { type: 'string', description: 'MIME type of `content`. Default text/markdown for a Doc, text/csv for a Sheet, otherwise the file\'s own type.' },
      },
      required: ['fileId', 'content'],
    },
  },
  {
    name: 'update_file_metadata',
    description: 'WRITES. Rename, move, describe or star a file. Only the fields passed are changed. Moving replaces the current parent folder.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        starred: { type: 'boolean' },
        moveToFolderId: { type: 'string', description: 'Destination folder id. "root" is My Drive.' },
      },
      required: ['fileId'],
    },
  },
  {
    name: 'copy_file',
    description: 'WRITES. Copy a file, optionally with a new name and into another folder. Folders cannot be copied.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        name: { type: 'string', description: 'Default: "Copy of <name>".' },
        folderId: { type: 'string', description: 'Destination folder. Default: same folder as the original.' },
      },
      required: ['fileId'],
    },
  },
  {
    name: 'trash_file',
    description: 'WRITES. Move a file or folder to the trash. Reversible with untrash_file for 30 days; nothing is permanently deleted.',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
  },
  {
    name: 'untrash_file',
    description: 'WRITES. Restore a file or folder from the trash.',
    inputSchema: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
  },
  {
    name: 'share_file',
    description:
      'WRITES and reaches other people. Grant access to a user, group, domain, or anyone with the link. ' +
      'No email is sent unless sendNotificationEmail is true.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        type: { type: 'string', enum: ['user', 'group', 'domain', 'anyone'] },
        role: { type: 'string', enum: ['reader', 'commenter', 'writer'] },
        emailAddress: { type: 'string', description: 'Required for user and group.' },
        domain: { type: 'string', description: 'Required for domain.' },
        sendNotificationEmail: { type: 'boolean', description: 'Default false.' },
        message: { type: 'string', description: 'Note included in the notification email.' },
        expirationTime: { type: 'string', description: 'RFC 3339; access ends then. Users and groups only.' },
      },
      required: ['fileId', 'type', 'role'],
    },
  },
  {
    name: 'unshare_file',
    description: 'WRITES. Remove one permission, by permission id (from get_file_permissions) or by the email address it was granted to. Pass emailAddress "anyone" to remove link sharing.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string' },
        permissionId: { type: 'string' },
        emailAddress: { type: 'string' },
      },
      required: ['fileId'],
    },
  },
];

async function listFiles(drive, { q, orderBy, pageSize, pageToken }) {
  const { data } = await drive.files.list({
    q,
    orderBy,
    pageSize,
    pageToken,
    fields: `nextPageToken,files(${FILE_FIELDS})`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: 'allDrives',
  });
  return { count: (data.files ?? []).length, nextPageToken: data.nextPageToken, files: (data.files ?? []).map(formatFile) };
}

async function searchFiles(args) {
  const drive = driveClient();
  const parts = [];
  if (args.name) parts.push(`name contains '${escapeQ(args.name)}'`);
  if (args.fullText) parts.push(`fullText contains '${escapeQ(args.fullText)}'`);
  if (args.type === 'image') parts.push(`mimeType contains 'image/'`);
  else if (args.type === 'video') parts.push(`mimeType contains 'video/'`);
  else if (args.type) parts.push(`mimeType = '${TYPE_MIME[args.type]}'`);
  if (args.mimeType) parts.push(`mimeType = '${escapeQ(args.mimeType)}'`);
  if (args.folderId) parts.push(`'${escapeQ(args.folderId)}' in parents`);
  if (args.modifiedAfter) {
    const t = new Date(args.modifiedAfter);
    if (Number.isNaN(t.getTime())) throw new Error('modifiedAfter must be an RFC 3339 timestamp.');
    parts.push(`modifiedTime > '${t.toISOString()}'`);
  }
  if (args.ownedByMe) parts.push(`'me' in owners`);
  if (!args.includeTrashed) parts.push('trashed = false');
  const q = parts.join(' and ') || undefined;
  const result = await listFiles(drive, {
    q,
    orderBy: args.orderBy || 'modifiedTime desc',
    pageSize: Math.min(Math.max(Number(args.maxResults) || 25, 1), 100),
    pageToken: args.pageToken,
  });
  return { query: q, ...result };
}

async function listRecentFiles({ maxResults, orderBy }) {
  const drive = driveClient();
  return listFiles(drive, {
    q: 'trashed = false',
    orderBy: orderBy || 'modifiedTime desc',
    pageSize: Math.min(Math.max(Number(maxResults) || 10, 1), 100),
  });
}

async function listFolder({ folderId = 'root', maxResults, pageToken }) {
  const drive = driveClient();
  const result = await listFiles(drive, {
    q: `'${escapeQ(folderId)}' in parents and trashed = false`,
    orderBy: 'folder,name',
    pageSize: Math.min(Math.max(Number(maxResults) || 100, 1), 1000),
    pageToken,
  });
  return { folderId, ...result };
}

async function getFileMetadata({ fileId }) {
  const drive = driveClient();
  const f = await getFile(drive, fileId);
  return { ...formatFile(f), path: await folderPath(drive, f.parents) };
}

function pickExport(mime, format, defaults) {
  const key = format ?? defaults[mime];
  if (!key) throw new Error(`No default export format for ${mime}; pass format.`);
  const target = EXPORT_MIME[key];
  if (!target) throw new Error(`Unknown format "${key}".`);
  return { key, target };
}

async function readFileContent({ fileId, format, maxChars }) {
  const drive = driveClient();
  const f = await getFile(drive, fileId, 'id,name,mimeType,size');
  const limit = Math.min(Math.max(Number(maxChars) || 50000, 100), 1_000_000);
  if (f.mimeType === G.folder) throw new Error('That is a folder. Use list_folder.');

  let stream;
  let exported;
  if (isGoogleNative(f.mimeType)) {
    const { key, target } = pickExport(f.mimeType, format, {
      [G.document]: 'md',
      [G.spreadsheet]: 'csv',
      [G.presentation]: 'txt',
    });
    exported = key;
    const res = await drive.files.export({ fileId, mimeType: target }, { responseType: 'stream' });
    stream = res.data;
  } else if (isTextLike(f.mimeType)) {
    const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
    stream = res.data;
  } else {
    throw new Error(`${f.name} is ${f.mimeType}, which has no text form. Use download_file to save it locally.`);
  }
  const { text, truncated } = await streamToString(stream, limit);
  return { id: f.id, name: f.name, mimeType: f.mimeType, exportedAs: exported, truncated, chars: text.length, content: text };
}

async function getFilePermissions({ fileId }) {
  const drive = driveClient();
  const { data } = await drive.permissions.list({
    fileId,
    fields: 'permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery,expirationTime,deleted,pendingOwner)',
    supportsAllDrives: true,
  });
  return { fileId, permissions: data.permissions ?? [] };
}

async function downloadFile({ fileId, destinationPath, format, overwrite }) {
  const drive = driveClient();
  requireAbsolute(destinationPath, 'destinationPath');
  const f = await getFile(drive, fileId, 'id,name,mimeType,size');
  if (f.mimeType === G.folder) throw new Error('Folders cannot be downloaded.');

  let stream;
  let exportedAs;
  let suggestedName = f.name;
  if (isGoogleNative(f.mimeType)) {
    const { key, target } = pickExport(f.mimeType, format, DEFAULT_EXPORT);
    exportedAs = key;
    if (!suggestedName.toLowerCase().endsWith(`.${key}`)) suggestedName += `.${key}`;
    const res = await drive.files.export({ fileId, mimeType: target }, { responseType: 'stream' });
    stream = res.data;
  } else {
    const res = await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
    stream = res.data;
  }

  let target = destinationPath;
  if (existsSync(target) && statSync(target).isDirectory()) target = `${target.replace(/\/$/, '')}/${suggestedName}`;
  if (existsSync(target) && !overwrite) throw new Error(`${target} already exists. Pass overwrite: true to replace it.`);
  await mkdir(dirname(target), { recursive: true });
  await pipeline(stream, createWriteStream(target));
  return { status: 'downloaded', id: f.id, name: f.name, exportedAs, path: target, bytes: statSync(target).size };
}

const IMPORT_DEFAULT_MIME = { document: 'text/markdown', spreadsheet: 'text/csv', presentation: 'text/plain' };

async function createFile({ name, content, mimeType, convertTo, folderId, description }) {
  if (!name) throw new Error('name is required.');
  const drive = driveClient();
  const requestBody = {
    name,
    description,
    ...(folderId ? { parents: [folderId] } : {}),
    ...(convertTo ? { mimeType: TYPE_MIME[convertTo] } : {}),
  };
  const sourceMime = mimeType ?? (convertTo ? IMPORT_DEFAULT_MIME[convertTo] : 'text/plain');
  const media = content !== undefined ? { mimeType: sourceMime, body: Readable.from([content]) } : undefined;
  if (!media && !convertTo) throw new Error('Pass content, or convertTo to create an empty Google file.');
  const { data } = await drive.files.create({ requestBody, media, fields: FILE_FIELDS, supportsAllDrives: true });
  return { status: 'created', sourceMimeType: media ? sourceMime : undefined, file: formatFile(data) };
}

async function createFolder({ name, parentId }) {
  if (!name) throw new Error('name is required.');
  const drive = driveClient();
  const { data } = await drive.files.create({
    requestBody: { name, mimeType: G.folder, ...(parentId ? { parents: [parentId] } : {}) },
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });
  return { status: 'created', file: formatFile(data) };
}

const EXT_MIME = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
  docx: EXPORT_MIME.docx, xlsx: EXPORT_MIME.xlsx, pptx: EXPORT_MIME.pptx, zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg',
};

async function uploadFile({ localPath, name, mimeType, convertTo, folderId }) {
  requireAbsolute(localPath, 'localPath');
  if (!existsSync(localPath) || statSync(localPath).isDirectory()) throw new Error(`${localPath} is not a file.`);
  const drive = driveClient();
  const ext = localPath.split('.').pop().toLowerCase();
  const sourceMime = mimeType ?? EXT_MIME[ext] ?? 'application/octet-stream';
  const { data } = await drive.files.create({
    requestBody: {
      name: name ?? basename(localPath),
      ...(folderId ? { parents: [folderId] } : {}),
      ...(convertTo ? { mimeType: TYPE_MIME[convertTo] } : {}),
    },
    media: { mimeType: sourceMime, body: createReadStream(localPath) },
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });
  return { status: 'uploaded', sourceMimeType: sourceMime, file: formatFile(data) };
}

async function updateFileContent({ fileId, content, mimeType }) {
  if (!fileId) throw new Error('fileId is required.');
  if (content === undefined) throw new Error('content is required.');
  const drive = driveClient();
  const f = await getFile(drive, fileId, 'id,name,mimeType');
  if (f.mimeType === G.folder) throw new Error('That is a folder.');
  const sourceMime =
    mimeType ??
    (f.mimeType === G.document ? 'text/markdown'
      : f.mimeType === G.spreadsheet ? 'text/csv'
      : f.mimeType === G.presentation ? 'text/plain'
      : f.mimeType);
  if (isGoogleNative(sourceMime)) throw new Error(`Cannot upload content as ${sourceMime}; pass a concrete mimeType.`);
  const { data } = await drive.files.update({
    fileId,
    media: { mimeType: sourceMime, body: Readable.from([content]) },
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });
  return { status: 'content replaced', sourceMimeType: sourceMime, file: formatFile(data) };
}

async function updateFileMetadata({ fileId, name, description, starred, moveToFolderId }) {
  if (!fileId) throw new Error('fileId is required.');
  const drive = driveClient();
  const requestBody = {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(starred !== undefined ? { starred } : {}),
  };
  const params = { fileId, requestBody, fields: FILE_FIELDS, supportsAllDrives: true };
  if (moveToFolderId) {
    const current = await getFile(drive, fileId, 'parents');
    params.addParents = moveToFolderId;
    params.removeParents = (current.parents ?? []).join(',') || undefined;
  }
  if (Object.keys(requestBody).length === 0 && !moveToFolderId) throw new Error('Nothing to change: pass at least one field.');
  const { data } = await drive.files.update(params);
  return {
    status: 'updated',
    changed: [...Object.keys(requestBody), ...(moveToFolderId ? ['parents'] : [])],
    file: { ...formatFile(data), path: await folderPath(drive, data.parents) },
  };
}

async function copyFile({ fileId, name, folderId }) {
  if (!fileId) throw new Error('fileId is required.');
  const drive = driveClient();
  const { data } = await drive.files.copy({
    fileId,
    requestBody: { ...(name ? { name } : {}), ...(folderId ? { parents: [folderId] } : {}) },
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });
  return { status: 'copied', file: formatFile(data) };
}

async function setTrashed(fileId, trashed) {
  if (!fileId) throw new Error('fileId is required.');
  const drive = driveClient();
  const { data } = await drive.files.update({ fileId, requestBody: { trashed }, fields: FILE_FIELDS, supportsAllDrives: true });
  return { status: trashed ? 'trashed' : 'restored', file: formatFile(data) };
}

async function shareFile({ fileId, type, role, emailAddress, domain, sendNotificationEmail = false, message, expirationTime }) {
  if (!fileId) throw new Error('fileId is required.');
  if (!['user', 'group', 'domain', 'anyone'].includes(type)) throw new Error('type must be user, group, domain or anyone.');
  if (!['reader', 'commenter', 'writer'].includes(role)) throw new Error('role must be reader, commenter or writer.');
  if ((type === 'user' || type === 'group') && !emailAddress) throw new Error(`emailAddress is required for type ${type}.`);
  if (type === 'domain' && !domain) throw new Error('domain is required for type domain.');
  const drive = driveClient();
  const { data } = await drive.permissions.create({
    fileId,
    sendNotificationEmail,
    ...(message && sendNotificationEmail ? { emailMessage: message } : {}),
    requestBody: {
      type,
      role,
      ...(emailAddress ? { emailAddress } : {}),
      ...(domain ? { domain } : {}),
      ...(type === 'anyone' ? { allowFileDiscovery: false } : {}),
      ...(expirationTime ? { expirationTime } : {}),
    },
    fields: 'id,type,role,emailAddress,domain,expirationTime',
    supportsAllDrives: true,
  });
  const f = await getFile(drive, fileId, 'id,name,webViewLink');
  return { status: 'shared', sendNotificationEmail, permission: data, file: { id: f.id, name: f.name, webViewLink: f.webViewLink } };
}

async function unshareFile({ fileId, permissionId, emailAddress }) {
  if (!fileId) throw new Error('fileId is required.');
  if (!permissionId && !emailAddress) throw new Error('Pass permissionId or emailAddress.');
  const drive = driveClient();
  let target = permissionId;
  let removed;
  if (!target) {
    const { permissions } = await getFilePermissions({ fileId });
    removed = permissions.find((p) =>
      emailAddress === 'anyone' ? p.type === 'anyone' : p.emailAddress?.toLowerCase() === emailAddress.toLowerCase()
    );
    if (!removed) throw new Error(`No permission for ${emailAddress} on this file.`);
    if (removed.role === 'owner') throw new Error('The owner permission cannot be removed.');
    target = removed.id;
  }
  await drive.permissions.delete({ fileId, permissionId: target, supportsAllDrives: true });
  return { status: 'unshared', fileId, permissionId: target, removed };
}

const HANDLERS = {
  search_files: searchFiles,
  list_recent_files: listRecentFiles,
  list_folder: listFolder,
  get_file_metadata: getFileMetadata,
  read_file_content: readFileContent,
  get_file_permissions: getFilePermissions,
  download_file: downloadFile,
  create_file: createFile,
  create_folder: createFolder,
  upload_file: uploadFile,
  update_file_content: updateFileContent,
  update_file_metadata: updateFileMetadata,
  copy_file: copyFile,
  trash_file: ({ fileId }) => setTrashed(fileId, true),
  untrash_file: ({ fileId }) => setTrashed(fileId, false),
  share_file: shareFile,
  unshare_file: unshareFile,
};

const server = new Server({ name: 'drive-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const handler = HANDLERS[request.params.name];
  if (!handler) {
    return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
  }
  try {
    const result = await handler(request.params.arguments ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    const detail = e.response?.data?.error?.message ?? e.errors?.[0]?.message;
    return { content: [{ type: 'text', text: `Error: ${detail && detail !== e.message ? `${e.message} (${detail})` : e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
