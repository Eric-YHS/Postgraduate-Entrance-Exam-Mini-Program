const USE_MOCK = true;
const UPLOAD_URL = 'https://api.kaoyan.com/api/upload';

/** 上传结果 */
export interface UploadResult {
  url: string;
  name?: string;
  size?: number;
}

/** 选择图片（最多 9 张） */
export function chooseImages(max = 9): Promise<string[]> {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: max,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        resolve(res.tempFiles.map((file) => file.tempFilePath));
      },
      fail: reject,
    });
  });
}

/** 选择视频（最多 1 个，60 秒） */
export function chooseVideo(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['album', 'camera'],
      maxDuration: 60,
      camera: 'back',
      success: (res) => {
        const path = res.tempFiles[0]?.tempFilePath;
        resolve(path || null);
      },
      fail: reject,
    });
  });
}

/** 选择附件（最多 3 个） */
export function chooseAttachments(max = 3): Promise<Array<{ name: string; path: string; size: number }>> {
  return new Promise((resolve, reject) => {
    wx.chooseMessageFile({
      count: max,
      type: 'file',
      success: (res) => {
        resolve(
          res.tempFiles.map((file) => ({
            name: file.name,
            path: file.path,
            size: file.size,
          }))
        );
      },
      fail: reject,
    });
  });
}

/** 上传单文件到服务端 */
function uploadFile(filePath: string, formData?: Record<string, string>): Promise<UploadResult> {
  if (USE_MOCK) {
    return Promise.resolve({
      url: filePath,
      name: formData?.name,
      size: formData?.size ? Number(formData.size) : undefined,
    });
  }

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: UPLOAD_URL,
      filePath,
      name: 'file',
      formData,
      header: {
        Authorization: `Bearer ${wx.getStorageSync('ky_token') || ''}`,
      },
      success: (res) => {
        try {
          const data = JSON.parse(res.data);
          if (data.code === 0) {
            resolve(data.data as UploadResult);
          } else {
            reject(new Error(data.message || '上传失败'));
          }
        } catch {
          reject(new Error('上传响应解析失败'));
        }
      },
      fail: reject,
    });
  });
}

/** 上传图片列表 */
export async function uploadImages(paths: string[]): Promise<UploadResult[]> {
  if (USE_MOCK) {
    return paths.map((url) => ({ url }));
  }
  return Promise.all(paths.map((path) => uploadFile(path, { type: 'image' })));
}

/** 上传视频 */
export async function uploadVideo(path: string): Promise<UploadResult> {
  if (USE_MOCK) {
    return { url: path };
  }
  return uploadFile(path, { type: 'video' });
}

/** 上传附件列表 */
export async function uploadAttachments(
  files: Array<{ name: string; path: string; size: number }>
): Promise<UploadResult[]> {
  if (USE_MOCK) {
    return files.map((file) => ({ url: file.path, name: file.name, size: file.size }));
  }
  return Promise.all(
    files.map((file) =>
      uploadFile(file.path, {
        type: 'attachment',
        name: file.name,
        size: String(file.size),
      })
    )
  );
}
