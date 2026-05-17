/**
 * 会话查询模块（平台无关）
 *
 * 纯 SQL 查询函数，接收 DatabaseAdapter 参数，不依赖全局状态。
 * 这些函数是 CLI/MCP/HTTP API 查询会话数据的基础。
 */

import type { TimeFilter } from '@openchatlab/shared-types'
import type { DatabaseAdapter } from '../interfaces'
import { hasTable } from './filters'
import { getMemberActivity } from './basic-queries'

export interface SessionMeta {
  name: string
  platform: string
  type: string
  importedAt: number
  groupId: string | null
  groupAvatar: string | null
  ownerId: string | null
}

export interface SessionOverview {
  totalMessages: number
  totalMembers: number
  firstMessageTs: number | null
  lastMessageTs: number | null
}

export interface SessionInfo extends SessionMeta {
  id: string
  overview: SessionOverview
}

// ==================== Flat session info (for AnalysisSession-like consumers) ====================

/**
 * Platform-agnostic session info built from meta + overview.
 * Covers all AnalysisSession fields that are queryable from a single DB.
 * Platform-specific fields (dbPath, memberAvatar, aiConversationCount) are left to callers.
 */
export interface CoreSessionInfo {
  name: string
  platform: string
  type: string
  importedAt: number
  messageCount: number
  memberCount: number
  groupId: string | null
  groupAvatar: string | null
  ownerId: string | null
  firstMessageTs: number | null
  lastMessageTs: number | null
  summaryCount: number
}

/**
 * Pure mapper: compose SessionMeta + SessionOverview into flat CoreSessionInfo.
 * Callers provide the inputs which may come from cache or fresh SQL.
 */
export function buildSessionInfo(
  meta: SessionMeta,
  overview: SessionOverview,
  summaryCount: number = 0
): CoreSessionInfo {
  return {
    name: meta.name,
    platform: meta.platform,
    type: meta.type,
    importedAt: meta.importedAt,
    messageCount: overview.totalMessages,
    memberCount: overview.totalMembers,
    groupId: meta.groupId,
    groupAvatar: meta.groupAvatar,
    ownerId: meta.ownerId,
    firstMessageTs: overview.firstMessageTs,
    lastMessageTs: overview.lastMessageTs,
    summaryCount,
  }
}

/**
 * Convenience: read meta + overview from DB and return flat CoreSessionInfo.
 */
export function getSessionInfo(db: DatabaseAdapter): CoreSessionInfo | null {
  const meta = getSessionMeta(db)
  if (!meta) return null
  const overview = getSessionOverview(db)
  const sc = getSummaryCount(db)
  return buildSessionInfo(meta, overview, sc)
}

/**
 * Count of chat sessions that have an AI-generated summary.
 */
export function getSummaryCount(db: DatabaseAdapter): number {
  if (!hasTable(db, 'chat_session')) return 0
  const row = db
    .prepare("SELECT COUNT(*) as count FROM chat_session WHERE summary IS NOT NULL AND summary != ''")
    .get() as { count: number } | undefined
  return row?.count ?? 0
}

/**
 * Get the latest platform_message_id (used as incremental import boundary).
 */
export function getLastPlatformMessageId(db: DatabaseAdapter): string | null {
  const row = db
    .prepare('SELECT platform_message_id FROM message WHERE platform_message_id IS NOT NULL ORDER BY ts DESC LIMIT 1')
    .get() as { platform_message_id: string } | undefined
  return row?.platform_message_id ?? null
}

// ==================== Core identification ====================

/**
 * 判断数据库是否为聊天会话数据库
 * 通过核心三表（meta/member/message）存在性快速识别
 */
export function isChatSessionDb(db: DatabaseAdapter): boolean {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name IN ('meta', 'member', 'message')")
    .get() as { cnt: number } | undefined
  return row?.cnt === 3
}

/**
 * 读取会话元信息
 */
export function getSessionMeta(db: DatabaseAdapter): SessionMeta | null {
  const row = db.prepare('SELECT * FROM meta LIMIT 1').get() as Record<string, unknown> | undefined
  if (!row) return null

  return {
    name: row.name as string,
    platform: row.platform as string,
    type: row.type as string,
    importedAt: row.imported_at as number,
    groupId: (row.group_id as string) || null,
    groupAvatar: (row.group_avatar as string) || null,
    ownerId: (row.owner_id as string) || null,
  }
}

/**
 * 查询会话基础统计（消息数、成员数、时间范围）
 */
