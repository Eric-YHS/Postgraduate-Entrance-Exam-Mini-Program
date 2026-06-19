const path = require('path');
const multer = require('multer');
const crypto = require('crypto');

const ALLOWED_EXTENSIONS = /\.(jpg|jpeg|png|gif|webp|mp4|webm|mov|pdf|doc|docx|xls|xlsx|csv|ppt|pptx|zip|rar|txt|md)$/i;
const UPLOAD_LIMITS = { fileSize: 100 * 1024 * 1024 };

module.exports = function registerUploadRoutes(app, shared) {
  const { uploadRootDir, requireAuth } = shared;

  function fileFilter(request, file, callback) {
    if (ALLOWED_EXTENSIONS.test(path.extname(file.originalname || ''))) {
      callback(null, true);
    } else {
      callback(new Error('不支持的文件类型。'));
    }
  }

  const generalUpload = multer({
    storage: multer.diskStorage({
      destination: (request, file, callback) => {
        const dest = path.join(uploadRootDir, 'general');
        // eslint-disable-next-line global-require
        require('fs').mkdirSync(dest, { recursive: true });
        callback(null, dest);
      },
      filename: (request, file, callback) => {
        const extension = path.extname(file.originalname || '');
        const hash = crypto.randomBytes(8).toString('hex');
        const base = path.basename(file.originalname || 'file', extension).replace(/[^\w一-鿿\-]+/g, '_').slice(0, 50);
        callback(null, `${Date.now()}-${hash}-${base}${extension}`);
      }
    }),
    fileFilter,
    limits: UPLOAD_LIMITS
  }).single('file');

  function toPublicUrl(absolutePath) {
    const normalizedRoot = uploadRootDir.split(path.sep).join('/');
    const normalizedPath = absolutePath.split(path.sep).join('/');
    if (normalizedPath.startsWith(normalizedRoot)) {
      return `/uploads${normalizedPath.slice(normalizedRoot.length)}`;
    }
    return normalizedPath;
  }

  // 通用单文件上传（小程序论坛媒体、附件等使用）
  app.post('/api/upload', requireAuth, (request, response) => {
    generalUpload(request, fileResponse(request, response));
  });

  function fileResponse(request, response) {
    return (error) => {
      if (error) {
        if (error instanceof multer.MulterError) {
          return response.status(400).json({ code: -1, message: `上传失败：${error.message}` });
        }
        return response.status(400).json({ code: -1, message: error.message || '上传失败' });
      }
      if (!request.file) {
        return response.status(400).json({ code: -1, message: '未收到文件' });
      }
      const url = toPublicUrl(request.file.path);
      response.json({
        code: 0,
        data: {
          url,
          name: request.file.originalname,
          size: request.file.size
        }
      });
    };
  }
};
