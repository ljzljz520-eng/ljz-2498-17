// Three-way merge of node operations.
//
// Given:
//   ancestor: node[]      — the common base (last rebased / checkpoint)
//   localOps: op[]        — our branch (device), applied on ancestor
//   remoteOps: op[]       — cloud branch, applied on ancestor
//
// Produce a merged node list and a list of conflicts that need a human.
// Crucially this is NOT "compare last timestamp wins": it compares the two
// branches structurally against their common ancestor (like a git merge).

import { applyOps } from './ops.js'

const CONFLICT = Object.freeze({
  UPDATE_UPDATE: 'update_update', // both edited same node differently
  DELETE_UPDATE: 'delete_update', // one deleted, other edited
  ORDER: 'order', // both re-created/inserted with competing anchors
})

// Summarize what a branch did to each node.
function branchIndex(ancestor, ops) {
  const byNode = new Map()
  const inserts = [] // ops in order
  for (const op of ops) {
    if (op.type === 'insert') {
      byNode.set(op.nodeId, {
        inserted: true,
        op,
        content: op.content,
        afterId: op.afterId,
      })
      inserts.push(op)
    } else if (op.type === 'update') {
      const prev = byNode.get(op.nodeId) || {}
      byNode.set(op.nodeId, {
        ...prev,
        updated: true,
        op,
        content: op.content || prev.content,
      })
    } else if (op.type === 'delete') {
      const prev = byNode.get(op.nodeId) || {}
      byNode.set(op.nodeId, { ...prev, deleted: true, op })
    }
  }
  return { byNode, inserts }
}

const contentEqual = (a, b) =>
  !!a && !!b && a.kind === b.kind && a.text === b.text

/**
 * Three-way merge.
 *
 * @param ancestor   node[]  common base (the client's rebased version)
 * @param localOps   op[]    device branch applied on ancestor
 * @param remoteOps  op[]    cloud ops newer than the ancestor
 * @param cloudNodes node[]  (optional) the cloud's CURRENT node state. This is
 *                   authoritative for content comparisons: a node the client
 *                   edits may differ from what is actually on the cloud even
 *                   when the responsible cloud op arrived via an earlier
 *                   folded auto-merge and is therefore absent from remoteOps.
 */
