import { diffBlocks } from './blocks.js'
import { textFromBlocks } from './blocks.js'

function maps(ancestorBlocks, localBlocks, remoteBlocks) {
  return {
    ancestor: new Map(ancestorBlocks.map((block) => [block.id, block])),
    local: new Map(localBlocks.map((block) => [block.id, block])),
    remote: new Map(remoteBlocks.map((block) => [block.id, block])),
  }
}

function detectInsertAnchorConflicts(ancestorBlocks, remoteBlocks, localOperations) {
  const ancestor = new Map(ancestorBlocks.map((block) => [block.id, block]))
  const remote = new Map(remoteBlocks.map((block) => [block.id, block]))
  const locallyInserted = new Set(
    localOperations.filter((op) => op.type === 'insert_node').map((op) => op.nodeId))

  return localOperations
    .filter((op) => op.type === 'insert_node')
    .filter((op) => op.afterNodeId && ancestor.has(op.afterNodeId) && !remote.has(op.afterNodeId))
    .filter((op) => !locallyInserted.has(op.afterNodeId))
    .map((op) => ({
      id: `structure:${op.nodeId}:missing-anchor`,
      type: 'structure',
      nodeId: op.nodeId,
      title: '本地插入锚点已在云端删除',
      ancestor: ancestor.get(op.afterNodeId)?.content || '',
      local: op.content,
      remote: '(锚点已删除)',
    }))
}

function detectConflicts(ancestorBlocks, localBlocks, remoteBlocks, localOperations = []) {
  const { ancestor, local, remote } = maps(ancestorBlocks, localBlocks, remoteBlocks)
  const ids = new Set([...ancestor.keys(), ...local.keys(), ...remote.keys()])
  const conflicts = []

  for (const nodeId of ids) {
    const a = ancestor.get(nodeId)
    const l = local.get(nodeId)
    const r = remote.get(nodeId)

    if (l && r && a && l.content !== a.content && r.content !== a.content && l.content !== r.content) {
      conflicts.push({
        id: `content:${nodeId}`,
        type: 'content',
        nodeId,
        title: '同一节点内容被双方修改',
        ancestor: a.content,
        local: l.content,
        remote: r.content,
      })
    }

    if (l && !r && a && l.content !== a.content) {
      conflicts.push({
        id: `structure:${nodeId}:local-edit-remote-delete`,
        type: 'structure',
        nodeId,
        title: '本地修改了节点，但云端删除了该节点',
        ancestor: a.content,
        local: l.content,
        remote: '',
      })
    }

    if (!l && r && a && r.content !== a.content) {
      conflicts.push({
        id: `structure:${nodeId}:local-delete-remote-edit`,
        type: 'structure',
        nodeId,
        title: '云端修改了节点，但本地删除了该节点',
        ancestor: a.content,
        local: '',
        remote: r.content,
      })
    }
  }

  conflicts.push(...detectInsertAnchorConflicts(ancestorBlocks, remoteBlocks, localOperations))
  return conflicts
}

function autoMerge(ancestorBlocks, localBlocks, remoteBlocks) {
  const { ancestor, local, remote } = maps(ancestorBlocks, localBlocks, remoteBlocks)
  const result = []
  const appendLocal = (block) => {
    if (block && !result.some((item) => item.id === block.id)) result.push({ ...block })
  }
  const appendRemote = (block) => {
    if (block && !result.some((item) => item.id === block.id)) result.push({ ...block })
  }

  for (const block of remoteBlocks) {
    const a = ancestor.get(block.id)
    const l = local.get(block.id)
    if (!a && l) {
      appendLocal(l)
    } else if (a && l && l.content !== a.content && block.content === a.content) {
      appendLocal(l)
    } else {
      appendRemote(block)
    }
  }

  for (const block of localBlocks) {
    const a = ancestor.get(block.id)
    const r = remote.get(block.id)
    if (!a && !r) appendLocal(block)
    else if (a && !r && block.content === a.content) {
      // Both deleted the node.
    } else if (a && !r && block.content !== a.content) {
      appendLocal(block) // surfaced as structural conflict
    }
  }

  return result
}

/**
 * Three-way node merge. This never compares timestamps alone: content topology
 * relative to the common ancestor determines whether auto-merge is possible.
 */
export function threeWayMerge(ancestorBlocks, localBlocks, remoteBlocks, localOperations = []) {
  const conflicts = detectConflicts(ancestorBlocks, localBlocks, remoteBlocks, localOperations)
  const proposedBlocks = conflicts.length === 0
    ? autoMerge(ancestorBlocks, localBlocks, remoteBlocks)
    : buildConflictPlaceholder(ancestorBlocks, localBlocks, remoteBlocks, conflicts)
  return {
    conflicts,
    proposedBlocks,
    proposedText: textFromBlocks(proposedBlocks),
  }
}

function buildConflictPlaceholder(ancestorBlocks, localBlocks, remoteBlocks, conflicts) {
  const merged = autoMerge(ancestorBlocks, localBlocks, remoteBlocks)
  const markers = new Map()
  for (const conflict of conflicts) {
    const index = merged.findIndex((block) => block.id === conflict.nodeId)
    const marker = {
      id: `conflict-${conflict.id}`,
      content: conflict.type === 'content'
        ? `<<<<<<< 本地\n${conflict.local}\n=======\n${conflict.remote}\n>>>>>>> 云端`
        : `<<<<<<< ${conflict.title}\n本地: ${conflict.local || '(已删除)'}\n云端: ${conflict.remote || '(已删除)'}\n>>>>>>>`,
    }
    markers.set(index >= 0 ? index : merged.length, marker)
  }
  const output = []
  for (let i = 0; i < merged.length; i += 1) {
    if (markers.has(i)) output.push(markers.get(i))
    output.push(merged[i])
  }
  if (markers.has(merged.length)) output.push(markers.get(merged.length))
  return output
}

export function applyResolutionChoice(mergeResult, choice, editedTextByNode = {}) {
  let blocks = autoMerge(
    mergeResult.ancestorBlocks,
    mergeResult.localBlocks,
    mergeResult.remoteBlocks,
  )

  for (const conflict of mergeResult.conflicts) {
    const selected = choice[conflict.id] || 'local'
    if (selected === 'local') {
      if (mergeResult.localBlocks.some((block) => block.id === conflict.nodeId)) {
        blocks = blocks.map((block) => block.id === conflict.nodeId
          ? { ...block, content: editedTextByNode[conflict.id] ?? conflict.local }
          : block)
      } else {
        blocks = blocks.filter((block) => block.id !== conflict.nodeId)
      }
    } else if (selected === 'remote') {
      const remote = mergeResult.remoteBlocks.find((block) => block.id === conflict.nodeId)
      if (remote) {
        blocks = blocks.map((block) => block.id === conflict.nodeId
          ? { ...block, content: editedTextByNode[conflict.id] ?? remote.content }
          : block)
      } else {
        blocks = blocks.filter((block) => block.id !== conflict.nodeId)
      }
    } else if (selected === 'manual') {
      const content = editedTextByNode[conflict.id] ?? ''
      blocks = blocks.map((block) => block.id === conflict.nodeId ? { ...block, content } : block)
    }
  }

  return blocks
}

export function operationsToReach(baseBlocks, targetText) {
  return diffBlocks(baseBlocks, targetText).operations
}
