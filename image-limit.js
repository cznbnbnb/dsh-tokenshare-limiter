/**
 * TokenShare 图片上限兼容：把上游 400 转成宿主原生的持久化图片转存。
 *
 * 不改写 llm/stream 中冻结的请求消息，也不删除会话图片。只选择最旧的、
 * 尚未转存的输入图片写入 image/offload；宿主随后会用占位文本和只读路径
 * 重新组装请求。原始图片仍完整保留在会话与附件存储中。
 */

const IMAGE_LIMIT_RE = /\bat\s+most\s+(\d+)\s+image(?:\(s\)|s)?\s+may\s+be\s+provided\s+in\s+one\s+prompt\b/i

/** 仅识别明确的图片数量限制错误，其它 400 一律原样交回。 */
export function imageLimitFromFailure(failure) {
  if (!failure || typeof failure !== 'object') return null
  if (failure.status !== undefined ? failure.status !== 400 : failure.code !== 'INVALID_REQUEST') return null
  const match = IMAGE_LIMIT_RE.exec(typeof failure.message === 'string' ? failure.message : '')
  if (!match) return null
  const maxImages = Number(match[1])
  return Number.isSafeInteger(maxImages) && maxImages > 0 ? maxImages : null
}

/** 按当前模型请求顺序读取可转存的输入消息。 */
function* inputMessages(session) {
  const nodes = session?.surface?.nodes
  if (!nodes || typeof nodes[Symbol.iterator] !== 'function') return
  for (const seq of nodes) {
    let event
    let message
    try {
      event = session.eventAt(seq)
      if (event?.type !== 'user/message' && event?.type !== 'tool/result') continue
      message = session.deriveEventMessage(event)
    } catch {
      continue
    }
    if (message && Array.isArray(message.content)) yield { seq, message }
  }
}

/** 当前请求中仍会随请求发送的图片数量；已转存图片只占位，不计入。 */
export function retainedImageCount(session) {
  let count = 0
  for (const { message } of inputMessages(session)) {
    for (const block of message.content) {
      if (block?.type === 'image' && block.offloaded !== true) count += 1
    }
  }
  return count
}

/** 选择最旧的 count 张图片，图片下标与宿主 image/offload 投影完全一致。 */
export function oldestImageTargets(session, count) {
  if (!Number.isSafeInteger(count) || count <= 0) return []
  let remaining = count
  const targets = []
  for (const { seq, message } of inputMessages(session)) {
    if (remaining === 0) break
    const imageIndexes = []
    let imageIndex = 0
    for (const block of message.content) {
      if (remaining === 0) break
      if (block?.type !== 'image') continue
      if (block.offloaded !== true) {
        imageIndexes.push(imageIndex)
        remaining -= 1
      }
      imageIndex += 1
    }
    if (imageIndexes.length > 0) targets.push({ seq, imageIndexes })
  }
  return targets
}

/** 一条尚未进入会话的 pre-step decision 中，需要为请求预留的图片数。 */
export function pendingImageCount(messages) {
  let count = 0
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const block of Array.isArray(message?.content) ? message.content : []) {
      if (block?.type === 'image' && block.offloaded !== true) count += 1
    }
  }
  return count
}

/**
 * 发送前把当前 surface 与即将准入的图片合计限制在 maxImages 内。
 * 尚未准入的消息不能成为 image/offload 的持久化目标，因此只从 surface
 * 选择；极端情况下新输入本身就超限，仍由 400 兜底在提交后恢复。
 */
export function offloadImagesToBudget(agent, maxImages, reservedImages = 0) {
  if (!Number.isSafeInteger(maxImages) || maxImages <= 0) return null
  const reserved = Number.isSafeInteger(reservedImages) && reservedImages > 0 ? reservedImages : 0
  const session = agent?.session
  const retained = retainedImageCount(session)
  const overflow = Math.max(0, retained + reserved - maxImages)
  const required = Math.min(overflow, retained)
  if (required === 0) return null
  const targets = oldestImageTargets(session, required)
  const offloaded = targets.reduce((sum, target) => sum + target.imageIndexes.length, 0)
  if (offloaded !== required || typeof session?.append !== 'function') return null
  session.append('image/offload', { targets })
  return { maxImages, retained, reservedImages: reserved, offloaded, targets }
}

/**
 * 如果 failure 是明确的图片上限错误且历史确实超限，则记录转存并返回详情。
 * 返回 null 表示本插件不应接管该失败，调用方必须继续 next()。
 */
export function offloadImagesForFailure(agent, failure) {
  const maxImages = imageLimitFromFailure(failure)
  return maxImages === null ? null : offloadImagesToBudget(agent, maxImages)
}
