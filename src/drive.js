import { google } from "googleapis";
import { readFile, createReadStream } from "fs";
import { Readable } from "stream";

// ---------------------------------------------------------------------------
// Auth & Client
// ---------------------------------------------------------------------------

function getAuth() {
  // OAuth2 방식 (개인 Drive용, 우선)
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return oauth2;
  }

  // 서비스 계정 방식 (Shared Drive 전용)
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    const credentials = JSON.parse(
      Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, "base64").toString("utf-8")
    );
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
  }

  throw new Error("GOOGLE_REFRESH_TOKEN 또는 GOOGLE_SERVICE_ACCOUNT_KEY 환경 변수가 필요합니다.");
}

function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

function rootId() {
  if (!process.env.GDRIVE_FOLDER_ID) {
    throw new Error("GDRIVE_FOLDER_ID 환경 변수가 설정되지 않았습니다.");
  }
  return process.env.GDRIVE_FOLDER_ID;
}

// Drive query에서 작은따옴표 이스케이프
function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// Core: Find / List
// ---------------------------------------------------------------------------

async function findItem(drive, parentId, name, mimeType = null) {
  let q = `name='${esc(name)}' and '${parentId}' in parents and trashed=false`;
  if (mimeType) q += ` and mimeType='${mimeType}'`;
  const res = await drive.files.list({
    q,
    fields: "files(id, name, mimeType)",
    spaces: "drive",
  });
  return res.data.files[0] || null;
}

// ---------------------------------------------------------------------------
// JSON 파일 읽기/쓰기 (expenses.json 등)
// ---------------------------------------------------------------------------

export async function readJsonFile(fileName) {
  const drive = getDrive();
  const file = await findItem(drive, rootId(), fileName);
  if (!file) return null;
  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "text" }
  );
  return JSON.parse(res.data);
}

export async function writeJsonFile(fileName, data) {
  const drive = getDrive();
  const content = JSON.stringify(data, null, 2);
  const existing = await findItem(drive, rootId(), fileName);
  const stream = Readable.from([content]);

  if (existing) {
    await drive.files.update({
      fileId: existing.id,
      media: { mimeType: "application/json", body: stream },
    });
  } else {
    await drive.files.create({
      requestBody: { name: fileName, parents: [rootId()] },
      media: { mimeType: "application/json", body: stream },
    });
  }
}

// ---------------------------------------------------------------------------
// 폴더 관리
// ---------------------------------------------------------------------------

export async function findOrCreateFolder(folderName, parentId = null) {
  const drive = getDrive();
  const pid = parentId || rootId();
  const existing = await findItem(
    drive, pid, folderName,
    "application/vnd.google-apps.folder"
  );
  if (existing) return existing.id;

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [pid],
    },
    fields: "id",
  });
  return created.data.id;
}

export async function getFolderIdByName(folderName) {
  const drive = getDrive();
  const folder = await findItem(
    drive, rootId(), folderName,
    "application/vnd.google-apps.folder"
  );
  return folder?.id || null;
}

export async function listSubfolders() {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `'${rootId()}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
    pageSize: 100,
  });
  return res.data.files || [];
}

// ---------------------------------------------------------------------------
// 파일 목록
// ---------------------------------------------------------------------------

export async function listFilesInFolder(folderId) {
  const drive = getDrive();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
    fields: "files(id, name, mimeType)",
    pageSize: 1000,
  });
  return res.data.files || [];
}

// ---------------------------------------------------------------------------
// 파일 다운로드
// ---------------------------------------------------------------------------

export async function downloadFileAsBuffer(fileId) {
  const drive = getDrive();
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

// ---------------------------------------------------------------------------
// 파일 업로드
// ---------------------------------------------------------------------------

export async function uploadLocalFile(localPath, fileName, mimeType, folderId) {
  const drive = getDrive();
  const existing = await findItem(drive, folderId, fileName);
  const { createReadStream: crs } = await import("fs");
  const media = { mimeType, body: crs(localPath) };

  if (existing) {
    await drive.files.update({ fileId: existing.id, media });
  } else {
    await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media,
    });
  }
}

export async function uploadBuffer(buffer, fileName, mimeType, folderId) {
  const drive = getDrive();
  const stream = Readable.from(buffer);
  const existing = await findItem(drive, folderId, fileName);

  if (existing) {
    await drive.files.update({
      fileId: existing.id,
      media: { mimeType, body: stream },
    });
  } else {
    await drive.files.create({
      requestBody: { name: fileName, parents: [folderId] },
      media: { mimeType, body: stream },
    });
  }
}

// ---------------------------------------------------------------------------
// 로컬 이미지 → Drive 복사
// ---------------------------------------------------------------------------

const MIME_MAP = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  pdf: "application/pdf",
  bmp: "image/bmp",
};

export async function copyLocalImageToDrive(sourcePath, targetFileName, folderName) {
  const folderId = await findOrCreateFolder(folderName);
  const data = await readFileAsync(sourcePath);
  const ext = targetFileName.split(".").pop().toLowerCase();
  const mimeType = MIME_MAP[ext] || "application/octet-stream";
  await uploadBuffer(data, targetFileName, mimeType, folderId);
  return folderId;
}

function readFileAsync(path) {
  return new Promise((resolve, reject) => {
    readFile(path, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// ---------------------------------------------------------------------------
// 상대 경로로 파일 찾기 (예: "2월 경비/IMG_001.jpg")
// ---------------------------------------------------------------------------

export async function findFileByRelativePath(relativePath) {
  const parts = relativePath.split("/");
  if (parts.length !== 2) return null;
  const [folderName, fileName] = parts;

  const drive = getDrive();
  const folder = await findItem(
    drive, rootId(), folderName,
    "application/vnd.google-apps.folder"
  );
  if (!folder) return null;
  return findItem(drive, folder.id, fileName);
}
