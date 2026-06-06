const fs = require('fs');

/**
 * Synchronously ensures that a directory exists at the given path.
 * If the directory does not exist, it is created recursively.
 *
 * @param {string} dirPath - The absolute or relative path to the directory.
 * @returns {void}
 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Appends the content of a file to an active writable output stream.
 * Resolves when the file content has been fully piped without closing the target stream.
 *
 * @param {string} sourceFilePath - The path of the source file to read.
 * @param {stream.Writable} outputStream - The target writable stream.
 * @returns {Promise<void>} Resolves on success, or rejects with an error.
 */
function appendFileToStream(sourceFilePath, outputStream) {
  return new Promise((resolve, reject) => {
    const inputStream = fs.createReadStream(sourceFilePath);

    inputStream.on('error', reject);
    inputStream.on('end', resolve);
    inputStream.pipe(outputStream, { end: false });
  });
}

module.exports = {
  ensureDir,
  appendFileToStream
};