export function getSessionOverview(db: DatabaseAdapter): SessionOverview {
  const msgRow = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM message msg
       JOIN member m ON msg.sender_id = m.id
       WHERE COALESCE(m.account_name, '') != '系统消息'`
    )
    .get() as { count: number }

  const memberRow = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM member
       WHERE COALESCE(account_name, '') != '系统消息'`
    )
    .get() as { count: number }

  const firstTs = (db.prepare('SELECT MIN(ts) as v FROM message').get() as { v: number | null })?.v ?? null
  const lastTs = (db.prepare('SELECT MAX(ts) as v FROM message').get() as { v: number | null })?.v ?? null

  return {
    totalMessages: msgRow.count,
    totalMembers: memberRow.count,
    firstMessageTs: firstTs,
    lastMessageTs: lastTs,
  }
}

/**
 * 获取数据库中的表结构（Schema）
 */
export function getDatabaseSchema(db: DatabaseAdapter): Array<{ name: string; sql: string }> {
  return db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string; sql: string }>
}

// ==================== Chat Overview & Session Queries ====================

export interface ChatOverviewData {
  name: string
  platform: string
  type: string
  totalMessages: number
  totalMembers: number
  firstMessageTs: number | null
  lastMessageTs: number | null
  topMembers: Array<{ id: number; name: string; count: number }>
}

export interface SessionPreviewMessage {
  id: number
  senderId: number
  senderName: string
  senderPlatformId: string
  content: string | null
  timestamp: number
}

export interface SessionSearchItem {
  id: number
  startTs: number
  endTs: number
  messageCount: number
  isComplete: boolean
  previewMessages: SessionPreviewMessage[]
}

export interface SessionMessagesData {
  sessionId: number
  startTs: number
  endTs: number
  messageCount: number
  returnedCount: number
  participants: string[]
  messages: SessionPreviewMessage[]
}

export interface SearchSessionsOptions {
  keywords?: string[]
  timeFilter?: TimeFilter
  limit?: number
  previewCount?: number
  /** Pre-tokenized FTS match expression. When provided, uses FTS index for keyword filtering. */
  ftsMatchExpression?: string
}

export interface SessionSummaryData {
  id: number
  startTs: number
  endTs: number
  messageCount: number
  participants: string[]
  summary: string | null
}

/**
 * Get chat overview by composing meta, overview stats, and top members.
 * Simpler than Electron version — no cache layer, direct SQL.
 */
export function getChatOverview(db: DatabaseAdapter, topN: number = 10): ChatOverviewData | null {
  const meta = getSessionMeta(db)
  if (!meta) return null

  const overview = getSessionOverview(db)
  const members = getMemberActivity(db)

  const topMembers = members.slice(0, topN).map((m) => ({
    id: m.memberId,
    name: m.name,
    count: m.messageCount,
  }))

  return {
    name: meta.name,
    platform: meta.platform,
    type: meta.type,
    totalMessages: overview.totalMessages,
    totalMembers: overview.totalMembers,
    firstMessageTs: overview.firstMessageTs,
    lastMessageTs: overview.lastMessageTs,
    topMembers,
  }
}

/**
 * Search chat sessions with optional keyword and time filters.
 * Requires chat_session and message_context tables (session indexing).
 * Supports LIKE-based search and optional FTS when ftsMatchExpression is provided.
 */
export function searchSessions(
  db: DatabaseAdapter,
  keywords?: string[],
  timeFilter?: TimeFilter,
  limit: number = 20,
  previewCount: number = 5,
  ftsMatchExpression?: string
): SessionSearchItem[] {
  if (!hasTable(db, 'chat_session')) return []

  let sessionSql = `
    SELECT cs.id, cs.start_ts as startTs, cs.end_ts as endTs, cs.message_count as messageCount
    FROM chat_session cs WHERE 1=1
  `
  const params: unknown[] = []

  if (timeFilter?.startTs !== undefined) {
    sessionSql += ' AND cs.start_ts >= ?'
    params.push(timeFilter.startTs)
  }
  if (timeFilter?.endTs !== undefined) {
    sessionSql += ' AND cs.end_ts <= ?'
    params.push(timeFilter.endTs)
  }

  if (keywords && keywords.length > 0) {
    if (ftsMatchExpression) {
      sessionSql += `
        AND cs.id IN (
          SELECT DISTINCT mc.session_id FROM message_context mc
          WHERE mc.message_id IN (SELECT rowid FROM message_fts WHERE content MATCH ?)
        )
      `
      params.push(ftsMatchExpression)
    } else {
      const keywordConditions = keywords.map(() => 'm.content LIKE ?').join(' OR ')
      sessionSql += `
        AND cs.id IN (
          SELECT DISTINCT mc.session_id FROM message_context mc
          JOIN message m ON m.id = mc.message_id
          WHERE (${keywordConditions})
        )
      `
      for (const kw of keywords) {
        params.push(`%${kw}%`)
      }
    }
  }

  sessionSql += ' ORDER BY cs.start_ts DESC LIMIT ?'
  params.push(limit)

  const sessions = db.prepare(sessionSql).all(...params) as Array<{
    id: number
    startTs: number
    endTs: number
    messageCount: number
  }>

  const previewSql = `
    SELECT m.id, mb.id as senderId,
           COALESCE(mb.group_nickname, mb.account_name, mb.platform_id) as senderName,
           mb.platform_id as senderPlatformId,
           m.content, m.ts as timestamp
    FROM message_context mc
    JOIN message m ON m.id = mc.message_id
    JOIN member mb ON mb.id = m.sender_id
    WHERE mc.session_id = ? ORDER BY m.ts ASC LIMIT ?
  `

  return sessions.map((session) => {
    const previewMessages = db.prepare(previewSql).all(session.id, previewCount) as unknown as SessionPreviewMessage[]

    return {
      id: session.id,
      startTs: session.startTs,
      endTs: session.endTs,
      messageCount: session.messageCount,
      isComplete: session.messageCount <= previewCount,
      previewMessages,
    }
  })
}

