/**
 * Download the Vosk French speech recognition model.
 * Run: node scripts/download-vosk-model.js
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip';
const DEST_DIR = path.join(__dirname, '..', 'models');
const DEST_FILE = path.join(DEST_DIR, 'vosk-model-small-fr-0.22.zip');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    console.log(`Downloading ${url}...`);

    const request = (reqUrl) => {
      https.get(reqUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          request(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloaded = 0;

        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (totalBytes > 0) {
            const pct = ((downloaded / totalBytes) * 100).toFixed(1);
            process.stdout.write(`\r  ${pct}% (${(downloaded / 1e6).toFixed(1)} / ${(totalBytes / 1e6).toFixed(1)} MB)`);
          }
        });

        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('\nDone.');
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
    };

    request(url);
  });
}

async function main() {
  if (!fs.existsSync(DEST_DIR)) {
    fs.mkdirSync(DEST_DIR, { recursive: true });
  }

  if (fs.existsSync(DEST_FILE)) {
    console.log(`Model already downloaded: ${DEST_FILE}`);
    console.log('Delete it and re-run to re-download.');
    return;
  }

  await download(MODEL_URL, DEST_FILE);
  console.log(`\nModel saved to: ${DEST_FILE}`);
  console.log('The server will serve it to the browser for speech recognition.');
}

main().catch((err) => {
  console.error('Download failed:', err.message);
  process.exit(1);
});
