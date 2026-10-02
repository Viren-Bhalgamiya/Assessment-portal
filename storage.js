'use strict';
// File storage for snapshots, audio clips and use-case PDFs. Two backends behind one API:
//   - local disk under DATA_DIR (default, for local runs and testing)
//   - Azure Blob Storage when AZURE_STORAGE_CONNECTION_STRING is set (Azure App Service)
// Keys look like "snapshots/12/1700000000000-camera.jpg" or "usecases/3.pdf".
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./db');

const AZURE = !!process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER = process.env.AZURE_STORAGE_CONTAINER || 'portal';

const safeKey = (key) => {
  const k = String(key).replace(/\\/g, '/');
  if (k.split('/').some((p) => p === '..' || p === '')) throw new Error(`Invalid storage key: ${key}`);
  return k;
};

// ---------- local disk ----------
function localStore() {
  const full = (key) => path.join(DATA_DIR, ...safeKey(key).split('/'));
  const madeDirs = new Set();
  return {
    async init() { fs.mkdirSync(DATA_DIR, { recursive: true }); },
    // Disk writes go through the thread pool so they never pause other students' requests.
    async put(key, buf) {
      const file = full(key);
      const dir = path.dirname(file);
      if (!madeDirs.has(dir)) { await fs.promises.mkdir(dir, { recursive: true }); madeDirs.add(dir); }
      await fs.promises.writeFile(file, buf);
    },
    async remove(key) { await fs.promises.rm(full(key), { force: true }); },
    async removePrefix(prefix) {
      const dir = full(prefix.replace(/\/$/, ''));
      for (const d of madeDirs) if (d === dir || d.startsWith(dir + path.sep)) madeDirs.delete(d);
      await fs.promises.rm(dir, { recursive: true, force: true });
    },
    // Streams the file to the response; returns false if it doesn't exist.
    async send(res, key, headers = {}) {
      const file = full(key);
      if (!fs.existsSync(file)) return false;
      for (const [h, v] of Object.entries(headers)) res.setHeader(h, v);
      await new Promise((resolve, reject) => res.sendFile(file, (err) => (err && !res.headersSent ? reject(err) : resolve())));
      return true;
    },
  };
}

// ---------- Azure Blob Storage ----------
function azureStore() {
  const { BlobServiceClient } = require('@azure/storage-blob');
  const container = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING).getContainerClient(CONTAINER);
  const blob = (key) => container.getBlockBlobClient(safeKey(key));
  return {
    async init() { await container.createIfNotExists(); }, // private container: files are only served through the app
    async put(key, buf, contentType = 'application/octet-stream') {
      await blob(key).uploadData(buf, { blobHTTPHeaders: { blobContentType: contentType } });
    },
    async remove(key) { await blob(key).deleteIfExists(); },
    async removePrefix(prefix) {
      const p = safeKey(prefix.replace(/\/$/, '')) + '/';
      for await (const b of container.listBlobsFlat({ prefix: p })) await container.deleteBlob(b.name).catch(() => {});
    },
    async send(res, key, headers = {}) {
      let dl;
      try {
        dl = await blob(key).download();
      } catch (e) {
        if (e.statusCode === 404) return false;
        throw e;
      }
      res.setHeader('Content-Type', headers['Content-Type'] || dl.contentType || 'application/octet-stream');
      if (dl.contentLength !== undefined) res.setHeader('Content-Length', dl.contentLength);
      for (const [h, v] of Object.entries(headers)) res.setHeader(h, v);
      await new Promise((resolve, reject) => {
        dl.readableStreamBody.on('error', reject).pipe(res).on('finish', resolve).on('error', reject);
      });
      return true;
    },
  };
}

module.exports = { AZURE, ...(AZURE ? azureStore() : localStore()) };