/**
 * Get messages for a specific chat session
 */
export function getSessionMessages(
  db: DatabaseAdapter,
  chatSessionId: number,
  limit: number = 500
): SessionMessagesData | null {
  if (!hasTable(db, 'chat_session')) return null

  const session = db
    .prepare(
      `SELECT id, start_ts as startTs, end_ts as endTs, message_count as messageCount
       FROM chat_session WHERE id = ?`
    )
    .get(chatSessionId) as { id: number; startTs: number; endTs: number; messageCount: number } | undefined

  if (!session) return null

  const messages = db
    .prepare(
      `SELECT m.id, mb.id as senderId,
              COALESCE(mb.group_nickname, mb.account_name, mb.platform_id) as senderName,
              mb.platform_id as senderPlatformId,
              m.content, m.ts as timestamp
       FROM message_context mc
       JOIN message m ON m.id = mc.message_id
       JOIN member mb ON mb.id = m.sender_id
       WHERE mc.session_id = ? ORDER BY m.ts ASC LIMIT ?`
    )
    .all(chatSessionId, limit) as unknown as SessionPreviewMessage[]

  const participantsSet = new Set<string>()
  for (const msg of messages) {
    participantsSet.add(msg.senderName)
  }

  return {
    sessionId: session.id,
    startTs: session.startTs,
    endTs: session.endTs,
    messageCount: session.messageCount,
    returnedCount: messages.length,
    participants: Array.from(participantsSet),
    messages,
  }
}

/**
 * Get session summaries (only sessions that have AI-generated summaries)
 */
export function getSessionSummaries(
  db: DatabaseAdapter,
  options?: { limit?: number; timeFilter?: TimeFilter }
): SessionSummaryData[] {
  if (!hasTable(db, 'chat_session')) return []

  const { limit = 50, timeFilter } = options ?? {}

  let sql = `
    SELECT cs.id, cs.start_ts as startTs, cs.end_ts as endTs,
           cs.message_count as messageCount, cs.summary
    FROM chat_session cs
    WHERE cs.summary IS NOT NULL AND cs.summary != ''
  `
  const params: unknown[] = []

  if (timeFilter?.startTs !== undefined) {
    sql += ' AND cs.start_ts >= ?'
    params.push(timeFilter.startTs)
  }
  if (timeFilter?.endTs !== undefined) {
    sql += ' AND cs.start_ts <= ?'
    params.push(timeFilter.endTs)
  }

  sql += ' ORDER BY cs.start_ts DESC LIMIT ?'
  params.push(limit)

  const sessions = db.prepare(sql).all(...params) as Array<{
    id: number
    startTs: number
    endTs: number
    messageCount: number
    summary: string | null
  }>

  const participantsSql = `
    SELECT DISTINCT COALESCE(mb.group_nickname, mb.account_name, mb.platform_id) as name
    FROM message_context mc
    JOIN message m ON m.id = mc.message_id
    JOIN member mb ON mb.id = m.sender_id
    WHERE mc.session_id = ? LIMIT 10
  `

  return sessions.map((session) => {
    const participants = db.prepare(participantsSql).all(session.id) as Array<{ name: string }>

    return {
      id: session.id,
      startTs: session.startTs,
      endTs: session.endTs,
      messageCount: session.messageCount,
      participants: participants.map((p) => p.name),
      summary: session.summary,
    }
  })
}

