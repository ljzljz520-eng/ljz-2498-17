export const DOC_ID = 'doc-1'
export const DEVICE_ID_STORAGE_KEY = 'catalpa.deviceId'
export const QUEUE_STORAGE_KEY = `catalpa.queue.${DOC_ID}`
export const CACHE_STORAGE_KEY = `catalpa.rebuildableCache.${DOC_ID}`
export const SERVER_STORAGE_KEY = `catalpa.mockServer.${DOC_ID}`
export const CONTROL_STORAGE_KEY = `catalpa.mockControl`
export const SCHEMA_VERSION = 2

export const OP_TYPES = Object.freeze({
  INSERT_NODE: 'insert_node',
  UPDATE_NODE: 'update_node',
  DELETE_NODE: 'delete_node',
})

export const OP_STATUS = Object.freeze({
  QUEUED: 'queued',
  IN_FLIGHT: 'in_flight',
  ACKED: 'acked',
  REJECTED: 'rejected',
})

export const SAVE_STATUS = Object.freeze({
  LOCAL: '本地已保存',
  REMOTE: '服务器已接收',
  CHECKPOINT: '命名保存点',
  WAITING: '等待同步',
  CONFLICT: '需要处理冲突',
  QUOTA: '本地保存失败',
})