export function threeWayMerge(ancestor, localOps, remoteOps, cloudNodes = null) {
  const base = ancestor || []
  const local = branchIndex(base, localOps)
  const remote = branchIndex(base, remoteOps)
  const ancestorById = new Map(base.map((n) => [n.id, n]))
  // Effective cloud state per node: an explicit remote op wins, otherwise the
  // current cloud snapshot (which includes older merged content) is used.
  const cloudState = new Map((cloudNodes || []).map((n) => [n.id, n]))

  const conflicts = []
  const conflictNodes = new Set()
  const localDelete = new Set()
  const remoteDelete = new Set()

  const allNodeIds = new Set([
    ...ancestorById.keys(),
    ...local.byNode.keys(),
    ...remote.byNode.keys(),
    ...cloudState.keys(),
  ])

  // Decide final content per node (when no conflict).
  const finalContent = new Map() // nodeId -> node
  for (const id of allNodeIds) {
    const aNode = ancestorById.get(id)
    const L = local.byNode.get(id)
    const R = remote.byNode.get(id)
    const existed = !!aNode

    if (L?.deleted) localDelete.add(id)
    if (R?.deleted) remoteDelete.add(id)

    const localWrote = L && (L.inserted || L.updated)
    const remoteWrote = R && (R.inserted || R.updated)

    // Both delete => fine (delete wins, no conflict).
    if (L?.deleted && R?.deleted) continue

    // One side deletes, other side leaves untouched => delete wins.
    if (L?.deleted && !remoteWrote) continue
    if (R?.deleted && !localWrote) continue

    // One side deletes while the other edits => structural conflict.
    if (L?.deleted && remoteWrote && !existed) {
      // remote re-created something local never knew; treat as keep remote
      finalContent.set(id, { id, ...R.content })
      continue
    }
    if (R?.deleted && localWrote && !existed) {
      finalContent.set(id, { id, ...L.content })
      continue
    }
    if (L?.deleted && remoteWrote) {
      conflicts.push({
        id: `c_${id}_du`,
        kind: CONFLICT.DELETE_UPDATE,
        nodeId: id,
        deletedBy: 'local',
        ancestorNode: aNode || null,
        local: { action: 'delete', op: L.op, node: null },
        remote: { action: 'edit', op: R.op, node: { id, ...R.content } },
      })
      conflictNodes.add(id)
      continue
    }
    if (R?.deleted && localWrote) {
      conflicts.push({
        id: `c_${id}_ud`,
        kind: CONFLICT.DELETE_UPDATE,
        nodeId: id,
        deletedBy: 'remote',
        ancestorNode: aNode || null,
        local: { action: 'edit', op: L.op, node: { id, ...L.content } },
        remote: { action: 'delete', op: R.op, node: null },
      })
      conflictNodes.add(id)
      continue
    }

    // Both edited an existing node.
    if (localWrote && remoteWrote) {
      const lc = L.content
      const rc = R.content
      if (contentEqual(lc, rc)) {
        finalContent.set(id, { id, ...lc })
        continue
      }
      // If one side simply matches ancestor it made no effective change.
      const localChanged =
        !aNode || !contentEqual({ kind: aNode.kind, text: aNode.text }, lc)
      const remoteChanged =
        !aNode || !contentEqual({ kind: aNode.kind, text: aNode.text }, rc)
      if (!localChanged && remoteChanged) {
        finalContent.set(id, { id, ...rc })
        continue
      }
      if (!remoteChanged && localChanged) {
        finalContent.set(id, { id, ...lc })
        continue
      }
      conflicts.push({
        id: `c_${id}_uu`,
        kind: CONFLICT.UPDATE_UPDATE,
        nodeId: id,
        ancestorNode: aNode || null,
        local: { action: 'edit', op: L.op, node: { id, ...lc } },
        remote: { action: 'edit', op: R.op, node: { id, ...rc } },
      })
      conflictNodes.add(id)
      continue
    }

    // Local edited a node the cloud branch window did not touch, but the
    // cloud's CURRENT state may still differ from the ancestor (the change
    // arrived via an earlier folded auto-merge). Compare against the actual
    // cloud node so we never silently overwrite committed cloud content.
    if (localWrote && !remoteWrote) {
      const lc = L.content
      const cloudNode = cloudState.get(id)
      if (cloudNode) {
        if (contentEqual(lc, { kind: cloudNode.kind, text: cloudNode.text })) {
          finalContent.set(id, { id, ...lc })
          continue
        }
        // If the cloud node is unchanged from the ancestor, the local edit is
        // the only effective change -> clean, no conflict.
        const cloudChangedFromAncestor =
          !aNode || !contentEqual({ kind: aNode.kind, text: aNode.text }, cloudNode)
        if (!cloudChangedFromAncestor) {
          finalContent.set(id, { id, ...lc })
          continue
        }
        // Otherwise both lines genuinely diverged from the ancestor.
        conflicts.push({
          id: `c_${id}_uc`,
          kind: CONFLICT.UPDATE_UPDATE,
          nodeId: id,
          ancestorNode: aNode || null,
          local: { action: 'edit', op: L.op, node: { id, ...lc } },
          remote: {
            action: 'cloud',
            op: null,
            node: { id, kind: cloudNode.kind, text: cloudNode.text },
          },
        })
        conflictNodes.add(id)
        continue
      }
      finalContent.set(id, { id, ...lc })
      continue
    }

    if (localWrote) finalContent.set(id, { id, ...L.content })
    else if (remoteWrote) finalContent.set(id, { id, ...R.content })
    else if (cloudState.has(id)) finalContent.set(id, { ...cloudState.get(id) })
    else if (aNode) finalContent.set(id, { ...aNode })
  }

  // Determine ordering. Prefer the cloud's CURRENT node order (which already
  // contains earlier folded merges); otherwise replay remote ops on the
  // ancestor. Then splice in local-only inserts near their anchors. Shared
  // inserts (same opId) appear once.
  const remoteNodes = cloudNodes ? cloudNodes : applyOps(base, remoteOps)
  const remoteOrderIds = new Set(remoteNodes.map((n) => n.id))

  const ordered = remoteNodes
    .filter((n) => !conflictNodes.has(n.id) && finalContent.has(n.id))
    .map((n) => finalContent.get(n.id) || n)

  const localOnlyInserts = local.inserts.filter(
    (op) =>
      !remote.inserts.some((rop) => rop.opId === op.opId) &&
      !conflictNodes.has(op.nodeId),
  )

  // Insert local-only nodes preserving local relative order near anchors.
  const localApplied = applyOps(base, localOps)
  const localPos = new Map(localApplied.map((n, idx) => [n.id, idx]))
  const present = new Set(ordered.map((n) => n.id))
  for (const node of localApplied) {
    if (present.has(node.id) || conflictNodes.has(node.id)) continue
    const fc = finalContent.get(node.id)
    if (!fc) continue
    // find nearest preceding neighbour that is already ordered
    let insertAt = ordered.length
    for (let idx = localPos.get(node.id) - 1; idx >= 0; idx -= 1) {
      const anchorId = localApplied[idx].id
      const at = ordered.findIndex((n) => n.id === anchorId)
      if (at !== -1) {
        insertAt = at + 1
        break
      }
    }
    ordered.splice(insertAt, 0, fc)
    present.add(node.id)
  }

  // mergedOps: union of ops by opId (shared ids once). This represents the
  // reconciled branch; after a conflict-free rebase the client can drop its
  // superseded ops because the server already owns them.
  const seen = new Set()
  const mergedOps = []
  for (const op of [...remoteOps, ...localOps]) {
    if (!seen.has(op.opId)) {
      seen.add(op.opId)
      mergedOps.push(op)
    }
  }

  return {
    nodes: ordered,
    conflicts,
    mergedOps,
    autoMerged: conflicts.length === 0,
  }
}

/**
 * Resolve one conflict with a human decision and produce node list + ops.
 * decision:
 *   { resolution: 'local' | 'remote' | 'custom', content? }
 * Returns { node: node|null } — null means the node stays deleted.
 */
export function resolveConflict(conflict, decision) {
  if (decision.resolution === 'local') {
    return { node: conflict.local.node }
  }
  if (decision.resolution === 'remote') {
    return { node: conflict.remote.node }
  }
  if (decision.resolution === 'custom' && decision.content) {
    return {
      node: { id: conflict.nodeId, kind: decision.content.kind, text: decision.content.text },
    }
  }
  throw new Error(`invalid resolution: ${decision.resolution}`)
}

/** Apply conflict resolutions to a merge result, returning final nodes. */
export function applyResolutions(mergeResult, decisions) {
  let nodes = mergeResult.nodes.map((n) => ({ ...n }))
  for (const conflict of mergeResult.conflicts) {
    const decision = decisions.get(conflict.id)
    if (!decision) continue
    const { node } = resolveConflict(conflict, decision)
    if (node) {
      // Place relative to best-known anchor: after the ancestor's successor.
      const existsAt = nodes.findIndex((n) => n.id === node.id)
      if (existsAt === -1) nodes.push(node)
      else nodes[existsAt] = node
    }
  }
  return nodes
}

export const ConflictKind = CONFLICT