// ==================== Session Index (chat_session) ====================

/** Default gap threshold for session segmentation: 30 minutes (seconds) */
export const DEFAULT_SESSION_GAP_THRESHOLD = 1800

export interface ChatSessionItem {
  id: number
  startTs: number
  endTs: number
  messageCount: number
  firstMessageId: number
  summary?: string | null
}

export interface SessionIndexStats {
  sessionCount: number
  hasIndex: boolean
  gapThreshold: number
}

/**
 * Check whether the chat_session table exists and has at least one row.
 */
export function hasSessionIndex(db: DatabaseAdapter): boolean {
  if (!hasTable(db, 'chat_session')) return false
  try {
    const row = db.prepare('SELECT COUNT(*) as count FROM chat_session').get() as { count: number } | undefined
    return (row?.count ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * Session index statistics: count, existence flag, and gap threshold from meta.
 */
export function getSessionIndexStats(db: DatabaseAdapter): SessionIndexStats {
  let sessionCount = 0
  if (hasTable(db, 'chat_session')) {
    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM chat_session').get() as { count: number } | undefined
      sessionCount = row?.count ?? 0
    } catch {
      /* table may not exist */
    }
  }

  let gapThreshold = DEFAULT_SESSION_GAP_THRESHOLD
  try {
    const meta = db.prepare('SELECT session_gap_threshold FROM meta LIMIT 1').get() as
      | { session_gap_threshold: number | null }
      | undefined
    if (meta?.session_gap_threshold) {
      gapThreshold = meta.session_gap_threshold
    }
  } catch {
    /* column may not exist */
  }

  return { sessionCount, hasIndex: sessionCount > 0, gapThreshold }
}

/**
 * Timeline list of chat sessions with first message id and summary.
 */
export function getChatSessionList(db: DatabaseAdapter): ChatSessionItem[] {
  if (!hasTable(db, 'chat_session')) return []
  try {
    return db
      .prepare(
        `SELECT
          cs.id,
          cs.start_ts as startTs,
          cs.end_ts as endTs,
          cs.message_count as messageCount,
          cs.summary,
          (SELECT mc.message_id FROM message_context mc
           WHERE mc.session_id = cs.id ORDER BY mc.message_id LIMIT 1) as firstMessageId
        FROM chat_session cs
        ORDER BY cs.start_ts ASC`
      )
      .all() as unknown as ChatSessionItem[]
  } catch {
    return []
  }
}

/**
 * Get summary text for a single chat session.
 */
export function getChatSessionSummary(db: DatabaseAdapter, chatSessionId: number): string | null {
  try {
    const row = db.prepare('SELECT summary FROM chat_session WHERE id = ?').get(chatSessionId) as
      | { summary: string | null }
      | undefined
    return row?.summary ?? null
  } catch {
    return null
  }
}

/**
 * Save summary text for a chat session.
 */
export function saveChatSessionSummary(db: DatabaseAdapter, chatSessionId: number, summary: string): void {
  db.prepare('UPDATE chat_session SET summary = ? WHERE id = ?').run(summary, chatSessionId)
}

/**
 * Update gap threshold in meta table.
 */
export function updateSessionGapThreshold(db: DatabaseAdapter, gapThreshold: number | null): void {
  db.prepare('UPDATE meta SET session_gap_threshold = ?').run(gapThreshold)
}

/**
 * Delete all session index data (chat_session + message_context).
 */
export function clearSessionIndex(db: DatabaseAdapter): void {
  db.exec('DELETE FROM message_context')
  db.exec('DELETE FROM chat_session')
}

/**
 * Generate session index using gap-based segmentation.
 * Pure SQL+JS algorithm — caller provides an open DatabaseAdapter.
 *
 * @returns number of sessions created
 */
export function generateSessionIndex(
  db: DatabaseAdapter,
  gapThreshold: number = DEFAULT_SESSION_GAP_THRESHOLD,
  onProgress?: (current: number, total: number) => void
): number {
  const countRow = db.prepare('SELECT COUNT(*) as count FROM message').get() as { count: number } | undefined
  if (!countRow || countRow.count === 0) return 0

  clearSessionIndex(db)

  const sessionMarkSQL = `
    WITH message_ordered AS (
      SELECT id, ts, LAG(ts) OVER (ORDER BY ts, id) AS prev_ts FROM message
    ),
    session_marks AS (
      SELECT id, ts,
        CASE WHEN prev_ts IS NULL OR (ts - prev_ts) > ? THEN 1 ELSE 0 END AS is_new_session
      FROM message_ordered
    ),
    session_ids AS (
      SELECT id, ts, SUM(is_new_session) OVER (ORDER BY ts, id) AS session_num
      FROM session_marks
    )
    SELECT id, ts, session_num FROM session_ids
  `

  const messages = db.prepare(sessionMarkSQL).all(gapThreshold) as Array<{
    id: number
    ts: number
    session_num: number
  }>

  if (messages.length === 0) return 0

  const sessionMap = new Map<number, { startTs: number; endTs: number; messageIds: number[] }>()
  for (const msg of messages) {
    const session = sessionMap.get(msg.session_num)
    if (!session) {
      sessionMap.set(msg.session_num, { startTs: msg.ts, endTs: msg.ts, messageIds: [msg.id] })
    } else {
      session.endTs = msg.ts
      session.messageIds.push(msg.id)
    }
  }

  const insertSession = db.prepare(
    'INSERT INTO chat_session (start_ts, end_ts, message_count, is_manual, summary) VALUES (?, ?, ?, 0, NULL)'
  )
  const insertContext = db.prepare('INSERT INTO message_context (message_id, session_id, topic_id) VALUES (?, ?, NULL)')

  return db.transaction(() => {
    let processed = 0
    const total = sessionMap.size
    for (const [, data] of sessionMap) {
      const result = insertSession.run(data.startTs, data.endTs, data.messageIds.length)
      const newId = (result.lastInsertRowid ?? 0) as number
      for (const mid of data.messageIds) {
        insertContext.run(mid, newId)
      }
      processed++
      if (onProgress && processed % 100 === 0) onProgress(processed, total)
    }
    if (onProgress) onProgress(total, total)
    return total
  })
}

/**
 * Incremental session index generation — only processes unindexed messages.
 * Preserves existing sessions and their summaries.
 *
 * @returns number of NEW sessions created (appended messages don't count)
 */
export function generateIncrementalSessionIndex(
  db: DatabaseAdapter,
  gapThreshold: number = DEFAULT_SESSION_GAP_THRESHOLD
): number {
  const indexedIds = new Set<number>()
  if (hasTable(db, 'message_context')) {
    const rows = db.prepare('SELECT message_id FROM message_context').all() as Array<{ message_id: number }>
    for (const r of rows) indexedIds.add(r.message_id)
  }

  const allMessages = db.prepare('SELECT id, ts FROM message ORDER BY ts, id').all() as Array<{
    id: number
    ts: number
  }>
  const newMessages = allMessages.filter((m) => !indexedIds.has(m.id))
  if (newMessages.length === 0) return 0

  const lastSession = hasTable(db, 'chat_session')
    ? (db.prepare('SELECT id, end_ts FROM chat_session ORDER BY end_ts DESC LIMIT 1').get() as
        | { id: number; end_ts: number }
        | undefined)
    : undefined

  newMessages.sort((a, b) => a.ts - b.ts || a.id - b.id)

  const insertSession = db.prepare(
    'INSERT INTO chat_session (start_ts, end_ts, message_count, is_manual, summary) VALUES (?, ?, ?, 0, NULL)'
  )
  const insertContext = db.prepare('INSERT INTO message_context (message_id, session_id, topic_id) VALUES (?, ?, NULL)')
  const updateSession = db.prepare('UPDATE chat_session SET end_ts = ?, message_count = message_count + ? WHERE id = ?')

  return db.transaction(() => {
    let newSessionCount = 0
    let currentSessionId: number | null = null
    let currentEndTs = 0
    let appendCount = 0

    for (let i = 0; i < newMessages.length; i++) {
      const msg = newMessages[i]
      let needNew = false

      if (i === 0) {
        if (lastSession && msg.ts - lastSession.end_ts <= gapThreshold) {
          currentSessionId = lastSession.id
          currentEndTs = lastSession.end_ts
          appendCount = 0
        } else {
          needNew = true
        }
      } else {
        if (msg.ts - newMessages[i - 1].ts > gapThreshold) {
          if (currentSessionId && appendCount > 0) {
            updateSession.run(currentEndTs, appendCount, currentSessionId)
            appendCount = 0
          }
          needNew = true
        }
      }

      if (needNew) {
        const result = insertSession.run(msg.ts, msg.ts, 1)
        currentSessionId = (result.lastInsertRowid ?? 0) as number
        currentEndTs = msg.ts
        newSessionCount++
        appendCount = 0
      } else {
        currentEndTs = msg.ts
        appendCount++
      }

      insertContext.run(msg.id, currentSessionId)
    }

    if (currentSessionId && appendCount > 0) {
      updateSession.run(currentEndTs, appendCount, currentSessionId)
    }

    return newSessionCount
  })
}
