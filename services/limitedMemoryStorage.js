'use strict';

const { MAX_TOTAL_UPLOAD_BYTES } = require('./multimodalInputValidation');

class LimitedMemoryStorage {
  _handleFile(req, file, callback) {
    const chunks = [];
    let fileSize = 0;
    let limitError = null;
    let finished = false;

    const finish = (error, result) => {
      if (finished) {
        return;
      }
      finished = true;
      callback(error, result);
    };

    if (!Number.isFinite(req.multimodalUploadBytes)) {
      req.multimodalUploadBytes = 0;
    }

    file.stream.on('data', (chunk) => {
      req.multimodalUploadBytes += chunk.length;
      fileSize += chunk.length;

      if (req.multimodalUploadBytes > MAX_TOTAL_UPLOAD_BYTES) {
        chunks.length = 0;
        if (!limitError) {
          limitError = new Error('The combined file size must not exceed 20 MB');
          limitError.code = 'LIMIT_TOTAL_FILE_SIZE';
        }
        return;
      }

      if (!limitError) {
        chunks.push(chunk);
      }
    });

    file.stream.once('error', (error) => finish(error));
    file.stream.once('end', () => {
      if (limitError) {
        finish(limitError);
        return;
      }
      finish(null, {
        buffer: Buffer.concat(chunks, fileSize),
        size: fileSize
      });
    });
  }

  _removeFile(req, file, callback) {
    delete file.buffer;
    callback(null);
  }
}

module.exports = function createLimitedMemoryStorage() {
  return new LimitedMemoryStorage();
};
